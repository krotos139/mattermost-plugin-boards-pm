// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Resource view — a Gantt-style chart where each row represents one
// "resource" (a swim lane), and each bar on the row is a card the
// resource is working on, sized by the same date property as the
// Timeline view.
//
// The resource axis is configurable via the "Resources by" header menu
// and accepts:
//   - person / personNotify  → single-user lane
//   - multiPerson / multiPersonNotify  → one lane per assignee
//   - select / multiSelect  → one lane per option (use this for
//     non-human resources: machines, meeting rooms, equipment, etc.)
//   - createdBy / updatedBy  → grouping only; reassignment disabled
//     because these are computed properties.
//
// Compared to ganttView.tsx the structural difference is that one card
// can produce multiple rows (one per assignee for a multi property), so
// frappe-gantt task ids are synthetic prefixed values; the card id and
// source resource id are recovered when the user double-clicks a bar to
// open the card or drags it to reschedule.
//
// Drag interactions:
//  - Horizontal drag (frappe-gantt's native behavior): reschedules the
//    card via mutator.changePropertyValue on the date property.
//  - Vertical drag onto a different swim lane: reassigns the card via
//    mutator.changePropertyValue on the resource property — removing the
//    source resource id (when the source is a real assignee) and adding
//    the target id; the "Unassigned" lane is the empty-value sentinel.
//  - Both axes can move in a single drag; the two updates are batched
//    into one undo group so a single Cmd-Z reverts both.
//
// Group toggle: clicking the chevron next to a resource label collapses
// that swim lane to a single aggregate bar spanning the union of its
// cards' dates. The collapsed set is persisted in
// view.fields.collapsedOptionIds — the same field Kanban uses for its
// collapsed columns; the id namespaces (user / option ids) don't
// overlap so reusing the field is safe.
//
// Chart rendering follows three paths to keep the Gantt visually
// stable: a full Ctor-rebuild only when the read-only constructor
// option needs to change, an in-place `gantt.refresh(newTasks)` when
// the bar set changes (collapse / expand, reassign, add / remove
// card), and pure DOM reconciliation for everything else (date,
// progress, custom_class — covers the conflict-flag flicker).

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
import {Constants} from '../../constants'
import {useAppDispatch, useAppSelector} from '../../store/hooks'
import {updateView} from '../../store/views'
import {getBoardUsers} from '../../store/users'
import {IUser} from '../../user'
import ChevronDown from '../../widgets/icons/chevronDown'
import ChevronRight from '../../widgets/icons/chevronRight'
import PropertyValueElement from '../propertyValueElement'

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
const DEFAULT_RESOURCE_COLUMN_WIDTH = 220
const DEFAULT_PROPERTY_COLUMN_WIDTH = 150
const MIN_COLUMN_WIDTH = 60

const UNASSIGNED_RESOURCE_ID = '__unassigned'

// Synthetic ids on the GanttTasks. Two shapes:
//   't|<resourceId>|<cardId>'  — one card on one resource swim lane
//   'g|<resourceId>'           — collapsed-group aggregate bar
const SYNTH_TASK_PREFIX = 't|'
const SYNTH_GROUP_PREFIX = 'g|'

const buildTaskSynthId = (resourceId: string, cardId: string) => SYNTH_TASK_PREFIX + resourceId + '|' + cardId
const buildGroupSynthId = (resourceId: string) => SYNTH_GROUP_PREFIX + resourceId

const isGroupSynth = (s: string): boolean => s.startsWith(SYNTH_GROUP_PREFIX)

const cardIdFromTaskSynth = (s: string): string => {
    if (!s.startsWith(SYNTH_TASK_PREFIX)) {
        return ''
    }
    const rest = s.slice(SYNTH_TASK_PREFIX.length)
    const idx = rest.indexOf('|')
    return idx === -1 ? rest : rest.slice(idx + 1)
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
    const options = colorProperty.options || []
    const option = options.find((o) => o.id === raw)
    if (!option || !option.color) {
        return ''
    }
    return `gantt-bar-color-${option.color}`
}

function isReadonlyResourceProperty(propType: string): boolean {
    return propType === 'createdBy' || propType === 'updatedBy'
}

function isMultiResourceProperty(propType: string): boolean {
    return propType === 'multiPerson' || propType === 'multiPersonNotify' || propType === 'multiSelect'
}

function isPersonResourceProperty(propType: string): boolean {
    return propType === 'person' ||
        propType === 'multiPerson' ||
        propType === 'personNotify' ||
        propType === 'multiPersonNotify' ||
        propType === 'createdBy' ||
        propType === 'updatedBy'
}

