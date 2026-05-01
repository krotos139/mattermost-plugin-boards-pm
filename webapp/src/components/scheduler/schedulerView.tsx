// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Scheduler view — Google Calendar–style time/date grid built on top of the
// Schedule-X v3 calendar (https://schedule-x.dev). Cards on the board are
// projected onto the grid using the user-picked Date property; an optional
// Select / multiSelect property drives per-event color via Schedule-X's
// "calendars" mechanism (each option becomes one calendar entry whose
// color is reused for events that have that option's id in their value).
//
// Drag to move and edge-drag to resize both rewrite the card's date range
// in place via mutator.changePropertyValue, mirroring the existing Calendar
// view's behavior. Clicks open the card details modal.
//
// Why pin Schedule-X to ~3.7.x: their v4 moved drag-and-drop and resize
// behind a paid `@sx-premium` namespace. The 3.7.x stack (calendar, react,
// drag-and-drop, resize, theme-default, events-service) is the last fully
// MIT-licensed combination. See feedback memory `feedback_schedulex_license`.
//
// Event cards render via Schedule-X's custom-component slots (timeGridEvent,
// dateGridEvent, monthGridEvent, monthAgendaEvent). The same React node is
// reused for all four so the per-event UI — title, badges, configured
// visible properties — looks identical regardless of which view is active.

// Polyfill globalThis.Temporal — Schedule-X 3.7.x is built against the
// Temporal proposal and reads `Temporal.Now.zonedDateTimeISO(tz)` etc. at
// runtime. Importing the polyfill's `/global` subpath patches the singleton
// once for the whole bundle.
import 'temporal-polyfill/global'

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import {ScheduleXCalendar, useCalendarApp} from '@schedule-x/react'
import {
    CalendarEvent,
    CalendarType,
    createViewDay,
    createViewList,
    createViewMonthAgenda,
    createViewMonthGrid,
    createViewWeek,
} from '@schedule-x/calendar'
import {createDragAndDropPlugin} from '@schedule-x/drag-and-drop'
import {createEventsServicePlugin} from '@schedule-x/events-service'
import {createResizePlugin} from '@schedule-x/resize'

import '@schedule-x/theme-default/dist/index.css'

import {Board, IPropertyTemplate} from '../../blocks/board'
import {BoardView} from '../../blocks/boardView'
import {Card} from '../../blocks/card'
import {Constants} from '../../constants'
import {DateProperty, createDatePropertyFromString} from '../../properties/date/date'
import {DatePropertyType} from '../../properties/types'
import propsRegistry from '../../properties'
import mutator from '../../mutator'
import CardBadges from '../cardBadges'
import Tooltip from '../../widgets/tooltip'
import {Utils} from '../../utils'
import {IUser} from '../../user'
import {useAppSelector} from '../../store/hooks'
import {getBoardUsers} from '../../store/users'
import {getClientConfig} from '../../store/clientConfig'

import YearView, {YearEvent} from './yearView'

import './schedulerView.scss'

// Pre-resolved hex matching focalboard-variables.scss `--prop-{name}`. The
// Schedule-X event renderer doesn't resolve `var(--…)` inside its computed
// styles, so we hand it concrete colors. Synced with hierarchyView.tsx and
// ganttView CSS — keep in sync if the focalboard palette shifts.
const COLOR_HEX_BY_NAME: Record<string, string> = {
    propColorDefault: '#ededed',
    propColorGray: '#ededed',
    propColorBrown: '#f7ddc3',
    propColorOrange: '#ffd3c1',
    propColorYellow: '#fff7ad',
    propColorGreen: '#caf2c4',
    propColorBlue: '#cce4ff',
    propColorPurple: '#fad0ff',
    propColorPink: '#fadcde',
    propColorRed: '#ffacc1',
}

// Saturated counterparts used as the `main` color in Schedule-X's
// ColorDefinition (border/time-axis stripe). Keeps the per-option color
// recognisable next to the lighter container fill.
const COLOR_HEX_MAIN_BY_NAME: Record<string, string> = {
    propColorDefault: '#a0a0a0',
    propColorGray: '#9c9c9c',
    propColorBrown: '#a87b5a',
    propColorOrange: '#e0772b',
    propColorYellow: '#cea600',
    propColorGreen: '#2c8c2c',
    propColorBlue: '#1f74d6',
    propColorPurple: '#a83cc4',
    propColorPink: '#d6498b',
    propColorRed: '#d63b51',
}

