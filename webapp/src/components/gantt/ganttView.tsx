// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Timeline / Gantt view powered by frappe-gantt (MIT). Mounts the chart
// imperatively into a div and bridges click + drag events back to the
// Focalboard mutator. "Display by" picks the date property used to size
// the bars; "Linked by" picks the task / multiTask property whose value
// lists the children of the parent task — those are what cascade when a
// parent is dragged. "Progress by" picks a number property (0-100) used
// for the in-bar progress fill.

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useIntl} from 'react-intl'

// Pull frappe-gantt from a vendored ESM bundle inside the project rather
// than the npm package — the published package's `exports` map confuses
// webpack interop in the Mattermost plugin host. See frappe-gantt.vendor.js
// for full context.
import GanttImport, {GanttTask} from './frappe-gantt.vendor.js'

import './frappe-gantt.vendor.css'

type GanttCtorType = new (
    wrapper: HTMLElement | string,
    tasks: GanttTask[],
    options?: ConstructorParameters<typeof GanttImport>[2],
) => InstanceType<typeof GanttImport>

// Resolve lazily so a surprise interop shape can degrade just the timeline
// view without breaking the rest of the plugin.
function resolveGanttCtor(): GanttCtorType | null {
    const mod: any = GanttImport
    const candidates: any[] = [mod, mod?.default, mod?.default?.default]
    for (const c of candidates) {
        if (typeof c === 'function') {
            return c as GanttCtorType
        }
    }
    return null
}

import {DatePropertyType} from '../../properties/types'
import mutator from '../../mutator'
import {Board, IPropertyTemplate} from '../../blocks/board'
import {BoardView, createBoardView} from '../../blocks/boardView'
import {Card} from '../../blocks/card'
import {DateProperty} from '../../properties/date/date'
import propsRegistry from '../../properties'
import {Constants} from '../../constants'
import {useAppDispatch, useAppSelector} from '../../store/hooks'
import {updateView} from '../../store/views'
import {getBoardUsers} from '../../store/users'
import {IUser} from '../../user'
import PropertyValueElement from '../propertyValueElement'

import './ganttView.scss'

// Frappe-gantt layout constants — kept in sync with `defaults.js` in the
// vendored bundle. We read them here so the side panel rows can align
// pixel-perfectly with the SVG bars without monkey-patching frappe's CSS.
const FRAPPE_BAR_HEIGHT = 30
const FRAPPE_PADDING = 18
const FRAPPE_UPPER_HEADER = 45
const FRAPPE_LOWER_HEADER = 30
const FRAPPE_HEADER_HEIGHT = FRAPPE_UPPER_HEADER + FRAPPE_LOWER_HEADER + 10
const ROW_HEIGHT = FRAPPE_BAR_HEIGHT + FRAPPE_PADDING

// Width defaults for the resizable side-panel columns. Width per property is
// stored in `activeView.fields.columnWidths`, the same place the Table view
// stores it, so unsetting / hiding a property keeps the user's prior choice.
const DEFAULT_SIDE_COLUMN_WIDTH = 150
const MIN_SIDE_COLUMN_WIDTH = 60

type Props = {
    board: Board
    cards: Card[]
    activeView: BoardView
    readonly: boolean
    dateDisplayProperty?: IPropertyTemplate
    showCard: (cardId: string) => void
}

const timeZoneOffset = (date: number): number => {
    return new Date(date).getTimezoneOffset() * 60 * 1000
}

// Match the Calendar view's date encoding so bars dragged here read back the
// same way they would after edit-in-place from a date picker.
function createDatePropertyFromGanttDates(start: Date, end: Date): DateProperty {
    const startNoon = new Date(start)
    startNoon.setHours(12, 0, 0, 0)
    const endNoon = new Date(end)
    endNoon.setHours(12, 0, 0, 0)

    const dateFrom = startNoon.getTime() - timeZoneOffset(startNoon.getTime())
    const dateTo = endNoon.getTime() - timeZoneOffset(endNoon.getTime())

    const dateProperty: DateProperty = {from: dateFrom}
    if (dateTo !== dateFrom) {
        dateProperty.to = dateTo
    }
    return dateProperty
}