// resourceLabel resolves a swim-lane id to the human-readable label
// shown in the side panel. Dispatches by property type:
//   - person family: lookup against boardUsers (username / email / id)
//   - select / multiSelect: lookup against the property's options
//   - synthetic UNASSIGNED_RESOURCE_ID: localized "Unassigned"
// Falls back to the raw id for any value we can't resolve, so
// deactivated users / removed select options stay visible rather than
// disappearing.
function resourceLabel(
    resourceId: string,
    prop: IPropertyTemplate,
    users: {[id: string]: IUser},
    intl: ReturnType<typeof useIntl>,
): string {
    if (resourceId === UNASSIGNED_RESOURCE_ID) {
        return intl.formatMessage({id: 'ResourceView.unassigned', defaultMessage: 'Unassigned'})
    }
    if (prop.type === 'select' || prop.type === 'multiSelect') {
        // Defensive `|| []` — boards created before the option array was
        // a hard requirement on the schema can ship a select property
        // with `options` literally undefined / null, and `.find()` on
        // that crashed the entire view. Falls back to the raw id.
        const options = prop.options || []
        const opt = options.find((o) => o.id === resourceId)
        return opt ? opt.value : resourceId
    }
    if (isPersonResourceProperty(prop.type)) {
        const u = users[resourceId]
        if (!u) {
            return resourceId
        }
        return u.username || u.email || resourceId
    }
    return resourceId
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart <= bEnd && bStart <= aEnd
}

// Render the value of a single card property as a human-readable string
// for the popup. Mirrored from ganttView.tsx so both views' popups share
// the same formatting rules — option ids resolve to labels, person ids
// to usernames, task ids to titles, dates to locale strings.
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
    case 'multiSelect': {
        const options = template.options || []
        return arrify(raw).map((id) => options.find((o) => o.id === id)?.value || id).join(', ')
    }
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

// One physical row for the side panel and one bar for the chart.
type RenderRow =
    | {
        kind: 'task'
        synthId: string
        resourceId: string
        resourceLabel: string
        isFirstOfGroup: boolean
        groupCollapsed: boolean
        card: Card
        startMs: number
        endMs: number
        progress: number
        colorClass: string
        conflict: boolean
    }
    | {
        kind: 'group'
        synthId: string
        resourceId: string
        resourceLabel: string
        isFirstOfGroup: true
        groupCollapsed: true
        startMs: number
        endMs: number
        progress: number
        cardCount: number
        totalDays: number
    }