// Synthetic key used for cards that have no value on the chosen color
// property — handles single-select empties and the catch-all when no
// color property is configured.
const NO_VALUE_KEY = '__none'

type Props = {
    board: Board
    cards: Card[]
    activeView: BoardView
    readonly: boolean
    dateDisplayProperty?: IPropertyTemplate
    showCard: (cardId: string) => void
}

// Convert a JS Date (which Boards' DateProperty.getDateFrom hands back at
// midnight local time) to a Temporal.PlainDate. PlainDate keeps the event in
// the all-day strip of the week/day grid — Boards date properties have no
// time-of-day component when `includeTime` is off, so anchoring at noon
// would falsely promote them into the time-grid.
const dateToPlainDate = (d: Date): Temporal.PlainDate =>
    Temporal.PlainDate.from({year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()})

// Convert an epoch-ms value (the actual UTC instant when DateProperty has
// `includeTime: true`) into a ZonedDateTime in the user's IANA zone. This
// puts the event into the time-grid at the correct wall-clock time.
const epochMsToZoned = (ms: number, tz: string): Temporal.ZonedDateTime =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz)

// Convert back to the `from`/`to` epoch-ms shape Boards stores in
// DateProperty when `includeTime` is *off*. setHours(12) mirrors the
// convention in calendar/date.tsx — using noon avoids the off-by-one that
// DST transitions cause when the midnight value falls on the "wrong" side
// of the spring-forward jump. Note we then strip the local TZ offset back
// out to match how DateProperty stores no-time values (UTC-anchored
// midnight, see saveRangeValue in webapp/src/properties/date/date.tsx).
const plainDateToBoardsDateMs = (pd: Temporal.PlainDate): number => {
    const d = new Date(pd.year, pd.month - 1, pd.day, 12, 0, 0, 0)
    return d.getTime() - (d.getTimezoneOffset() * 60_000)
}

const isPlainDate = (d: unknown): d is Temporal.PlainDate => {
    return typeof d === 'object' && d !== null && (d as {calendarId?: unknown}).calendarId !== undefined && (d as {hour?: unknown}).hour === undefined
}

const toPlainDate = (d: Temporal.PlainDate | Temporal.ZonedDateTime): Temporal.PlainDate => {
    if (isPlainDate(d)) {
        return d
    }
    return (d as Temporal.ZonedDateTime).toPlainDate()
}

// Local IANA timezone, resolved once. Used to convert between `includeTime`
// epoch-ms and Schedule-X ZonedDateTime instances. Browsers always answer
// here (it's a runtime-resolved Intl property) so we don't need a fallback,
// but if the polyfill ever returns something unexpected this falls back to
// 'UTC' so the calendar still renders.
const LOCAL_TZ: string = (() => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
        return 'UTC'
    }
})()

type SchedulerMode = 'calendar' | 'year'