const formatYMD = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// Pull a list of card IDs out of a single card's task / multiTask property.
// In the new "Linked by" semantics this is the list of *children* of the
// card — the cards that should shift when this one is dragged, and the
// cards that should be drawn with this one as their predecessor on the
// gantt.
function readChildIds(card: Card, prop?: IPropertyTemplate): string[] {
    if (!prop) {
        return []
    }
    const v = card.fields.properties[prop.id]
    if (typeof v === 'string') {
        return v ? [v] : []
    }
    if (Array.isArray(v)) {
        return v.filter((x: unknown): x is string => typeof x === 'string')
    }
    return []
}

// Resolve the color class to apply to a card's bar. Reads the chosen
// option of the configured `colorPropertyId` (must be a select property)
// and returns the option's `propColor*` class. Returns empty string when
// nothing is configured or no option is selected, leaving the bar with
// its default appearance.
function resolveBarColorClass(card: Card, colorProperty?: IPropertyTemplate): string {
    if (!colorProperty || colorProperty.type !== 'select') {
        return ''
    }
    const raw = card.fields.properties[colorProperty.id]
    if (!raw || typeof raw !== 'string') {
        return ''
    }
    const option = colorProperty.options.find((o) => o.id === raw)
    if (!option || !option.color) {
        return ''
    }
    // Single CSS class — frappe-gantt feeds `custom_class` directly into
    // `classList.add()`, which throws on whitespace. Joins the namespace
    // and the propColor* token with a dash.
    return `gantt-bar-color-${option.color}`
}

// Render one card's properties as a sequence of label/value rows for the
// popup. Resolves person ids to usernames, select option ids to labels,
// task ids to titles and dates to locale strings — that lets the popup
// show the same human-readable text the rest of the UI does.
function formatPopupValue(
    raw: unknown,
    template: IPropertyTemplate,
    cardsById: Map<string, Card>,
    boardUsers: {[id: string]: IUser},
): string {
    if (raw === undefined || raw === null || raw === '') {
        return ''
    }
    if (Array.isArray(raw) && raw.length === 0) {
        return ''
    }
    const arrify = (v: unknown): string[] => (Array.isArray(v) ? v as string[] : [v as string])

    switch (template.type) {
    case 'select':
    case 'multiSelect':
        return arrify(raw).map((id) => template.options.find((o) => o.id === id)?.value || id).join(', ')
    case 'person':
    case 'multiPerson':
    case 'personNotify':
    case 'multiPersonNotify':
    case 'createdBy':
    case 'updatedBy':
        return arrify(raw).map((id) => boardUsers[id]?.username || id).join(', ')
    case 'task':
    case 'multiTask':
        return arrify(raw).map((id) => cardsById.get(id)?.title || id).join(', ')
    case 'date':
    case 'deadline': {
        if (typeof raw !== 'string') {
            return String(raw)
        }
        try {
            const obj = JSON.parse(raw)
            if (typeof obj.from === 'number') {
                let s = new Date(obj.from).toLocaleDateString()
                if (typeof obj.to === 'number') {
                    s += ' → ' + new Date(obj.to).toLocaleDateString()
                }
                return s
            }
        } catch {
            // fall through
        }
        return raw
    }
    case 'createdTime':
    case 'updatedTime': {
        const ms = Number(raw)
        return isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : ''
    }
    case 'checkbox':
        return raw === 'true' || raw === true ? '✔' : '✗'
    default:
        return Array.isArray(raw) ? raw.join(', ') : String(raw)
    }
}

// Read a card's progress percent (0-100). Returns 0 when the value is
// missing or unparseable; clamps out-of-range values to the [0, 100]
// window so frappe-gantt always gets sane input.
function readProgress(card: Card, prop?: IPropertyTemplate): number {
    if (!prop) {
        return 0
    }
    const raw = card.fields.properties[prop.id]
    if (raw === undefined || raw === null || raw === '') {
        return 0
    }
    const n = Number(Array.isArray(raw) ? raw[0] : raw)
    if (!isFinite(n)) {
        return 0
    }
    if (n < 0) {
        return 0
    }
    if (n > 100) {
        return 100
    }
    return n
}

