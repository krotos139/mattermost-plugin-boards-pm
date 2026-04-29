// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.


import {Block, createBlock} from './block'
import {FilterGroup, createFilterGroup} from './filterGroup'

type IViewType = 'board' | 'table' | 'gallery' | 'calendar' | 'gantt' | 'resource' | 'hierarchy' | 'cfd'

// Hierarchy view: layout direction passed to dagre. Top-bottom mirrors the
// PERT examples in the design doc; LR is handy for very deep trees that
// would otherwise overflow vertically.
type HierarchyLayout = 'TB' | 'LR' | 'BT' | 'RL'

// CFD view: how far back the chart extends. 'all' falls back to the
// earliest history row; 'custom' uses cfdDateFrom/cfdDateTo.
type CFDDateRange = 'last7' | 'last30' | 'last90' | 'last365' | 'all' | 'custom'
type ISortOption = { propertyId: '__title' | string, reversed: boolean }

type KanbanCalculationFields = {
    calculation: string
    propertyId: string
}

type BoardViewFields = {
    viewType: IViewType
    groupById?: string
    dateDisplayPropertyId?: string
    // Gantt view: id of the task/multiTask property that holds the
    // dependency edges drawn between bars.
    linkedByPropertyId?: string
    // Gantt view: id of the number property whose value (0-100) is fed
    // into frappe-gantt's per-bar progress fill.
    progressPropertyId?: string
    // Gantt view: id of a select property whose chosen option's color is
    // applied to the corresponding bar.
    colorPropertyId?: string
    // Resource view: id of the person / multiPerson property whose values
    // are expanded into one swim-lane row per assignee. A card with N
    // assignees produces N rows in the Resource view (one per person);
    // a card with no assignee falls into a synthetic "Unassigned" group.
    resourcePropertyId?: string
    // Hierarchy view: id of the Task / Multi task property that links a
    // child card to its parent card(s). Each value is a card id; a Task
    // value points to one parent, a Multi task value can point to many.
    hierarchyPropertyId?: string
    // Hierarchy view: dagre layout direction (top-bottom by default).
    hierarchyLayout?: HierarchyLayout
    // Hierarchy view: id of a select / multiSelect property whose option
    // color is used to tint each node. Falls back to the option color
    // configured on each select option.
    hierarchyColorPropertyId?: string
    // CFD view: id of the select / multiSelect / person* property the chart
    // groups by. Each option/user becomes one band of the stacked area.
    cfdPropertyId?: string
    // CFD view: rolling-window selector. When 'custom', cfdDateFrom and
    // cfdDateTo specify the range explicitly (epoch ms).
    cfdDateRange?: CFDDateRange
    cfdDateFrom?: number
    cfdDateTo?: number
    // CFD view: option ids / "__none" the user has hidden via the
    // States menu. Bands present in this list are filtered out before
    // the chart is rendered, so the user can keep a focused view on
    // active states (e.g. hide Done so the chart isn't dominated by
    // completed cards piling up at the top).
    cfdHiddenSeriesKeys?: string[]
    sortOptions: ISortOption[]
    visiblePropertyIds: string[]
    visibleOptionIds: string[]
    hiddenOptionIds: string[]
    collapsedOptionIds: string[]
    filter: FilterGroup
    cardOrder: string[]
    columnWidths: Record<string, number>
    columnCalculations: Record<string, string>
    kanbanCalculations: Record<string, KanbanCalculationFields>
    defaultTemplateId: string
}

type BoardView = Block & {
    fields: BoardViewFields
}

function createBoardView(block?: Block): BoardView {
    return {
        ...createBlock(block),
        type: 'view',
        fields: {
            viewType: block?.fields.viewType || 'board',
            groupById: block?.fields.groupById,
            dateDisplayPropertyId: block?.fields.dateDisplayPropertyId,
            linkedByPropertyId: block?.fields.linkedByPropertyId,
            progressPropertyId: block?.fields.progressPropertyId,
            colorPropertyId: block?.fields.colorPropertyId,
            resourcePropertyId: block?.fields.resourcePropertyId,
            hierarchyPropertyId: block?.fields.hierarchyPropertyId,
            hierarchyLayout: block?.fields.hierarchyLayout,
            hierarchyColorPropertyId: block?.fields.hierarchyColorPropertyId,
            cfdPropertyId: block?.fields.cfdPropertyId,
            cfdDateRange: block?.fields.cfdDateRange,
            cfdDateFrom: block?.fields.cfdDateFrom,
            cfdDateTo: block?.fields.cfdDateTo,
            cfdHiddenSeriesKeys: block?.fields.cfdHiddenSeriesKeys?.slice(),
            sortOptions: block?.fields.sortOptions?.map((o: ISortOption) => ({...o})) || [],
            visiblePropertyIds: block?.fields.visiblePropertyIds?.slice() || [],
            visibleOptionIds: block?.fields.visibleOptionIds?.slice() || [],
            hiddenOptionIds: block?.fields.hiddenOptionIds?.slice() || [],
            collapsedOptionIds: block?.fields.collapsedOptionIds?.slice() || [],
            filter: createFilterGroup(block?.fields.filter),
            cardOrder: block?.fields.cardOrder?.slice() || [],
            columnWidths: {...(block?.fields.columnWidths || {})},
            columnCalculations: {...(block?.fields.columnCalculations) || {}},
            kanbanCalculations: {...(block?.fields.kanbanCalculations) || {}},
            defaultTemplateId: block?.fields.defaultTemplateId || '',
        },
    }
}

function sortBoardViewsAlphabetically(views: BoardView[]): BoardView[] {
    // Strip leading emoji to prevent unintuitive results
    return views.map((v) => {
        return {view: v, title: v.title.replace(/^\p{Emoji}*\s*/u, '')}
    }).sort((v1, v2) => v1.title.localeCompare(v2.title)).map((v) => v.view)
}

export {BoardView, IViewType, ISortOption, HierarchyLayout, CFDDateRange, sortBoardViewsAlphabetically, createBoardView, KanbanCalculationFields}