const SchedulerView = (props: Props): JSX.Element => {
    const {board, cards, activeView, readonly, dateDisplayProperty, showCard} = props
    const intl = useIntl()

    // Mode + initial-day state lives at this level so flipping between
    // Calendar and Year doesn't dump Year's cursor (the user often wants
    // to navigate years, jump to a month, then come back to year view to
    // navigate further). `initialSelectedDate` flows back into Schedule-X
    // when the user clicks a Year-mode day to jump into Calendar mode.
    const [mode, setMode] = useState<SchedulerMode>('calendar')
    const [yearCursor, setYearCursor] = useState<number>(() => new Date().getFullYear())
    const [initialSelectedDate, setInitialSelectedDate] = useState<Date | undefined>(undefined)

    // No date property selected: show the same "pick a property" affordance
    // the rest of the view ecosystem uses — Calendar/Gantt give back nothing
    // meaningful in this state either.
    if (!dateDisplayProperty) {
        return (
            <div className='SchedulerContainer SchedulerContainer__empty'>
                <FormattedMessage
                    id='Scheduler.pick-date'
                    defaultMessage='Pick a date property in the "Display by" menu to see events on the scheduler.'
                />
            </div>
        )
    }

    // Remount the inner calendar whenever the schema-shaping config changes.
    // Schedule-X locks its config at construction time (the React hook only
    // runs createCalendar once with an empty deps array), so swapping the
    // date or color property requires a fresh CalendarApp. visiblePropertyIds
    // joins the key too because changing visible properties has to re-bind
    // our custom event renderer (it captures the `visiblePropertyTemplates`
    // list in its closure) — without a remount, schedule-x keeps the
    // already-mounted DOM nodes around with the old renderer's output, and
    // the user wouldn't see newly-checked properties show up on events.
    // initialSelectedDate also forces a fresh mount when Year-view picks a
    // jump-to-day — Schedule-X's `selectedDate` config is one-shot at
    // construction, so we have to recreate the app to honor it.
    const colorPropertyId = activeView.fields.colorPropertyId
    const visibleKey = (activeView.fields.visiblePropertyIds || []).join(',')
    const initialDateKey = initialSelectedDate ? initialSelectedDate.toISOString().slice(0, 10) : ''
    const innerKey = `${dateDisplayProperty.id}|${colorPropertyId || ''}|${visibleKey}|${initialDateKey}`

    const handleYearDayClick = (date: Date) => {
        setInitialSelectedDate(date)
        setMode('calendar')
    }

    const modeSwitcher = (
        <div className='SchedulerModeSwitcher'>
            <button
                type='button'
                className={'SchedulerModeSwitcher__btn' + (mode === 'calendar' ? ' active' : '')}
                onClick={() => setMode('calendar')}
            >
                <FormattedMessage
                    id='Scheduler.mode-calendar'
                    defaultMessage='Calendar'
                />
            </button>
            <button
                type='button'
                className={'SchedulerModeSwitcher__btn' + (mode === 'year' ? ' active' : '')}
                onClick={() => setMode('year')}
            >
                <FormattedMessage
                    id='Scheduler.mode-year'
                    defaultMessage='Year'
                />
            </button>
        </div>
    )

    if (mode === 'year') {
        return (
            <div className='SchedulerContainer SchedulerContainer--year'>
                {modeSwitcher}
                <SchedulerYearWrapper
                    board={board}
                    cards={cards}
                    activeView={activeView}
                    dateDisplayProperty={dateDisplayProperty}
                    year={yearCursor}
                    onYearChange={setYearCursor}
                    onDayClick={handleYearDayClick}
                />
            </div>
        )
    }

    return (
        <div className='SchedulerContainer'>
            {modeSwitcher}
            <SchedulerInner
                key={innerKey}
                board={board}
                cards={cards}
                activeView={activeView}
                readonly={readonly}
                dateDisplayProperty={dateDisplayProperty}
                showCard={showCard}
                initialSelectedDate={initialSelectedDate}
            />
        </div>
    )
}

// Year-mode adapter: projects cards into the lighter YearEvent shape that
// YearView consumes (it only needs start/end dates and a tint color), and
// resolves the same colorProperty → option-color mapping that the
// schedule-x mode uses so the year-view dots match the calendar bars.
type SchedulerYearWrapperProps = {
    board: Board
    cards: Card[]
    activeView: BoardView
    dateDisplayProperty: IPropertyTemplate
    year: number
    onYearChange: (y: number) => void
    onDayClick: (d: Date) => void
}