const GanttView = (props: Props): JSX.Element|null => {
    const {board, cards, activeView, dateDisplayProperty, readonly, showCard} = props
    const intl = useIntl()
    const dispatch = useAppDispatch()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const ganttRef = useRef<InstanceType<typeof GanttImport> | null>(null)
    // Inner element of the side panel that we shift programmatically to
    // mirror the chart's vertical scroll (bars and side rows must stay
    // aligned even when the user scrolls down past the viewport).
    const sidePanelInnerRef = useRef<HTMLDivElement | null>(null)
    // Tracks the structural signature the current Gantt instance was built
    // for. When it changes we tear down + rebuild; otherwise we apply
    // incremental `update_task` calls so the chart doesn't flicker on every
    // keystroke or drag.
    const builtSignatureRef = useRef<string>('')
    // frappe-gantt fires `date_change` continuously while the user drags
    // or resizes a bar. Committing to the server on every event triggers
    // a websocket round-trip → bar.refresh() → drag aborts. We instead
    // stash the latest in-flight values and only commit on mouseup.
    const pendingDragRef = useRef<{taskId: string, start: Date, end: Date} | null>(null)
    // Latest commit handler — refreshed every render so the document-
    // level mouseup listener captured below picks up new dependencies
    // (cards, linkedBy, etc.) without being torn down.
    const commitDragChangeRef = useRef<(taskId: string, start: Date, end: Date) => void>(() => {})

    const isEditable = !readonly && Boolean(dateDisplayProperty) &&
        !propsRegistry.get(dateDisplayProperty!.type).isReadOnly

    const linkedByProperty = useMemo<IPropertyTemplate | undefined>(() => {
        const id = activeView.fields.linkedByPropertyId
        if (!id) {
            return undefined
        }
        return board.cardProperties.find((p) => p.id === id)
    }, [board.cardProperties, activeView.fields.linkedByPropertyId])

    const progressProperty = useMemo<IPropertyTemplate | undefined>(() => {
        const id = activeView.fields.progressPropertyId
        if (!id) {
            return undefined
        }
        return board.cardProperties.find((p) => p.id === id)
    }, [board.cardProperties, activeView.fields.progressPropertyId])

    const colorProperty = useMemo<IPropertyTemplate | undefined>(() => {
        const id = activeView.fields.colorPropertyId
        if (!id) {
            return undefined
        }
        return board.cardProperties.find((p) => p.id === id)
    }, [board.cardProperties, activeView.fields.colorPropertyId])

    const boardUsers = useAppSelector<{[id: string]: IUser}>(getBoardUsers)

    // Refs that track the latest cards / users / showCard handler so the
    // popup_func closure (created at chart-build time) always reads fresh
    // data without forcing a rebuild on every store update.
    const cardsRef = useRef<Card[]>(cards)
    const boardUsersRef = useRef<{[id: string]: IUser}>(boardUsers)
    const showCardRef = useRef(showCard)
    cardsRef.current = cards
    boardUsersRef.current = boardUsers
    showCardRef.current = showCard

    // Live overrides for column widths during an active resize drag. Cleared
    // when the drag commits or is cancelled. Storing the value here means the
    // dispatched view update doesn't have to land before the next paint —
    // the cell renders the in-flight width directly.
    const [liveColumnWidths, setLiveColumnWidths] = useState<Record<string, number>>({})

    const getStoredColumnWidth = useCallback((id: string): number => {
        const stored = activeView.fields.columnWidths?.[id]
        return stored && stored > 0 ? stored : DEFAULT_SIDE_COLUMN_WIDTH
    }, [activeView.fields.columnWidths])

    const getEffectiveColumnWidth = useCallback((id: string): number => {
        const live = liveColumnWidths[id]
        return live !== undefined ? live : getStoredColumnWidth(id)
    }, [liveColumnWidths, getStoredColumnWidth])

    const startColumnResize = useCallback((event: React.PointerEvent<HTMLDivElement>, columnId: string) => {
        // Only react to primary pointer (left mouse / single-finger touch).
        if (event.button !== undefined && event.button !== 0) {
            return
        }
        event.preventDefault()
        event.stopPropagation()

        const startX = event.clientX
        const startWidth = getEffectiveColumnWidth(columnId)

        const computeWidth = (clientX: number): number =>
            Math.max(MIN_SIDE_COLUMN_WIDTH, startWidth + (clientX - startX))

        const onPointerMove = (ev: PointerEvent) => {
            setLiveColumnWidths((prev) => ({...prev, [columnId]: computeWidth(ev.clientX)}))
        }
        const onPointerUp = (ev: PointerEvent) => {
            document.removeEventListener('pointermove', onPointerMove)
            document.removeEventListener('pointerup', onPointerUp)
            document.removeEventListener('pointercancel', onPointerUp)
            document.body.style.userSelect = ''

            const finalWidth = computeWidth(ev.clientX)
            const previousStored = activeView.fields.columnWidths?.[columnId] ?? 0
            // Drop the live override before dispatching so the cell falls back
            // to the stored value once the view update lands.
            setLiveColumnWidths((prev) => {
                if (!(columnId in prev)) {
                    return prev
                }
                const next = {...prev}
                delete next[columnId]
                return next
            })
            if (finalWidth === previousStored) {
                return
            }
            const nextWidths = {...(activeView.fields.columnWidths || {}), [columnId]: finalWidth}
            const newView = createBoardView(activeView)
            newView.fields.columnWidths = nextWidths
            dispatch(updateView(newView))
            mutator.updateBlock(board.id, newView, activeView, 'resize column').catch(() => {
                dispatch(updateView(activeView))
            })
        }
        document.addEventListener('pointermove', onPointerMove)
        document.addEventListener('pointerup', onPointerUp)
        document.addEventListener('pointercancel', onPointerUp)
        // Suppress accidental text selection while dragging.
        document.body.style.userSelect = 'none'
    }, [activeView, board.id, dispatch, getEffectiveColumnWidth])

    // Visible properties from the view config, minus the title (the bar
    // already shows the title) and the synthetic badges column (no card
    // representation). These drive the rendered side panel columns.
    const sidePropertyTemplates = useMemo<IPropertyTemplate[]>(() => {
        const ids = activeView.fields.visiblePropertyIds
        if (!ids || ids.length === 0) {
            return []
        }
        return ids
            .filter((id) => id !== Constants.titleColumnId && id !== Constants.badgesColumnId)
            .map((id) => board.cardProperties.find((p) => p.id === id))
            .filter((t): t is IPropertyTemplate => Boolean(t))
    }, [board.cardProperties, activeView.fields.visiblePropertyIds])

    // Tasks fed to frappe-gantt: every card with a usable start date for the
    // Display-by property. The dependency edges come from inverting the
    // Linked-by relation: each parent card's `linkedBy` field lists its
    // children, which translates to "child.dependencies = [..., parent.id]"
    // in frappe-gantt's vocabulary. We restrict to ids visible on the chart
    // so we don't draw arrows pointing at off-chart cards.
    const ganttTasks = useMemo<GanttTask[]>(() => {
        if (!dateDisplayProperty) {
            return []
        }
        const dateProp = propsRegistry.get(dateDisplayProperty.type)
        if (!(dateProp instanceof DatePropertyType)) {
            return []
        }

        const built: GanttTask[] = []
        for (const card of cards) {
            const raw = card.fields.properties[dateDisplayProperty.id]
            const dateFrom = dateProp.getDateFrom(raw, card)
            if (!dateFrom) {
                continue
            }
            const dateTo = dateProp.getDateTo(raw, card) || new Date(dateFrom)
            const icon = card.fields?.icon
            const baseTitle = card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
            built.push({
                id: card.id,
                name: icon ? `${icon} ${baseTitle}` : baseTitle,
                start: formatYMD(dateFrom),
                end: formatYMD(dateTo),
                progress: readProgress(card, progressProperty),
                custom_class: resolveBarColorClass(card, colorProperty) || undefined,
            })
        }

        if (!linkedByProperty) {
            return built
        }
        // Build child-id → [parent ids] map by walking parents once.
        const inChart = new Set(built.map((t) => t.id))
        const parentsByChild = new Map<string, string[]>()
        for (const card of cards) {
            if (!inChart.has(card.id)) {
                continue
            }
            for (const childId of readChildIds(card, linkedByProperty)) {
                if (!inChart.has(childId) || childId === card.id) {
                    continue
                }
                const arr = parentsByChild.get(childId) || []
                arr.push(card.id)
                parentsByChild.set(childId, arr)
            }
        }
        return built.map((t) => ({
            ...t,
            dependencies: (parentsByChild.get(t.id) || []).join(','),
        }))
    }, [cards, dateDisplayProperty, linkedByProperty, progressProperty, colorProperty, intl])

    // Signature that captures everything frappe-gantt needs a full rebuild
    // for: which cards are visible, in what order, and which arrows connect
    // them. Changes in start/end dates / progress do NOT change the
    // signature, so the common case (drag-to-reschedule) avoids a teardown
    // + rebuild — that was the source of the on-drag flicker.
    const structuralSignature = useMemo(() => (
        ganttTasks.map((t) => `${t.id}@${t.dependencies || ''}#${t.custom_class || ''}`).join(';')
    ), [ganttTasks])

    // Full structural rebuild. Triggered by signature change or by switching
    // properties / readonly state. Saves the inner scroll position around
    // the rebuild so the user's viewport stays where they left it.
    useEffect(() => {
        const el = containerRef.current
        if (!el) {
            return undefined
        }
        if (ganttTasks.length === 0) {
            el.innerHTML = ''
            ganttRef.current = null
            builtSignatureRef.current = ''
            return undefined
        }

        const Ctor = resolveGanttCtor()
        if (!Ctor) {
            const mod: any = GanttImport
            // eslint-disable-next-line no-console
            console.error('frappe-gantt constructor unavailable; module shape:', {
                modType: typeof mod,
                modKeys: mod && typeof mod === 'object' ? Object.keys(mod) : null,
                defaultType: typeof mod?.default,
            })
            return undefined
        }

        const prevInner = el.querySelector('.gantt-container') as HTMLElement | null
        const prevScrollLeft = prevInner?.scrollLeft ?? 0
        const prevScrollTop = prevInner?.scrollTop ?? 0

        el.innerHTML = ''

        const gantt = new Ctor(el, ganttTasks, {
            view_mode: 'Day',
            view_mode_select: true,
            today_button: true,
            readonly: !isEditable,
            readonly_progress: true,
            infinite_padding: true,
            // Honour the previous viewport on rebuild — `today` only
            // applies on the very first mount.
            scroll_to: builtSignatureRef.current ? '' : 'today',
            popup: ({task, add_action}) => {
                const liveCards = cardsRef.current
                const liveUsers = boardUsersRef.current
                const card = liveCards.find((c) => c.id === task.id)
                if (!card) {
                    return `<div class="GanttPopup"><div class="GanttPopup__title">${escapeHtml(task.name || '')}</div></div>`
                }

                const cardsById = new Map<string, Card>(liveCards.map((c) => [c.id, c]))
                const titleText = card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
                const titleHtml = `${card.fields?.icon ? escapeHtml(card.fields.icon) + ' ' : ''}${escapeHtml(titleText)}`

                // Render every property that has a non-empty value. Skips
                // computed types (createdTime/updatedTime) only when their
                // value isn't set; otherwise they round-trip to ms.
                const rows: string[] = []
                for (const template of board.cardProperties) {
                    const raw = card.fields.properties[template.id]
                    const text = formatPopupValue(raw, template, cardsById, liveUsers)
                    if (!text) {
                        continue
                    }
                    rows.push(
                        `<div class="GanttPopup__row">` +
                        `<span class="GanttPopup__label">${escapeHtml(template.name)}</span>` +
                        `<span class="GanttPopup__value">${escapeHtml(text)}</span>` +
                        `</div>`,
                    )
                }

                add_action(
                    intl.formatMessage({id: 'GanttView.popup-open', defaultMessage: 'Open task'}),
                    () => showCardRef.current(task.id),
                )

                return (
                    `<div class="GanttPopup">` +
                    `<div class="GanttPopup__title">${titleHtml}</div>` +
                    (rows.length > 0 ? `<div class="GanttPopup__rows">${rows.join('')}</div>` : '') +
                    `</div>`
                )
            },
            // Single click is a no-op: opening the card on every click made
            // drag/resize impossible because the click handler also fired on
            // mousedown. Use double-click to open instead.
            on_click: () => {},
            on_double_click: (task) => {
                showCard(task.id)
            },
            on_date_change: (task, start, end) => {
                // Don't commit yet — frappe-gantt fires this continuously
                // during drag. Stash the latest values; the document-level
                // mouseup handler commits once when the user releases.
                pendingDragRef.current = {taskId: task.id, start, end}
            },
        })
        ganttRef.current = gantt
        builtSignatureRef.current = structuralSignature

        // Restore scroll on the freshly built inner container.
        const newInner = el.querySelector('.gantt-container') as HTMLElement | null
        if (newInner && (prevScrollLeft || prevScrollTop)) {
            newInner.scrollLeft = prevScrollLeft
            newInner.scrollTop = prevScrollTop
        }
        // After scroll is restored, mirror it onto the side panel so the
        // first paint already aligns.
        if (newInner && sidePanelInnerRef.current) {
            sidePanelInnerRef.current.style.transform = `translateY(${-(newInner.scrollTop || 0)}px)`
        }

        return () => {
            ganttRef.current = null
            el.innerHTML = ''
            builtSignatureRef.current = ''
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [structuralSignature, isEditable, dateDisplayProperty?.id, linkedByProperty?.id])

    // Incremental data sync — applies date / name / progress updates to
    // bars in the already-mounted chart without a full rebuild.
    useEffect(() => {
        const gantt = ganttRef.current
        if (!gantt) {
            return
        }
        if (structuralSignature !== builtSignatureRef.current) {
            return
        }
        const draggingId = pendingDragRef.current?.taskId
        for (const t of ganttTasks) {
            // Don't refresh the bar that's currently being dragged —
            // bar.refresh() rebuilds the SVG group and detaches the live
            // mousemove listener, killing the drag.
            if (draggingId && t.id === draggingId) {
                continue
            }
            try {
                gantt.update_task(t.id, {start: t.start, end: t.end, name: t.name, progress: t.progress})
            } catch {
                // update_task throws on unknown ids; the next structural
                // rebuild will reconcile.
            }
        }
    }, [ganttTasks, structuralSignature])

    // Mirror the chart's vertical scroll onto the side panel so the rows
    // stay aligned with the bars when the user scrolls past the viewport.
    // Re-attaches after every rebuild because frappe-gantt creates a fresh
    // `.gantt-container` element each time.
    useEffect(() => {
        const chartEl = containerRef.current
        const inner = chartEl?.querySelector('.gantt-container') as HTMLElement | null
        const panelInner = sidePanelInnerRef.current
        if (!inner || !panelInner) {
            return undefined
        }
        const onScroll = () => {
            panelInner.style.transform = `translateY(${-inner.scrollTop}px)`
        }
        // Apply once so initial position is right.
        onScroll()
        inner.addEventListener('scroll', onScroll, {passive: true})
        return () => inner.removeEventListener('scroll', onScroll)
    }, [structuralSignature])

    // Kill text selection inside the chart entirely. CSS `user-select:
    // none` alone isn't enough — Firefox still selects SVG `<text>` on
    // drag, which then aborts the drag handlers. Cancelling `selectstart`
    // at the wrapper is the only fix that works across browsers.
    useEffect(() => {
        const el = containerRef.current
        if (!el) {
            return undefined
        }
        const handler = (e: Event) => {
            e.preventDefault()
        }
        el.addEventListener('selectstart', handler)
        return () => el.removeEventListener('selectstart', handler)
    }, [])

    // Commit the deferred drag at mouseup. Uses refs so the latest cards /
    // linkedByProperty / dateDisplayProperty are read at the moment the
    // user releases — not at the moment the chart was built.
    commitDragChangeRef.current = (taskId: string, start: Date, end: Date) => {
        if (!dateDisplayProperty) {
            return
        }
        const liveCards = cardsRef.current
        const dragged = liveCards.find((c) => c.id === taskId)
        if (!dragged) {
            return
        }
        const dateProp = propsRegistry.get(dateDisplayProperty.type)
        if (!(dateProp instanceof DatePropertyType)) {
            return
        }

        // Compute delta against the card's CURRENT stored date so we can
        // apply the same shift to descendants without re-reading them
        // after the dragged card's mutator call lands.
        const draggedRaw = dragged.fields.properties[dateDisplayProperty.id]
        const draggedOldFrom = dateProp.getDateFrom(draggedRaw, dragged)
        const deltaMs = draggedOldFrom ? start.getTime() - draggedOldFrom.getTime() : 0

        // Walk parent → children graph BFS-style. Linked-by names a
        // card's children, so we descend through `readChildIds` of each
        // visited card. The visited set guards against accidental cycles.
        const cascade: Card[] = []
        if (linkedByProperty && deltaMs !== 0) {
            const cardsById = new Map<string, Card>(liveCards.map((c) => [c.id, c]))
            const visited = new Set<string>([dragged.id])
            const queue: string[] = [dragged.id]
            while (queue.length > 0) {
                const curId = queue.shift() as string
                const curCard = cardsById.get(curId)
                if (!curCard) {
                    continue
                }
                for (const childId of readChildIds(curCard, linkedByProperty)) {
                    if (visited.has(childId)) {
                        continue
                    }
                    const childCard = cardsById.get(childId)
                    if (!childCard) {
                        continue
                    }
                    visited.add(childId)
                    cascade.push(childCard)
                    queue.push(childId)
                }
            }
        }

        mutator.performAsUndoGroup(async () => {
            const draggedNewProp = createDatePropertyFromGanttDates(start, end)
            await mutator.changePropertyValue(
                board.id,
                dragged,
                dateDisplayProperty.id,
                JSON.stringify(draggedNewProp),
            )

            for (const dep of cascade) {
                const raw = dep.fields.properties[dateDisplayProperty.id]
                const oldFrom = dateProp.getDateFrom(raw, dep)
                if (!oldFrom) {
                    continue
                }
                const oldTo = dateProp.getDateTo(raw, dep)
                const newProp: DateProperty = {from: oldFrom.getTime() + deltaMs}
                if (oldTo) {
                    newProp.to = oldTo.getTime() + deltaMs
                }
                await mutator.changePropertyValue(
                    board.id,
                    dep,
                    dateDisplayProperty.id,
                    JSON.stringify(newProp),
                )
            }
        })
    }

    // Document-level mouseup listener — flushes any pending drag-change
    // exactly once when the user releases the mouse. Document level
    // because the user may release the mouse outside the chart.
    useEffect(() => {
        const onMouseUp = () => {
            const pending = pendingDragRef.current
            if (!pending) {
                return
            }
            pendingDragRef.current = null
            commitDragChangeRef.current(pending.taskId, pending.start, pending.end)
        }
        document.addEventListener('mouseup', onMouseUp)
        return () => document.removeEventListener('mouseup', onMouseUp)
    }, [])

    if (!dateDisplayProperty) {
        return (
            <div className='GanttContainer GanttContainer--empty'>
                {intl.formatMessage({
                    id: 'GanttView.no-date-property',
                    defaultMessage: 'Pick a date property in "Display by" to render the timeline.',
                })}
            </div>
        )
    }

    if (ganttTasks.length === 0) {
        return (
            <div className='GanttContainer GanttContainer--empty'>
                {intl.formatMessage({
                    id: 'GanttView.no-cards',
                    defaultMessage: 'No cards have a value for this date property yet.',
                })}
            </div>
        )
    }

    const showSidePanel = sidePropertyTemplates.length > 0
    const cardsById = new Map<string, Card>(cards.map((c) => [c.id, c]))

    return (
        <div className='GanttContainer'>
            <div className='GanttContainer__layout'>
                {showSidePanel && (
                    <div className='GanttContainer__props'>
                        <div
                            className='GanttContainer__props-header'
                            style={{height: FRAPPE_HEADER_HEIGHT}}
                        >
                            {sidePropertyTemplates.map((p) => (
                                <div
                                    key={p.id}
                                    className='GanttContainer__props-cell GanttContainer__props-cell--header'
                                    style={{width: getEffectiveColumnWidth(p.id)}}
                                    title={p.name}
                                >
                                    <span className='GanttContainer__props-cell-text'>{p.name}</span>
                                    <div
                                        className='GanttContainer__props-grip'
                                        onPointerDown={(e) => startColumnResize(e, p.id)}
                                        role='separator'
                                        aria-label={intl.formatMessage({id: 'GanttView.resize-column', defaultMessage: 'Resize column'})}
                                    />
                                </div>
                            ))}
                        </div>
                        <div className='GanttContainer__props-body'>
                            <div
                                ref={sidePanelInnerRef}
                                className='GanttContainer__props-body-inner'
                            >
                                {ganttTasks.map((t) => {
                                    const card = cardsById.get(t.id)
                                    if (!card) {
                                        return null
                                    }
                                    return (
                                        <div
                                            key={t.id}
                                            className='GanttContainer__props-row'
                                            style={{height: ROW_HEIGHT}}
                                        >
                                            {sidePropertyTemplates.map((p) => (
                                                <div
                                                    key={p.id}
                                                    className='GanttContainer__props-cell'
                                                    style={{width: getEffectiveColumnWidth(p.id)}}
                                                >
                                                    <PropertyValueElement
                                                        board={board}
                                                        card={card}
                                                        propertyTemplate={p}
                                                        readOnly={true}
                                                        showEmptyPlaceholder={false}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    </div>
                )}
                <div
                    ref={containerRef}
                    className='GanttContainer__chart'
                />
            </div>
        </div>
    )
}

// escapeHtml mirrors the tiny helper Calendar uses inline — popups receive
// raw card titles, which can contain `<` etc.
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export default GanttView