const ResourceView = (props: Props): JSX.Element|null => {
    const {board, cards, activeView, dateDisplayProperty, readonly, showCard} = props
    const intl = useIntl()
    const dispatch = useAppDispatch()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const ganttRef = useRef<InstanceType<typeof GanttImport> | null>(null)
    const sidePanelInnerRef = useRef<HTMLDivElement | null>(null)
    const builtSignatureRef = useRef<string>('')
    // Tracks the readonly state the live chart was built with. frappe-gantt
    // doesn't expose a way to flip its `readonly` option after construction,
    // so this is the one config change that genuinely needs a teardown +
    // rebuild — every other update goes through the refresh /
    // incremental-sync paths and preserves the chart instance.
    const builtEditableRef = useRef<boolean | null>(null)
    const pendingDragRef = useRef<{synthId: string, start: Date, end: Date} | null>(null)

    // Drag-to-reassign state.
    const dragSourceRef = useRef<{synthId: string, sourceResourceId: string, cardId: string, isResize: boolean} | null>(null)
    const pointerYRef = useRef<number | null>(null)
    const [hoverResourceId, setHoverResourceId] = useState<string | null>(null)

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

    const canReassign = !readonly && Boolean(resourceProperty) &&
        !isReadonlyResourceProperty(resourceProperty!.type)

    const collapsedSet = useMemo<Set<string>>(() => (
        new Set(activeView.fields.collapsedOptionIds || [])
    ), [activeView.fields.collapsedOptionIds])

    const boardUsers = useAppSelector<{[id: string]: IUser}>(getBoardUsers)
    const cardsRef = useRef<Card[]>(cards)
    const boardUsersRef = useRef<{[id: string]: IUser}>(boardUsers)
    const showCardRef = useRef(showCard)
    cardsRef.current = cards
    boardUsersRef.current = boardUsers
    showCardRef.current = showCard

    // Visible properties from the view config, minus the title (the bar
    // already shows the title) and the synthetic badges column. These
    // drive the rendered side-panel property columns alongside the
    // resource label column.
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

    // Live overrides for column widths during an active resize drag.
    // Stored here means the dispatched view update doesn't have to
    // round-trip before the cell renders the in-flight width.
    const [liveColumnWidths, setLiveColumnWidths] = useState<Record<string, number>>({})

    const getStoredColumnWidth = useCallback((id: string): number => {
        const stored = activeView.fields.columnWidths?.[id]
        if (stored && stored > 0) {
            return stored
        }
        return id === RESOURCE_COLUMN_KEY ? DEFAULT_RESOURCE_COLUMN_WIDTH : DEFAULT_PROPERTY_COLUMN_WIDTH
    }, [activeView.fields.columnWidths])

    const getEffectiveColumnWidth = useCallback((id: string): number => {
        const live = liveColumnWidths[id]
        return live !== undefined ? live : getStoredColumnWidth(id)
    }, [liveColumnWidths, getStoredColumnWidth])

    const startColumnResize = useCallback((event: React.PointerEvent<HTMLDivElement>, columnId: string) => {
        if (event.button !== undefined && event.button !== 0) {
            return
        }
        event.preventDefault()
        event.stopPropagation()

        const startX = event.clientX
        const startWidth = getEffectiveColumnWidth(columnId)

        const computeWidth = (clientX: number): number =>
            Math.max(MIN_COLUMN_WIDTH, startWidth + (clientX - startX))

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
        document.body.style.userSelect = 'none'
    }, [activeView, board.id, dispatch, getEffectiveColumnWidth])

    const toggleGroupCollapsed = useCallback((resourceId: string) => {
        const oldCollapsed = activeView.fields.collapsedOptionIds || []
        const isCurrentlyCollapsed = oldCollapsed.includes(resourceId)
        const next = isCurrentlyCollapsed ?
            oldCollapsed.filter((id) => id !== resourceId) :
            [...oldCollapsed, resourceId]
        mutator.changeViewCollapsedOptionIds(activeView.boardId, activeView.id, oldCollapsed, next)
    }, [activeView])

    type Tuple = {
        resourceId: string
        resourceLabel: string
        card: Card
        startMs: number
        endMs: number
        progress: number
        colorClass: string
    }
    const tuples = useMemo<Tuple[]>(() => {
        if (!dateDisplayProperty || !resourceProperty) {
            return []
        }
        const dateProp = propsRegistry.get(dateDisplayProperty.type)
        if (!(dateProp instanceof DatePropertyType)) {
            return []
        }

        const built: Tuple[] = []
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
                    resourceId,
                    resourceLabel: resourceLabel(resourceId, resourceProperty, boardUsers, intl),
                    card,
                    startMs,
                    endMs,
                    progress,
                    colorClass,
                })
            }
        }

        built.sort((a, b) => {
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

        return built
    }, [cards, dateDisplayProperty, resourceProperty, progressProperty, colorProperty, boardUsers, intl])

    const conflictingTupleIdx = useMemo<Set<number>>(() => {
        const conflicts = new Set<number>()
        let groupStart = 0
        for (let i = 0; i <= tuples.length; i++) {
            const atEnd = i === tuples.length
            const sameAsPrev = !atEnd && tuples[i].resourceId === tuples[groupStart].resourceId
            if (atEnd || !sameAsPrev) {
                for (let a = groupStart; a < i; a++) {
                    for (let b = a + 1; b < i; b++) {
                        if (rangesOverlap(tuples[a].startMs, tuples[a].endMs, tuples[b].startMs, tuples[b].endMs)) {
                            conflicts.add(a)
                            conflicts.add(b)
                        }
                    }
                }
                groupStart = i
            }
        }
        return conflicts
    }, [tuples])

    const renderRows = useMemo<RenderRow[]>(() => {
        const rows: RenderRow[] = []
        let i = 0
        while (i < tuples.length) {
            const groupResourceId = tuples[i].resourceId
            let j = i + 1
            while (j < tuples.length && tuples[j].resourceId === groupResourceId) {
                j++
            }
            const isCollapsed = collapsedSet.has(groupResourceId)
            if (isCollapsed) {
                let minStart = Infinity
                let maxEnd = -Infinity
                let progressSum = 0
                let totalDays = 0
                const dayMs = 24 * 60 * 60 * 1000
                for (let k = i; k < j; k++) {
                    const t = tuples[k]
                    if (t.startMs < minStart) {
                        minStart = t.startMs
                    }
                    if (t.endMs > maxEnd) {
                        maxEnd = t.endMs
                    }
                    progressSum += t.progress
                    totalDays += Math.max(1, Math.round((t.endMs - t.startMs) / dayMs) + 1)
                }
                const cardCount = j - i
                rows.push({
                    kind: 'group',
                    synthId: buildGroupSynthId(groupResourceId),
                    resourceId: groupResourceId,
                    resourceLabel: tuples[i].resourceLabel,
                    isFirstOfGroup: true,
                    groupCollapsed: true,
                    startMs: minStart,
                    endMs: maxEnd,
                    progress: cardCount === 0 ? 0 : Math.round(progressSum / cardCount),
                    cardCount,
                    totalDays,
                })
            } else {
                for (let k = i; k < j; k++) {
                    const t = tuples[k]
                    rows.push({
                        kind: 'task',
                        synthId: buildTaskSynthId(t.resourceId, t.card.id),
                        resourceId: t.resourceId,
                        resourceLabel: t.resourceLabel,
                        isFirstOfGroup: k === i,
                        groupCollapsed: false,
                        card: t.card,
                        startMs: t.startMs,
                        endMs: t.endMs,
                        progress: t.progress,
                        colorClass: t.colorClass,
                        conflict: conflictingTupleIdx.has(k),
                    })
                }
            }
            i = j
        }
        return rows
    }, [tuples, conflictingTupleIdx, collapsedSet])

    const renderRowsRef = useRef<RenderRow[]>(renderRows)
    renderRowsRef.current = renderRows

    // The full set of desired classes per bar id. Computed alongside
    // ganttTasks because frappe-gantt's `task.custom_class` can only
    // hold a SINGLE token — its `bar.refresh()` does
    // `classList.add(custom_class)`, and DOMTokenList.add throws
    // `InvalidCharacterError` if the token contains whitespace. Stuffing
    // multiple classes ("gantt-bar-color-X gantt-bar-conflict") into
    // custom_class crashed the entire chart on initial render with a
    // colored conflict. We therefore pass only the primary class
    // (color, or "gantt-bar-group" for collapsed groups) through
    // custom_class and reconcile the rest of the desired classes via
    // the DOM walk in the incremental-sync effect.
    const desiredClassesByBar = useMemo<Map<string, string[]>>(() => {
        const map = new Map<string, string[]>()
        for (const row of renderRows) {
            const classes: string[] = []
            if (row.kind === 'task') {
                if (row.colorClass) {
                    classes.push(row.colorClass)
                }
                if (row.conflict) {
                    classes.push('gantt-bar-conflict')
                }
            } else {
                classes.push('gantt-bar-group')
            }
            if (classes.length > 0) {
                map.set(row.synthId, classes)
            }
        }
        return map
    }, [renderRows])

    const desiredClassesByBarRef = useRef<Map<string, string[]>>(desiredClassesByBar)
    desiredClassesByBarRef.current = desiredClassesByBar

    const ganttTasks = useMemo<GanttTask[]>(() => {
        return renderRows.map((row) => {
            // Single-token custom_class only (see desiredClassesByBar
            // comment). Pick the most "structural" class — color for
            // task rows so the initial paint isn't naked, and the
            // group-marker for collapsed rows.
            let primaryClass: string | undefined
            if (row.kind === 'task') {
                primaryClass = row.colorClass || undefined
            } else {
                primaryClass = 'gantt-bar-group'
            }
            if (row.kind === 'task') {
                const icon = row.card.fields?.icon
                const baseTitle = row.card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
                return {
                    id: row.synthId,
                    name: icon ? `${icon} ${baseTitle}` : baseTitle,
                    start: formatYMD(new Date(row.startMs)),
                    end: formatYMD(new Date(row.endMs)),
                    progress: row.progress,
                    custom_class: primaryClass,
                }
            }
            return {
                id: row.synthId,
                name: row.resourceLabel + ' · ' + intl.formatMessage(
                    {id: 'ResourceView.group-bar-name', defaultMessage: '{count, plural, one {# task} other {# tasks}}'},
                    {count: row.cardCount},
                ),
                start: formatYMD(new Date(row.startMs)),
                end: formatYMD(new Date(row.endMs)),
                progress: row.progress,
                custom_class: primaryClass,
            }
        })
    }, [renderRows, intl])

    // Structural signature drives the chart-instance refresh path. We
    // *deliberately* exclude `custom_class` here so that tagging a bar
    // with `gantt-bar-conflict` (or swapping its `Color by` class) does
    // NOT trigger a refresh — those classes are reconciled directly on
    // the DOM by the incremental-sync effect below. Including
    // custom_class would force a flash + scroll-reset every time a
    // conflict appeared or disappeared.
    const structuralSignature = useMemo(() => (
        ganttTasks.map((t) => t.id).join(';')
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

    // Build / refresh the chart based on the current task list and
    // editability. Everything is dispatched from a single effect so the
    // logic stays linear; no cleanup callback because tear-down on dep
    // change is exactly what we're trying to avoid (it produced the
    // flash-on-collapse the user was hitting). Mount/unmount cleanup is
    // handled by the dedicated empty-deps effect below.
    useEffect(() => {
        const el = containerRef.current
        if (!el) {
            return
        }

        // Editability flip → must teardown so the rebuild branch picks
        // up the new `readonly` constructor option. frappe-gantt has no
        // setter for it.
        const editableFlipped = builtEditableRef.current !== null && builtEditableRef.current !== isEditable
        if (editableFlipped && ganttRef.current) {
            el.innerHTML = ''
            ganttRef.current = null
            builtSignatureRef.current = ''
            builtEditableRef.current = null
        }

        if (ganttTasks.length === 0) {
            if (ganttRef.current) {
                el.innerHTML = ''
                ganttRef.current = null
                builtSignatureRef.current = ''
                builtEditableRef.current = null
            }
            return
        }

        if (ganttRef.current && structuralSignature === builtSignatureRef.current) {
            return
        }

        if (ganttRef.current) {
            // Refresh path: same instance, same handlers, new task set.
            // Save/restore scroll positions and suppress the
            // "scroll to today" auto behavior so the user's viewport
            // stays put when a group is collapsed/expanded or a card
            // gets reassigned.
            const inner = el.querySelector('.gantt-container') as HTMLElement | null
            const prevScrollLeft = inner?.scrollLeft ?? 0
            const prevScrollTop = inner?.scrollTop ?? 0
            const ganttAny = ganttRef.current as any
            const prevScrollTo = ganttAny.options?.scroll_to
            if (ganttAny.options) {
                ganttAny.options.scroll_to = ''
            }
            try {
                ganttAny.refresh(ganttTasks)
            } catch {
                // Refresh failed — fall back to a full teardown; the
                // next render cycle will rebuild from scratch.
                el.innerHTML = ''
                ganttRef.current = null
                builtSignatureRef.current = ''
                builtEditableRef.current = null
                return
            }
            if (ganttAny.options) {
                ganttAny.options.scroll_to = prevScrollTo
            }
            builtSignatureRef.current = structuralSignature

            const newInner = el.querySelector('.gantt-container') as HTMLElement | null
            if (newInner) {
                newInner.scrollLeft = prevScrollLeft
                newInner.scrollTop = prevScrollTop
            }
            if (newInner && sidePanelInnerRef.current) {
                sidePanelInnerRef.current.style.transform = `translateY(${-(newInner.scrollTop || 0)}px)`
            }
            return
        }

        // Build path: fresh chart instance.
        const Ctor = resolveGanttCtor()
        if (!Ctor) {
            return
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
                const liveUsers = boardUsersRef.current
                if (isGroupSynth(task.id)) {
                    const groupResourceId = task.id.slice(SYNTH_GROUP_PREFIX.length)
                    add_action(
                        intl.formatMessage({id: 'ResourceView.popup-expand', defaultMessage: 'Expand group'}),
                        () => toggleGroupCollapsed(groupResourceId),
                    )
                    return (
                        `<div class="GanttPopup">` +
                        `<div class="GanttPopup__title">${escapeHtml(task.name || '')}</div>` +
                        `</div>`
                    )
                }
                const cardId = cardIdFromTaskSynth(task.id)
                const card = liveCards.find((c) => c.id === cardId)
                if (!card) {
                    return `<div class="GanttPopup"><div class="GanttPopup__title">${escapeHtml(task.name || '')}</div></div>`
                }

                const cardsById = new Map<string, Card>(liveCards.map((c) => [c.id, c]))
                const titleText = card.title || intl.formatMessage({id: 'CalendarCard.untitled', defaultMessage: 'Untitled'})
                const titleHtml = `${card.fields?.icon ? escapeHtml(card.fields.icon) + ' ' : ''}${escapeHtml(titleText)}`

                // Render every property that has a non-empty value —
                // mirrors the Timeline view's popup so users get a
                // consistent at-a-glance card summary across both views.
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
                    intl.formatMessage({id: 'ResourceView.popup-open', defaultMessage: 'Open task'}),
                    () => showCardRef.current(cardId),
                )

                return (
                    `<div class="GanttPopup">` +
                    `<div class="GanttPopup__title">${titleHtml}</div>` +
                    (rows.length > 0 ? `<div class="GanttPopup__rows">${rows.join('')}</div>` : '') +
                    `</div>`
                )
            },
            on_click: () => {},
            on_double_click: (task) => {
                if (isGroupSynth(task.id)) {
                    toggleGroupCollapsed(task.id.slice(SYNTH_GROUP_PREFIX.length))
                    return
                }
                showCard(cardIdFromTaskSynth(task.id))
            },
            on_date_change: (task, start, end) => {
                if (isGroupSynth(task.id)) {
                    pendingDragRef.current = null
                    return
                }
                pendingDragRef.current = {synthId: task.id, start, end}
            },
        })
        ganttRef.current = gantt
        builtSignatureRef.current = structuralSignature
        builtEditableRef.current = isEditable

        const newInner = el.querySelector('.gantt-container') as HTMLElement | null
        if (newInner && (prevScrollLeft || prevScrollTop)) {
            newInner.scrollLeft = prevScrollLeft
            newInner.scrollTop = prevScrollTop
        }
        if (newInner && sidePanelInnerRef.current) {
            sidePanelInnerRef.current.style.transform = `translateY(${-(newInner.scrollTop || 0)}px)`
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ganttTasks, structuralSignature, isEditable])

    // Mount/unmount-only cleanup so the DOM is reclaimed when the user
    // navigates away from the view. Separate effect so the main one
    // above can avoid running cleanup on dep change.
    useEffect(() => {
        return () => {
            const el = containerRef.current
            if (el) {
                el.innerHTML = ''
            }
            ganttRef.current = null
            builtSignatureRef.current = ''
            builtEditableRef.current = null
        }
    }, [])

    // Incremental sync: applies date / name / progress updates and
    // reconciles per-bar custom classes (color, conflict, group)
    // without rebuilding or refreshing. Runs whenever ganttTasks
    // changes; skips the dragging bar so frappe-gantt's drag handler
    // isn't pulled out from under the user.
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
                // update_task throws on unknown ids; the next refresh
                // will reconcile.
            }
        }

        const chartEl = containerRef.current
        if (!chartEl) {
            return
        }
        const wrappers = chartEl.querySelectorAll<HTMLElement>('.bar-wrapper')
        wrappers.forEach((w) => {
            const id = w.getAttribute('data-id') || ''
            // Source of truth for *every* desired class on the wrapper —
            // not the single-token primary class on `t.custom_class`.
            // Lets us layer conflict over color without tripping
            // DOMTokenList.add's whitespace check.
            const desired = new Set(desiredClassesByBar.get(id) || [])
            const toRemove: string[] = []
            w.classList.forEach((cls) => {
                if (cls.startsWith('gantt-bar-') && !desired.has(cls)) {
                    toRemove.push(cls)
                }
            })
            toRemove.forEach((cls) => w.classList.remove(cls))
            desired.forEach((cls) => w.classList.add(cls))
        })
    }, [ganttTasks, structuralSignature, desiredClassesByBar])

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

    const computeTargetResourceId = useCallback((clientY: number): string | null => {
        const panelEl = sidePanelInnerRef.current
        if (!panelEl) {
            return null
        }
        const panelRect = panelEl.getBoundingClientRect()
        const relativeY = clientY - panelRect.top
        if (relativeY < 0) {
            return null
        }
        const rowIndex = Math.floor(relativeY / ROW_HEIGHT)
        const rows = renderRowsRef.current
        if (rowIndex < 0 || rowIndex >= rows.length) {
            return null
        }
        return rows[rowIndex].resourceId
    }, [])

    useEffect(() => {
        const el = containerRef.current
        if (!el) {
            return undefined
        }
        const onDown = (e: PointerEvent) => {
            const target = e.target as Element | null
            if (!target) {
                dragSourceRef.current = null
                return
            }
            const wrapper = target.closest('.bar-wrapper') as Element | null
            if (!wrapper) {
                dragSourceRef.current = null
                return
            }
            const synthId = wrapper.getAttribute('data-id') || ''
            if (!synthId) {
                dragSourceRef.current = null
                return
            }
            if (isGroupSynth(synthId)) {
                dragSourceRef.current = null
                return
            }
            const isResize = (target as Element).classList.contains('handle')
            const rest = synthId.slice(SYNTH_TASK_PREFIX.length)
            const idx = rest.indexOf('|')
            if (idx === -1) {
                dragSourceRef.current = null
                return
            }
            dragSourceRef.current = {
                synthId,
                sourceResourceId: rest.slice(0, idx),
                cardId: rest.slice(idx + 1),
                isResize,
            }
            pointerYRef.current = e.clientY
        }
        const onMove = (e: PointerEvent) => {
            if (!dragSourceRef.current) {
                return
            }
            pointerYRef.current = e.clientY
            if (!canReassign || dragSourceRef.current.isResize) {
                return
            }
            const target = computeTargetResourceId(e.clientY)
            const next = target && target !== dragSourceRef.current.sourceResourceId ? target : null
            setHoverResourceId((prev) => (prev === next ? prev : next))
        }
        el.addEventListener('pointerdown', onDown)
        document.addEventListener('pointermove', onMove)
        return () => {
            el.removeEventListener('pointerdown', onDown)
            document.removeEventListener('pointermove', onMove)
        }
    }, [canReassign, computeTargetResourceId])

    const buildReassignThunk = useCallback((
        card: Card,
        oldResourceId: string,
        newResourceId: string,
    ): (() => Promise<void>) | null => {
        if (!resourceProperty) {
            return null
        }
        if (oldResourceId === newResourceId) {
            return null
        }
        const propType = resourceProperty.type
        if (isReadonlyResourceProperty(propType)) {
            return null
        }

        if (isMultiResourceProperty(propType)) {
            const current = card.fields.properties[resourceProperty.id]
            const arr: string[] = Array.isArray(current) ?
                (current as unknown[]).filter((x): x is string => typeof x === 'string').slice() :
                (typeof current === 'string' && current ? [current] : [])
            if (oldResourceId !== UNASSIGNED_RESOURCE_ID) {
                const idx = arr.indexOf(oldResourceId)
                if (idx >= 0) {
                    arr.splice(idx, 1)
                }
            }
            if (newResourceId !== UNASSIGNED_RESOURCE_ID && !arr.includes(newResourceId)) {
                arr.push(newResourceId)
            }
            const before = current
            const beforeArr: string[] = Array.isArray(before) ?
                (before as unknown[]).filter((x): x is string => typeof x === 'string') :
                (typeof before === 'string' && before ? [before] : [])
            if (beforeArr.length === arr.length && beforeArr.every((v, i) => v === arr[i])) {
                return null
            }
            return async () => {
                await mutator.changePropertyValue(board.id, card, resourceProperty.id, arr)
            }
        }

        const newVal = newResourceId === UNASSIGNED_RESOURCE_ID ? '' : newResourceId
        const before = card.fields.properties[resourceProperty.id]
        if (typeof before === 'string' && before === newVal) {
            return null
        }
        return async () => {
            await mutator.changePropertyValue(board.id, card, resourceProperty.id, newVal)
        }
    }, [board.id, resourceProperty])

    const commitDrag = useCallback(() => {
        const pending = pendingDragRef.current
        const source = dragSourceRef.current
        const pointerY = pointerYRef.current
        pendingDragRef.current = null
        dragSourceRef.current = null
        pointerYRef.current = null
        setHoverResourceId(null)

        if (!source && !pending) {
            return
        }
        const cardId = source?.cardId || (pending ? cardIdFromTaskSynth(pending.synthId) : '')
        if (!cardId) {
            return
        }
        const card = cardsRef.current.find((c) => c.id === cardId)
        if (!card) {
            return
        }

        let dateThunk: (() => Promise<void>) | null = null
        if (pending && dateDisplayProperty) {
            const dateProp = propsRegistry.get(dateDisplayProperty.type)
            if (dateProp instanceof DatePropertyType) {
                const draggedRaw = card.fields.properties[dateDisplayProperty.id]
                const newProp = createDatePropertyFromGanttDates(pending.start, pending.end)
                if (!isSameDateValue(draggedRaw, newProp)) {
                    dateThunk = async () => {
                        await mutator.changePropertyValue(
                            board.id,
                            card,
                            dateDisplayProperty.id,
                            JSON.stringify(newProp),
                        )
                    }
                }
            }
        }

        let reassignThunk: (() => Promise<void>) | null = null
        if (source && !source.isResize && canReassign && pointerY !== null) {
            const targetResourceId = computeTargetResourceId(pointerY)
            if (targetResourceId && targetResourceId !== source.sourceResourceId) {
                reassignThunk = buildReassignThunk(card, source.sourceResourceId, targetResourceId)
            }
        }

        if (!dateThunk && !reassignThunk) {
            return
        }
        mutator.performAsUndoGroup(async () => {
            if (dateThunk) {
                await dateThunk()
            }
            if (reassignThunk) {
                await reassignThunk()
            }
        })
    }, [board.id, dateDisplayProperty, canReassign, computeTargetResourceId, buildReassignThunk])

    useEffect(() => {
        const flush = () => {
            commitDrag()
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
    }, [commitDrag])

    if (!resourceProperty) {
        return (
            <div className='ResourceContainer ResourceContainer--empty'>
                {intl.formatMessage({
                    id: 'ResourceView.no-resource-property',
                    defaultMessage: 'Pick a person, multi-person, or select property in "Resources by" to populate this view.',
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

    if (renderRows.length === 0) {
        return (
            <div className='ResourceContainer ResourceContainer--empty'>
                {intl.formatMessage({
                    id: 'ResourceView.no-cards',
                    defaultMessage: 'No cards have a value for this date property yet.',
                })}
            </div>
        )
    }

    const summaryByResource = new Map<string, {count: number, totalDays: number}>()
    {
        const dayMs = 24 * 60 * 60 * 1000
        for (const t of tuples) {
            const days = Math.max(1, Math.round((t.endMs - t.startMs) / dayMs) + 1)
            const cur = summaryByResource.get(t.resourceId) || {count: 0, totalDays: 0}
            cur.count += 1
            cur.totalDays += days
            summaryByResource.set(t.resourceId, cur)
        }
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
                            style={{width: getEffectiveColumnWidth(RESOURCE_COLUMN_KEY)}}
                            title={resourceProperty.name}
                        >
                            <span className='ResourceContainer__props-cell-text'>{resourceProperty.name}</span>
                            <div
                                className='ResourceContainer__props-grip'
                                onPointerDown={(e) => startColumnResize(e, RESOURCE_COLUMN_KEY)}
                                role='separator'
                                aria-label={intl.formatMessage({id: 'ResourceView.resize-column', defaultMessage: 'Resize column'})}
                            />
                        </div>
                        {sidePropertyTemplates.map((p) => (
                            <div
                                key={p.id}
                                className='ResourceContainer__props-cell ResourceContainer__props-cell--header'
                                style={{width: getEffectiveColumnWidth(p.id)}}
                                title={p.name}
                            >
                                <span className='ResourceContainer__props-cell-text'>{p.name}</span>
                                <div
                                    className='ResourceContainer__props-grip'
                                    onPointerDown={(e) => startColumnResize(e, p.id)}
                                    role='separator'
                                    aria-label={intl.formatMessage({id: 'ResourceView.resize-column', defaultMessage: 'Resize column'})}
                                />
                            </div>
                        ))}
                    </div>
                    <div className='ResourceContainer__props-body'>
                        <div
                            ref={sidePanelInnerRef}
                            className='ResourceContainer__props-body-inner'
                        >
                            {renderRows.map((row) => {
                                const summary = summaryByResource.get(row.resourceId)
                                const isDropTarget = canReassign && hoverResourceId === row.resourceId
                                const collapsed = row.groupCollapsed
                                const rowClasses = [
                                    'ResourceContainer__props-row',
                                    row.isFirstOfGroup ? 'ResourceContainer__props-row--first' : '',
                                    isDropTarget ? 'ResourceContainer__props-row--drop-target' : '',
                                    collapsed ? 'ResourceContainer__props-row--collapsed' : '',
                                ].filter(Boolean).join(' ')
                                const card = row.kind === 'task' ? row.card : null
                                return (
                                    <div
                                        key={row.synthId}
                                        className={rowClasses}
                                        style={{height: ROW_HEIGHT}}
                                        data-resource-id={row.resourceId}
                                    >
                                        <div
                                            className='ResourceContainer__props-cell'
                                            style={{width: getEffectiveColumnWidth(RESOURCE_COLUMN_KEY)}}
                                        >
                                            {row.isFirstOfGroup && (
                                                <div className='ResourceContainer__resource-cell'>
                                                    <button
                                                        type='button'
                                                        className='ResourceContainer__chevron'
                                                        onClick={() => toggleGroupCollapsed(row.resourceId)}
                                                        title={intl.formatMessage(
                                                            collapsed ?
                                                                {id: 'ResourceView.expand', defaultMessage: 'Expand'} :
                                                                {id: 'ResourceView.collapse', defaultMessage: 'Collapse'},
                                                        )}
                                                        aria-label={intl.formatMessage(
                                                            collapsed ?
                                                                {id: 'ResourceView.expand', defaultMessage: 'Expand'} :
                                                                {id: 'ResourceView.collapse', defaultMessage: 'Collapse'},
                                                        )}
                                                    >
                                                        {collapsed ? <ChevronRight/> : <ChevronDown/>}
                                                    </button>
                                                    <div className='ResourceContainer__resource-text'>
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
                                                </div>
                                            )}
                                        </div>
                                        {sidePropertyTemplates.map((p) => (
                                            <div
                                                key={p.id}
                                                className='ResourceContainer__props-cell'
                                                style={{width: getEffectiveColumnWidth(p.id)}}
                                            >
                                                {card && (
                                                    <PropertyValueElement
                                                        board={board}
                                                        card={card}
                                                        propertyTemplate={p}
                                                        readOnly={true}
                                                        showEmptyPlaceholder={false}
                                                    />
                                                )}
                                            </div>
                                        ))}
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