const SchedulerYearWrapper = (props: SchedulerYearWrapperProps): JSX.Element => {
    const {board, cards, activeView, dateDisplayProperty, year, onYearChange, onDayClick} = props

    const colorProperty = useMemo(() => {
        const id = activeView.fields.colorPropertyId
        if (!id) {
            return undefined
        }
        const tpl = board.cardProperties.find((p) => p.id === id)
        if (!tpl || tpl.type !== 'select') {
            return undefined
        }
        return tpl
    }, [board.cardProperties, activeView.fields.colorPropertyId])

    const events: YearEvent[] = useMemo(() => {
        const propType = propsRegistry.get(dateDisplayProperty.type)
        if (!(propType instanceof DatePropertyType)) {
            return []
        }
        return cards.flatMap((card): YearEvent[] => {
            const value = card.fields.properties[dateDisplayProperty.id]
            const dateFrom = propType.getDateFrom(value as string, card)
            if (!dateFrom) {
                return []
            }
            const dateTo = propType.getDateTo(value as string, card) || new Date(dateFrom)

            // Resolve color from the option chosen on the card. The hex
            // map mirrors COLOR_HEX_MAIN_BY_NAME above so dots in Year
            // mode visually match bars in Calendar mode.
            let colorMain: string | undefined
            if (colorProperty?.options?.length) {
                const colorVal = card.fields.properties[colorProperty.id]
                let optId: string | undefined
                if (Array.isArray(colorVal) && colorVal.length > 0 && typeof colorVal[0] === 'string') {
                    optId = colorVal[0]
                } else if (typeof colorVal === 'string' && colorVal.length > 0) {
                    optId = colorVal
                }
                if (optId) {
                    const opt = colorProperty.options.find((o) => o.id === optId)
                    if (opt) {
                        const colorName = opt.color || 'propColorDefault'
                        colorMain = COLOR_HEX_MAIN_BY_NAME[colorName] || COLOR_HEX_MAIN_BY_NAME.propColorDefault
                    }
                }
            }

            return [{
                cardId: card.id,
                start: dateFrom,
                end: dateTo,
                colorMain,
            }]
        })
    }, [cards, dateDisplayProperty, colorProperty])

    return (
        <YearView
            year={year}
            events={events}
            onYearChange={onYearChange}
            onDayClick={onDayClick}
        />
    )
}

type InnerProps = Props & {
    dateDisplayProperty: IPropertyTemplate
    initialSelectedDate?: Date
}

