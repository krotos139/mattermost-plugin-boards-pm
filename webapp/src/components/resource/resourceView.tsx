// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Resource view — a Gantt-style chart where each row represents one
// assignee (a "resource"), and each bar on the row is a card the resource
// is working on, sized by the same date property as the Timeline view.
//
// Compared to ganttView.tsx the structural difference is that one card can
// produce multiple rows (one per assignee for a multiPerson property), so
// frappe-gantt task ids are synthetic "resourceId|cardId" values; the card
// id is recovered when the user double-clicks a bar to open the card or
// drags it to reschedule. Drags update the underlying card's date
// property; all bars for that card across every resource row reflect the
// new value on the next render via the standard data path.

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useIntl} from 'react-intl'

// Same vendored frappe-gantt as ganttView.tsx. See that file for the
// rationale on why we ship a local ESM copy instead of the npm package.
import GanttImport, {GanttTask} from '../gantt/frappe-gantt.vendor.js'

import '../gantt/frappe-gantt.vendor.css'

import {DatePropertyType} from '../../properties/types'
import mutator from '../../mutator'
import {Board, IPropertyTemplate} from '../../blocks/board'
import {BoardView, createBoardView} from '../../blocks/boardView'
import {Card} from '../../blocks/card'
import {DateProperty} from '../../properties/date/date'
import propsRegistry from '../../properties'
import {useAppDispatch, useAppSelector} from '../../store/hooks'
import {updateView} from '../../store/views'
import {getBoardUsers} from '../../store/users'
import {IUser} from '../../user'

import './resourceView.scss'

// Frappe-gantt layout constants — same values as ganttView.tsx so swim
// lanes line up pixel-perfectly with the SVG bars without monkey-patching
// frappe's CSS.
const FRAPPE_BAR_HEIGHT = 30
const FRAPPE_PADDING = 18
const FRAPPE_UPPER_HEADER = 45
const FRAPPE_LOWER_HEADER = 30
const FRAPPE_HEADER_HEIGHT = FRAPPE_UPPER_HEADER + FRAPPE_LOWER_HEADER + 10
const ROW_HEIGHT = FRAPPE_BAR_HEIGHT + FRAPPE_PADDING

const RESOURCE_COLUMN_KEY = '__resource'
const DEFAULT_RESOURCE_COLUMN_WIDTH = 200
const MIN_RESOURCE_COLUMN_WIDTH = 80

const UNASSIGNED_RESOURCE_ID = '__unassigned'

// Synthetic id wires together the swim lane ("resource") and the card
// occupying it. Use a delimiter that can never appear in a real user id
// or block id (both are 27-char alphanum): a single `|` is enough.
const SYNTH_DELIMITER = '|'
const buildSynthId = (resourceId: string, cardId: string) => resourceId + SYNTH_DELIMITER + cardId
const cardIdFromSynth = (synth: string): string => {
    const idx = synth.indexOf(SYNTH_DELIMITER)
    return idx === -1 ? synth : synth.slice(idx + 1)
}

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

// Match the Calendar / Timeline view's date encoding so bars dragged here
// read back the same way they would after edit-in-place from a date picker.
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

function isSameDateValue(rawCurrent: unknown, next: DateProperty): boolean {
    if (typeof rawCurrent !== 'string' || rawCurrent === '') {
        return false
    }
    try {
        const cur = JSON.parse(rawCurrent)
        if (!cur || typeof cur.from !== 'number') {
            return false
        }
        if (cur.from !== next.from) {
            return false
        }
        const curTo = typeof cur.to === 'number' ? cur.to : undefined
        const nextTo = typeof next.to === 'number' ? next.to : undefined
        return curTo === nextTo
    } catch {
        return false
    }
}

const formatYMD = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// Pull the list of resource ids out of one card for the configured resource
// property. Single-value types (person, personNotify, createdBy, updatedBy)
// return a one-element array; multi types return all members. An empty
// list signals "card has no assignee for this property" — handled
// separately by the swim-lane builder, which routes those cards to the
// "Unassigned" pseudo-row.
function readResourceIds(card: Card, prop?: IPropertyTemplate): string[] {
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
    return `gantt-bar-color-${option.color}`
}

// Resolve a user id to the human-readable label shown in the swim-lane
// column. Falls back to the raw id if the user is not in the local store
// (happens when a deactivated user is still referenced on a card).
function resourceLabel(resourceId: string, users: {[id: string]: IUser}, intl: ReturnType<typeof useIntl>): string {
    if (resourceId === UNASSIGNED_RESOURCE_ID) {
        return intl.formatMessage({id: 'ResourceView.unassigned', defaultMessage: 'Unassigned'})
    }
    const u = users[resourceId]
    if (!u) {
        return resourceId
    }
    return u.username || u.email || resourceId
}

// Ranges in ms for two date intervals from a card's date property. Used by
// the conflict detector so we can flag overlapping bars on the same
// resource row. Both intervals are inclusive at the day granularity.
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart <= bEnd && bStart <= aEnd
}

type ResourceRow = {
    synthId: string
    resourceId: string
    resourceLabel: string
    isFirstOfGroup: boolean
    card: Card
    startMs: number
    endMs: number
    progress: number
    colorClass: string
}

const ResourceView = (props: Props): JSX.Element|null => {
    const {board, cards, activeView, dateDisplayProperty, readonly, showCard} = props
    const intl = useIntl()
    const dispatch = useAppDispatch()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const ganttRef = useRef<InstanceType<typeof GanttImport> | null>(null)
    const sidePanelInnerRef = useRef<HTMLDivElement | null>(null)
    const builtSignatureRef = useRef<string>('')
    const pendingDragRef = useRef<{synthId: string, start: Date, end: Date} | null>(null)
    const commitDragChangeRef = useRef<(synthId: string, start: Date, end: Date) => void>(() => {})

    const isEditable = !readonly && Boolean(dateDisplayProperty) &&
        !propsRegistry.get(dateDisplayProperty!.type).isReadOnly

    const resourceProperty = useMemo<IPropertyTemplate | undefined>(() => {
        const id = activeView.fields.resourcePropertyId
        if (!id) {
            return undefined
        }
        return board.cardProperties.find((p) => p.id === id)
    }, [board.cardProperties, activeView.fields.resourcePropertyId])

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
    const cardsRef = useRef<Card[]>(cards)
    const boardUsersRef = useRef<{[id: string]: IUser}>(boardUsers)
    const showCardRef = useRef(showCard)
    cardsRef.current = cards
    boardUsersRef.current = boardUsers
    showCardRef.current = showCard

    const [liveResourceColumnWidth, setLiveResourceColumnWidth] = useState<number | null>(null)

    const storedResourceColumnWidth = useMemo<number>(() => {
        const stored = activeView.fields.columnWidths?.[RESOURCE_COLUMN_KEY]
        return stored && stored > 0 ? stored : DEFAULT_RESOURCE_COLUMN_WIDTH
    }, [activeView.fields.columnWidths])

    const effectiveResourceColumnWidth = liveResourceColumnWidth !== null ? liveResourceColumnWidth : storedResourceColumnWidth

    const startResourceColumnResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== undefined && event.button !== 0) {
            return
        }
        event.preventDefault()
        event.stopPropagation()

        const startX = event.clientX
        const startWidth = effectiveResourceColumnWidth

        const computeWidth = (clientX: number): number =>
            Math.max(MIN_RESOURCE_COLUMN_WIDTH, startWidth + (clientX - startX))

        const onPointerMove = (ev: PointerEvent) => {
            setLiveResourceColumnWidth(computeWidth(ev.clientX))
        }
        const onPointerUp = (ev: PointerEvent) => {
            document.removeEventListener('pointermove', onPointerMove)
            document.removeEventListener('pointerup', onPointerUp)
            document.removeEventListener('pointercancel', onPointerUp)
            document.body.style.userSelect = ''

            const finalWidth = computeWidth(ev.clientX)
            const previousStored = activeView.fields.columnWidths?.[RESOURCE_COLUMN_KEY] ?? 0
            setLiveResourceColumnWidth(null)
            if (finalWidth === previousStored) {
                return
            }
            const nextWidths = {...(activeView.fields.columnWidths || {}), [RESOURCE_COLUMN_KEY]: finalWidth}
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
        document.body.style.userSelect = 'none'
    }, [activeView, board.id, dispatch, effectiveResourceColumnWidth])

    // Build the swim-lane rows. One ResourceRow per (resource, card) pair.
    // Cards without a resource value are funneled to the "Unassigned"
    // synthetic group so they're still visible. Sort: by resource label
    // first (alpha, "Unassigned" pinned to the bottom), then by start
    // date — that gives a clean visual progression along each lane.
    const rows = useMemo<ResourceRow[]>(() => {
        if (!dateDisplayProperty || !resourceProperty) {
            return []
        }
        const dateProp = propsRegistry.get(dateDisplayProperty.type)
        if (!(dateProp instanceof DatePropertyType)) {
            return []
        }

        const built: ResourceRow[] = []
        for (const card of cards) {
            const raw = card.fields.properties[dateDisplayProperty.id]
            const dateFrom = dateProp.getDateFrom(raw, card)
            if (!dateFrom) {
                continue
            }
            const dateTo = dateProp.getDateTo(raw, card) || new Date(dateFrom)
            const startMs = dateFrom.getTime()
            const endMs = dateTo.getTime()
            const progress = readProgress(card, progressProperty)
            const colorClass = resolveBarColorClass(card, colorProperty)

            const resourceIds = readResourceIds(card, resourceProperty)
            const owners = resourceIds.length > 0 ? resourceIds : [UNASSIGNED_RESOURCE_ID]
            for (const resourceId of owners) {
                built.push({
                    synthId: buildSynthId(resourceId, card.id),
                    resourceId,
                    resourceLabel: resourceLabel(resourceId, boardUsers, intl),
                    isFirstOfGroup: false,
                    card,
                    startMs,
                    endMs,
                    progress,
                    colorClass,
                })
            }
        }

        built.sort((a, b) => {
            // Pin "Unassigned" to the bottom regardless of label sort.
            const aUnassigned = a.resourceId === UNASSIGNED_RESOURCE_ID
            const bUnassigned = b.resourceId === UNASSIGNED_RESOURCE_ID
            if (aUnassigned !== bUnassigned) {
                return aUnassigned ? 1 : -1
            }
            const labelCmp = a.resourceLabel.localeCompare(b.resourceLabel)
            if (labelCmp !== 0) {
                return labelCmp
            }
            return a.startMs - b.startMs
        })

        // Mark first-of-group AFTER sorting so the swim-lane label only
        // renders once at the top of each contiguous run of rows for the
        // same resource.
        let lastResourceId = ''
        for (const row of built) {
            if (row.resourceId !== lastResourceId) {
                row.isFirstOfGroup = true
                lastResourceId = row.resourceId
            }
        }

        return built
    }, [cards, dateDisplayProperty, resourceProperty, progressProperty, colorProperty, boardUsers, intl])

    // Detect overlapping bars on the same resource row — useful as a
    // workload-conflict signal. Tags the bar with an extra CSS class so the
    // resource-view stylesheet can highlight the overlap.
    const conflictingSynthIds = useMemo<Set<string>>(() => {
        const conflicts = new Set<string>()
        // Group rows by resource (already sorted, so a single linear pass works).
        let groupStart = 0
        for (let i = 0; i <= rows.length; i++) {
            const atEnd = i === rows.length
            const sameAsPrev = !atEnd && i > 0 && rows[i].resourceId === rows[groupStart].resourceId
            if (atEnd || !sameAsPrev) {
                // Compare every pair in the group [groupStart, i).
                for (let a = groupStart; a < i; a++) {
                    for (let b = a + 1; b < i; b++) {
                        if (rangesOverlap(rows[a].startMs, rows[a].endMs, rows[b].startMs, rows[b].endMs)) {
                            conflicts.add(rows[a].synthId)
                            conflicts.add(rows[b].synthId)
                        }
                    }
                }
                groupStart = i
            }
        }
        return conflicts
    }, [rows])

    const ganttTasks = useMemo<GanttTask[]>(() => {
        return rows.map((row) => {
            const icon = row.card.fields?.icon
            const baseTitle = row.card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
            const classes: string[] = []
            if (row.colorClass) {
                classes.push(row.colorClass)
            }
            if (conflictingSynthIds.has(row.synthId)) {
                classes.push('gantt-bar-conflict')
            }
            return {
                id: row.synthId,
                name: icon ? `${icon} ${baseTitle}` : baseTitle,
                start: formatYMD(new Date(row.startMs)),
                end: formatYMD(new Date(row.endMs)),
                progress: row.progress,
                custom_class: classes.join(' ') || undefined,
            }
        })
    }, [rows, conflictingSynthIds, intl])

    const structuralSignature = useMemo(() => (
        ganttTasks.map((t) => `${t.id}#${t.custom_class || ''}`).join(';')
    ), [ganttTasks])

    function resolveGanttCtor(): (new (
        wrapper: HTMLElement | string,
        tasks: GanttTask[],
        options?: ConstructorParameters<typeof GanttImport>[2],
    ) => InstanceType<typeof GanttImport>) | null {
        const mod: any = GanttImport
        const candidates: any[] = [mod, mod?.default, mod?.default?.default]
        for (const c of candidates) {
            if (typeof c === 'function') {
                return c
            }
        }
        return null
    }

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
            scroll_to: builtSignatureRef.current ? '' : 'today',
            popup: ({task, add_action}) => {
                const liveCards = cardsRef.current
                const cardId = cardIdFromSynth(task.id)
                const card = liveCards.find((c) => c.id === cardId)
                if (!card) {
                    return `<div class="GanttPopup"><div class="GanttPopup__title">${escapeHtml(task.name || '')}</div></div>`
                }

                const titleText = card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
                const titleHtml = `${card.fields?.icon ? escapeHtml(card.fields.icon) + ' ' : ''}${escapeHtml(titleText)}`

                add_action(
                    intl.formatMessage({id: 'ResourceView.popup-open', defaultMessage: 'Open task'}),
                    () => showCardRef.current(cardId),
                )

                return (
                    `<div class="GanttPopup">` +
                    `<div class="GanttPopup__title">${titleHtml}</div>` +
                    `</div>`
                )
            },
            on_click: () => {},
            on_double_click: (task) => {
                showCard(cardIdFromSynth(task.id))
            },
            on_date_change: (task, start, end) => {
                pendingDragRef.current = {synthId: task.id, start, end}
            },
        })
        ganttRef.current = gantt
        builtSignatureRef.current = structuralSignature

        const newInner = el.querySelector('.gantt-container') as HTMLElement | null
        if (newInner && (prevScrollLeft || prevScrollTop)) {
            newInner.scrollLeft = prevScrollLeft
            newInner.scrollTop = prevScrollTop
        }
        if (newInner && sidePanelInnerRef.current) {
            sidePanelInnerRef.current.style.transform = `translateY(${-(newInner.scrollTop || 0)}px)`
        }

        return () => {
            ganttRef.current = null
            el.innerHTML = ''
            builtSignatureRef.current = ''
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [structuralSignature, isEditable, dateDisplayProperty?.id, resourceProperty?.id])

    useEffect(() => {
        const gantt = ganttRef.current
        if (!gantt) {
            return
        }
        if (structuralSignature !== builtSignatureRef.current) {
            return
        }
        const draggingId = pendingDragRef.current?.synthId
        for (const t of ganttTasks) {
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
        onScroll()
        inner.addEventListener('scroll', onScroll, {passive: true})
        return () => inner.removeEventListener('scroll', onScroll)
    }, [structuralSignature])

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

    // Drag-to-reschedule. The synthetic id binds bar -> card; resource-row
    // membership is read-only here, so dragging only changes the date and
    // never reassigns the card to a different person.
    commitDragChangeRef.current = (synthId: string, start: Date, end: Date) => {
        if (!dateDisplayProperty) {
            return
        }
        const cardId = cardIdFromSynth(synthId)
        const liveCards = cardsRef.current
        const dragged = liveCards.find((c) => c.id === cardId)
        if (!dragged) {
            return
        }
        const dateProp = propsRegistry.get(dateDisplayProperty.type)
        if (!(dateProp instanceof DatePropertyType)) {
            return
        }

        const draggedRaw = dragged.fields.properties[dateDisplayProperty.id]
        const newProp = createDatePropertyFromGanttDates(start, end)
        if (isSameDateValue(draggedRaw, newProp)) {
            return
        }
        mutator.changePropertyValue(
            board.id,
            dragged,
            dateDisplayProperty.id,
            JSON.stringify(newProp),
        )
    }

    useEffect(() => {
        const flush = () => {
            const pending = pendingDragRef.current
            if (!pending) {
                return
            }
            pendingDragRef.current = null
            commitDragChangeRef.current(pending.synthId, pending.start, pending.end)
        }
        document.addEventListener('mouseup', flush)
        document.addEventListener('pointerup', flush)
        document.addEventListener('pointercancel', flush)
        document.addEventListener('touchend', flush)
        document.addEventListener('touchcancel', flush)
        return () => {
            document.removeEventListener('mouseup', flush)
            document.removeEventListener('pointerup', flush)
            document.removeEventListener('pointercancel', flush)
            document.removeEventListener('touchend', flush)
            document.removeEventListener('touchcancel', flush)
        }
    }, [])

    if (!resourceProperty) {
        return (
            <div className='ResourceContainer ResourceContainer--empty'>
                {intl.formatMessage({
                    id: 'ResourceView.no-resource-property',
                    defaultMessage: 'Pick a person or multi-person property in "Resources by" to populate this view.',
                })}
            </div>
        )
    }

    if (!dateDisplayProperty) {
        return (
            <div className='ResourceContainer ResourceContainer--empty'>
                {intl.formatMessage({
                    id: 'ResourceView.no-date-property',
                    defaultMessage: 'Pick a date property in "Display by" to render the timeline.',
                })}
            </div>
        )
    }

    if (rows.length === 0) {
        return (
            <div className='ResourceContainer ResourceContainer--empty'>
                {intl.formatMessage({
                    id: 'ResourceView.no-cards',
                    defaultMessage: 'No cards have a value for this date property yet.',
                })}
            </div>
        )
    }

    // Workload summary: count of bars and total day-span per resource. Shown
    // alongside the resource label on the first row of each group so the
    // user has at-a-glance utilization.
    const summaryByResource = new Map<string, {count: number, totalDays: number}>()
    for (const row of rows) {
        const dayMs = 24 * 60 * 60 * 1000
        const days = Math.max(1, Math.round((row.endMs - row.startMs) / dayMs) + 1)
        const cur = summaryByResource.get(row.resourceId) || {count: 0, totalDays: 0}
        cur.count += 1
        cur.totalDays += days
        summaryByResource.set(row.resourceId, cur)
    }

    return (
        <div className='ResourceContainer'>
            <div className='ResourceContainer__layout'>
                <div className='ResourceContainer__props'>
                    <div
                        className='ResourceContainer__props-header'
                        style={{height: FRAPPE_HEADER_HEIGHT}}
                    >
                        <div
                            className='ResourceContainer__props-cell ResourceContainer__props-cell--header'
                            style={{width: effectiveResourceColumnWidth}}
                            title={resourceProperty.name}
                        >
                            <span className='ResourceContainer__props-cell-text'>{resourceProperty.name}</span>
                            <div
                                className='ResourceContainer__props-grip'
                                onPointerDown={startResourceColumnResize}
                                role='separator'
                                aria-label={intl.formatMessage({id: 'ResourceView.resize-column', defaultMessage: 'Resize column'})}
                            />
                        </div>
                    </div>
                    <div className='ResourceContainer__props-body'>
                        <div
                            ref={sidePanelInnerRef}
                            className='ResourceContainer__props-body-inner'
                        >
                            {rows.map((row) => {
                                const summary = summaryByResource.get(row.resourceId)
                                return (
                                    <div
                                        key={row.synthId}
                                        className={'ResourceContainer__props-row' + (row.isFirstOfGroup ? ' ResourceContainer__props-row--first' : '')}
                                        style={{height: ROW_HEIGHT}}
                                    >
                                        <div
                                            className='ResourceContainer__props-cell'
                                            style={{width: effectiveResourceColumnWidth}}
                                        >
                                            {row.isFirstOfGroup && (
                                                <div className='ResourceContainer__resource-cell'>
                                                    <span className='ResourceContainer__resource-name'>{row.resourceLabel}</span>
                                                    {summary && (
                                                        <span className='ResourceContainer__resource-summary'>
                                                            {intl.formatMessage(
                                                                {
                                                                    id: 'ResourceView.row-summary',
                                                                    defaultMessage: '{count, plural, one {# task} other {# tasks}} · {days, plural, one {# day} other {# days}}',
                                                                },
                                                                {count: summary.count, days: summary.totalDays},
                                                            )}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </div>
                <div
                    ref={containerRef}
                    className='ResourceContainer__chart'
                />
            </div>
        </div>
    )
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export default ResourceView