const SchedulerInner = (props: InnerProps): JSX.Element => {
    const {board, cards, activeView, readonly, dateDisplayProperty, showCard, initialSelectedDate} = props
    const intl = useIntl()

    // Person-typed properties (person / multiPerson / *Notify) store raw
    // user IDs in card.fields.properties — PropertyType.displayValue passes
    // those through unchanged because the abstract base has no view of the
    // user store. We resolve IDs to display names here using the same
    // selectors and helper the rest of Boards uses (Utils.getUserDisplayName
    // plus the user's `teammateNameDisplay` preference from clientConfig),
    // so what shows up on a Scheduler event matches what the user sees in
    // the Person picker / table cells.
    const boardUsersById = useAppSelector<{[key: string]: IUser}>(getBoardUsers)
    const clientConfig = useAppSelector(getClientConfig)

    const colorProperty = useMemo(() => {
        const id = activeView.fields.colorPropertyId
        if (!id) {
            return undefined
        }
        const tpl = board.cardProperties.find((p) => p.id === id)
        if (!tpl) {
            return undefined
        }
        // Mirror ViewHeaderColorByMenu — only `select` carries an option
        // palette we can map onto Schedule-X calendars.
        if (tpl.type !== 'select') {
            return undefined
        }
        return tpl
    }, [board.cardProperties, activeView.fields.colorPropertyId])

    const visiblePropertyTemplates = useMemo(() => (
        board.cardProperties.filter((template: IPropertyTemplate) => activeView.fields.visiblePropertyIds.includes(template.id))
    ), [board.cardProperties, activeView.fields.visiblePropertyIds])

    const visibleBadges = activeView.fields.visiblePropertyIds.includes(Constants.badgesColumnId)

    // Build the per-color-group calendars. Schedule-X looks up
    // event.calendarId in this map at render time and applies the matching
    // ColorDefinition. We always include NO_VALUE_KEY so unset cards have
    // a deterministic (subtle gray) appearance instead of falling through
    // to Schedule-X's library default which doesn't match Boards' palette.
    const calendars = useMemo<Record<string, CalendarType>>(() => {
        const result: Record<string, CalendarType> = {}
        if (colorProperty?.options?.length) {
            for (const opt of colorProperty.options) {
                const colorName = opt.color || 'propColorDefault'
                const container = COLOR_HEX_BY_NAME[colorName] || COLOR_HEX_BY_NAME.propColorDefault
                const main = COLOR_HEX_MAIN_BY_NAME[colorName] || COLOR_HEX_MAIN_BY_NAME.propColorDefault
                result[opt.id] = {
                    colorName,
                    label: opt.value,
                    lightColors: {main, container, onContainer: '#1f1f1f'},
                    darkColors: {main, container, onContainer: '#ffffff'},
                }
            }
        }
        result[NO_VALUE_KEY] = {
            colorName: 'default',
            label: intl.formatMessage({id: 'Scheduler.no-value', defaultMessage: '(no value)'}),
            lightColors: {main: '#9c9c9c', container: '#ededed', onContainer: '#1f1f1f'},
            darkColors: {main: '#cccccc', container: '#3a3a3a', onContainer: '#ffffff'},
        }
        return result
    }, [colorProperty, intl])

    // Project each card with a usable date value into a Schedule-X event.
    // The shape of `start`/`end` depends on whether the card's date value
    // has `includeTime` set: time-on values become ZonedDateTime instances
    // (so they land in the time-grid at their wall-clock time), time-off
    // values stay as PlainDate (rendered in the all-day date-grid strip).
    const events = useMemo<CalendarEvent[]>(() => {
        return cards.flatMap((card): CalendarEvent[] => {
            const rawValue = card.fields.properties[dateDisplayProperty.id]
            if (typeof rawValue !== 'string' || !rawValue) {
                return []
            }
            const dp = createDatePropertyFromString(rawValue)
            if (!dp.from) {
                return []
            }

            // Resolve calendarId for color. Same logic regardless of
            // includeTime — color comes from a separate Select property.
            let calendarId = NO_VALUE_KEY
            if (colorProperty) {
                const colorVal = card.fields.properties[colorProperty.id]
                if (Array.isArray(colorVal) && colorVal.length > 0 && typeof colorVal[0] === 'string') {
                    calendarId = colorVal[0]
                } else if (typeof colorVal === 'string' && colorVal.length > 0) {
                    calendarId = colorVal
                }
                if (!calendars[calendarId]) {
                    calendarId = NO_VALUE_KEY
                }
            }

            const title = card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})

            if (dp.includeTime) {
                // `from`/`to` are stored as the actual UTC instants — convert
                // to ZonedDateTime in the local zone so the calendar renders
                // them at the right hour. Single-instant events (no `to`)
                // get a default 1h duration so they're visible as a block.
                const start = epochMsToZoned(dp.from, LOCAL_TZ)
                const end = dp.to ? epochMsToZoned(dp.to, LOCAL_TZ) : start.add({hours: 1})
                return [{
                    id: card.id,
                    title,
                    start,
                    end,
                    calendarId,
                }]
            }

            // Legacy date-only path: defer to the existing DatePropertyType
            // helpers which strip time-of-day to local midnight (matches
            // Calendar/Gantt behavior) and feed PlainDates into Schedule-X
            // so the event lands in the all-day strip.
            const propType = propsRegistry.get(dateDisplayProperty.type)
            if (!(propType instanceof DatePropertyType)) {
                return []
            }
            const dateFrom = propType.getDateFrom(rawValue, card)
            if (!dateFrom) {
                return []
            }
            const dateTo = propType.getDateTo(rawValue, card) || new Date(dateFrom)

            return [{
                id: card.id,
                title,
                start: dateToPlainDate(dateFrom),
                end: dateToPlainDate(dateTo),
                calendarId,
            }]
        })
    }, [cards, dateDisplayProperty, colorProperty, calendars, intl])

    // Plugin instances must outlive a single render — Schedule-X holds them
    // by reference inside the calendar app for its lifetime. Rebuilding them
    // in-place would detach handlers.
    const eventsServiceRef = useRef(createEventsServicePlugin())
    const dndPluginRef = useRef(createDragAndDropPlugin())
    const resizePluginRef = useRef(createResizePlugin())

    // Refs to pull the latest cards/dateProp out of the onEventUpdate
    // callback — that callback is captured at calendar construction time
    // and never re-bound, so without refs it would close over stale cards.
    const cardsRef = useRef(cards)
    cardsRef.current = cards

    // Timestamp of the most recent local DnD/resize. Used by two
    // downstream consumers:
    //   * onEventClick — a finished resize on a date-grid handle bubbles
    //     up the same mouseup that would otherwise be interpreted as a
    //     plain click and pop the card-detail modal. Suppress clicks for
    //     a short window after the update fires.
    //   * the events-sync effect — when the user just dragged/resized,
    //     Schedule-X has already moved the event visually inside its own
    //     state, and our `mutator.changePropertyValue` bounces back into
    //     `cards` → `events` recompute → `eventsService.set(events)` would
    //     replace the entire event list, causing a brief relayout and the
    //     viewport scrolling back to "today". Suppressing the set during
    //     this window avoids that flicker; external (websocket) updates
    //     within ~500ms of a local drag are deferred to the next refresh.
    const recentUpdateRef = useRef<number>(0)
    // Wider than feels strictly necessary because the redux roundtrip on
    // a real Mattermost deployment (DnD → mutator.changePropertyValue →
    // server PATCH → server-pushed block update → redux store → cards
    // re-render → events memo → this useEffect) routinely takes longer
    // than 500ms on slower networks. The previous narrower window let
    // the events.set fire after a drag and reproduce the visible reload.
    // 2 seconds covers nearly all observed cases and is short enough that
    // a deliberate edit by a different user via WebSocket within that
    // window is fine to defer to the next refresh.
    const RECENT_UPDATE_WINDOW_MS = 2000

    const handleEventUpdate = useCallback((updated: CalendarEvent) => {
        if (readonly) {
            return
        }
        recentUpdateRef.current = Date.now()
        const card = cardsRef.current.find((c) => c.id === updated.id)
        if (!card) {
            return
        }
        const start = updated.start as Temporal.PlainDate | Temporal.ZonedDateTime
        const end = updated.end as Temporal.PlainDate | Temporal.ZonedDateTime

        // Round-trip the event back to Boards' DateProperty shape. The
        // includeTime branch is decided by what Schedule-X handed us: time-
        // grid drag/resize keeps ZonedDateTime, date-grid drag stays in
        // PlainDate. Resize that crosses the time-grid / date-grid boundary
        // isn't a thing in Schedule-X v3.7 — events stay in their original
        // surface — so this branching is safe.
        if (!isPlainDate(start)) {
            const startZ = start as Temporal.ZonedDateTime
            const endZ = end as Temporal.ZonedDateTime
            const dateProp: DateProperty = {
                from: startZ.epochMilliseconds,
                includeTime: true,
            }
            // Always store `to` for time-on values so the wall-clock end is
            // preserved across reloads — without it, a single-instant event
            // would lose its duration on next render.
            dateProp.to = endZ.epochMilliseconds
            mutator.changePropertyValue(board.id, card, dateDisplayProperty.id, JSON.stringify(dateProp))
            return
        }

        const startPd = toPlainDate(start)
        const endPd = toPlainDate(end)
        const dateProp: DateProperty = {from: plainDateToBoardsDateMs(startPd)}
        // Boards collapses single-day ranges to from-only — preserve that
        // shape so a one-day drag round-trips cleanly through the Calendar
        // view too.
        if (!startPd.equals(endPd)) {
            dateProp.to = plainDateToBoardsDateMs(endPd)
        }
        mutator.changePropertyValue(board.id, card, dateDisplayProperty.id, JSON.stringify(dateProp))
    }, [board.id, dateDisplayProperty.id, readonly])

    // Stable container for everything the event renderer consumes. We
    // refresh the .current on each render so the renderer always sees
    // up-to-date values, but the renderer's *callback identity* — and
    // therefore the `customComponents` prop given to <ScheduleXCalendar/>
    // — never changes. That's load-bearing: schedule-x's React wrapper
    // (`@schedule-x/react/dist/index.cjs`) treats `customComponents` as
    // an effect dep and runs `calendarApp.destroy()` + `.render()` on
    // every change. With deps like `boardUsersById`, `calendars` or
    // `board` itself in EventRenderer's useCallback, the slightest
    // upstream redux churn rebuilt the entire calendar — which is the
    // visible "reload + scroll" flicker the user reports after every
    // drag (drag triggers a property mutation → redux update → some
    // selector returns a new ref → useCallback recomputes → schedule-x
    // re-mounts).
    const rendererDataRef = useRef({
        intl,
        showCard,
        visiblePropertyTemplates,
        visibleBadges,
        calendars,
        boardUsersById,
        clientConfig,
    })
    rendererDataRef.current = {
        intl,
        showCard,
        visiblePropertyTemplates,
        visibleBadges,
        calendars,
        boardUsersById,
        clientConfig,
    }

    // Custom event renderer — invoked by Schedule-X for each of the four
    // event surfaces (week time-grid / week date-grid / month grid /
    // month agenda). We use the same component for all four so the
    // displayed metadata stays consistent across views.
    //
    // Schedule-X v3.7's built-in event wrapper deliberately drops its own
    // `backgroundColor` / `borderInlineStart` styles when a custom
    // component is supplied (core.cjs.js around line 2387 / 1678) — the
    // implicit contract is that the custom renderer paints its own colors.
    // Without this, multi-day all-day events become invisible bars: their
    // wrapper `width: calc(N * 100%)` still spans the right number of
    // days, but the user just sees the title text at the start cell with
    // nothing painting the rest. So we resolve the same hex pair here that
    // Schedule-X would have applied to the wrapper and inline it onto the
    // SchedulerEvent root.
    //
    // Empty deps (and reading everything from `rendererDataRef.current`)
    // is intentional — see the comment on rendererDataRef above.
    const EventRenderer = useCallback(({calendarEvent}: {calendarEvent: CalendarEvent}) => {
        const data = rendererDataRef.current
        const card = cardsRef.current.find((c) => c.id === calendarEvent.id)
        const calId = (calendarEvent.calendarId as string) || NO_VALUE_KEY
        const cal = data.calendars[calId] || data.calendars[NO_VALUE_KEY]
        const eventStyle: React.CSSProperties = cal?.lightColors ? {
            backgroundColor: cal.lightColors.container,
            color: cal.lightColors.onContainer,
            borderInlineStart: `4px solid ${cal.lightColors.main}`,
        } : {}

        if (!card) {
            // Brief race during card deletion — Schedule-X may still call
            // the renderer after the card has gone but before events.set
            // runs. Render the bare title so we don't crash.
            return (
                <div
                    className='SchedulerEvent'
                    style={eventStyle}
                >
                    {String(calendarEvent.title || '')}
                </div>
            )
        }

        // Inline-render visible properties next to the title rather than as
        // a stacked row of PropertyValueElements: schedule-x's date-grid
        // events are fixed-height single-row bars and any vertical content
        // we add gets clipped by the wrapper's `overflow: hidden`. By
        // collapsing each property to its `displayValue` string and joining
        // them with a `·` separator we get a "Title · Status: Done · …"
        // line that fits in the available 1-line slot. PropertyValueElement
        // would have rendered the same data with extra chrome (option
        // backgrounds, person avatars) that the cell's height can't show
        // anyway.
        const titleText = card.title || data.intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
        const inlinePropParts: Array<{key: string, label: string, text: string}> = []
        const nameFormat = data.clientConfig?.teammateNameDisplay || 'username'
        for (const template of data.visiblePropertyTemplates) {
            const propType = propsRegistry.get(template.type)
            if (!propType) {
                continue
            }
            const val = card.fields.properties[template.id]
            let text = ''
            if (template.type === 'person' || template.type === 'personNotify' ||
                template.type === 'multiPerson' || template.type === 'multiPersonNotify') {
                // Resolve user IDs → display names. PropertyType.displayValue
                // for these types echoes the raw IDs (no user-store access in
                // the property layer), which would surface as opaque hashes
                // on event labels. Mirror what the other Boards surfaces do
                // and look the user up in the board-users selector instead.
                const ids: string[] = Array.isArray(val) ? (val as string[]).filter(Boolean) : (typeof val === 'string' && val ? [val] : [])
                const names: string[] = []
                for (const id of ids) {
                    const u = data.boardUsersById[id]
                    if (u) {
                        names.push(Utils.getUserDisplayName(u, nameFormat))
                    }
                    // If the user isn't in boardUsersById (e.g. left the
                    // team) we skip rather than fall back to the raw id —
                    // a stranded id wouldn't be meaningful to the viewer.
                }
                text = names.join(', ')
            } else {
                const dv = propType.displayValue(val as string | string[] | undefined, card, template, data.intl)
                if (typeof dv === 'string') {
                    text = dv
                } else if (Array.isArray(dv)) {
                    text = dv.filter(Boolean).join(', ')
                }
            }
            if (text) {
                inlinePropParts.push({key: template.id, label: template.name, text})
            }
        }

        return (
            <div
                className='SchedulerEvent'
                style={eventStyle}
                onClick={(e: React.MouseEvent) => {
                    e.stopPropagation()
                    data.showCard(card.id)
                }}
            >
                <div className='SchedulerEvent__titleRow'>
                    {card.fields.icon && (
                        <span className='SchedulerEvent__icon'>{card.fields.icon}</span>
                    )}
                    <span className='SchedulerEvent__title'>{titleText}</span>
                    {inlinePropParts.map((p) => (
                        <Tooltip
                            key={p.key}
                            title={p.label}
                        >
                            <span className='SchedulerEvent__inlineProp'>{`· ${p.text}`}</span>
                        </Tooltip>
                    ))}
                </div>
                {data.visibleBadges && (
                    <CardBadges card={card}/>
                )}
            </div>
        )
    }, [])

    // EventRenderer identity is locked in by the empty-deps useCallback
    // above, so this useMemo is also referentially stable and the
    // ScheduleXCalendar effect that watches `customComponents` no longer
    // tears down the calendar on each redux update.
    const customComponents = useMemo(() => ({
        timeGridEvent: EventRenderer,
        dateGridEvent: EventRenderer,
        monthGridEvent: EventRenderer,
        monthAgendaEvent: EventRenderer,
    }), [EventRenderer])

    // Build the calendar config. `events` is captured on first render only;
    // subsequent updates flow through the eventsService.set() effect below.
    const calendarApp = useCalendarApp({
        // List is an MIT-licensed built-in view (`createViewList`). It
        // shows events grouped by day in a vertical list — same affordance
        // a user would reach for to scan upcoming work without clicking
        // through weeks. Order matches the View dropdown in schedule-x:
        // Week, Day, Month grid, Month agenda, List.
        views: [createViewWeek(), createViewDay(), createViewMonthGrid(), createViewMonthAgenda(), createViewList()],
        defaultView: 'week',
        // Honor a year-view jump request: when set, schedule-x opens
        // anchored on this day. Recreated each remount via the parent's
        // `initialDateKey` in innerKey, so this isn't fighting schedule-x's
        // one-shot config behavior.
        selectedDate: initialSelectedDate ?
            Temporal.PlainDate.from({
                year: initialSelectedDate.getFullYear(),
                month: initialSelectedDate.getMonth() + 1,
                day: initialSelectedDate.getDate(),
            }) :
            undefined,
        events,
        calendars,
        callbacks: {
            onEventClick: (e: CalendarEvent) => {
                // Schedule-X fires onClick from the same mouseup that ends
                // a resize/drag — without this guard, finishing a resize
                // would also pop the card-detail modal.
                // Click suppression after a drag/resize uses a tighter
                // window than the events-sync skip — only the trailing
                // mouseup of the gesture needs to be ignored, not the
                // whole network roundtrip.
                if (Date.now() - recentUpdateRef.current < 600) {
                    return
                }
                showCard(String(e.id))
            },
            onEventUpdate: handleEventUpdate,
        },
    }, [eventsServiceRef.current, dndPluginRef.current, resizePluginRef.current])

    // Sync Boards card changes into the live calendar. eventsService.set
    // replaces the entire list — fine for our scale (a typical Board has
    // O(100) cards) and keeps the diff logic out of this component. We
    // skip the very first run because the initial events were already
    // included in the calendar config above; calling set twice on first
    // mount would briefly double-render.
    const isFirstRunRef = useRef(true)
    useEffect(() => {
        if (!calendarApp) {
            return
        }
        if (isFirstRunRef.current) {
            isFirstRunRef.current = false
            return
        }
        // Skip when the events-array change comes from our own DnD/resize
        // round-trip (mutator → cards → events recompute). Schedule-X
        // already painted the new position via its drag plugin; calling
        // .set here would tear down and re-render every event, which
        // visually reads as the calendar reloading + losing scroll.
        if (Date.now() - recentUpdateRef.current < RECENT_UPDATE_WINDOW_MS) {
            return
        }
        eventsServiceRef.current.set(events)
    }, [events, calendarApp])

    return (
        <div className='SchedulerContainer__body'>
            <ScheduleXCalendar
                calendarApp={calendarApp}
                customComponents={customComponents}
            />
        </div>
    )
}

export default React.memo(SchedulerView)
