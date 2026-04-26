// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// frappe-gantt ships without TypeScript declarations. This is the minimal
// surface we use — the full API is documented at
// https://github.com/frappe/gantt.
declare module 'frappe-gantt' {
    export interface GanttTask {
        id: string
        name: string
        start: string | Date
        end: string | Date
        progress?: number
        dependencies?: string
        custom_class?: string
    }

    export type GanttViewMode = 'Quarter Day' | 'Half Day' | 'Day' | 'Week' | 'Month' | 'Year' | string

    export interface GanttOptions {
        view_mode?: GanttViewMode
        view_mode_select?: boolean
        date_format?: string
        bar_height?: number
        padding?: number
        column_width?: number
        readonly?: boolean
        readonly_progress?: boolean
        readonly_dates?: boolean
        infinite_padding?: boolean
        scroll_to?: 'today' | 'start' | 'end' | string
        today_button?: boolean
        language?: string
        popup?: ((ctx: {
            task: GanttTask
            chart: any
            get_title: () => HTMLElement
            set_title: (html: string) => void
            get_subtitle: () => HTMLElement
            set_subtitle: (html: string) => void
            get_details: () => HTMLElement
            set_details: (html: string) => void
            add_action: (html: string | ((task: GanttTask) => string), func: (task: GanttTask, chart: any, e: Event) => void) => void
        }) => string | false | undefined) | false
        on_click?: (task: GanttTask) => void
        on_double_click?: (task: GanttTask) => void
        on_date_change?: (task: GanttTask, start: Date, end: Date) => void
        on_progress_change?: (task: GanttTask, progress: number) => void
        on_view_change?: (mode: GanttViewMode) => void
    }

    export default class Gantt {
        constructor(wrapper: HTMLElement | string, tasks: GanttTask[], options?: GanttOptions)
        refresh(tasks: GanttTask[]): void
        update_options(options: GanttOptions): void
        update_task(id: string, new_details: Partial<GanttTask>): void
        change_view_mode(mode: GanttViewMode, maintain_pos?: boolean): void
        scroll_current(): void
    }
}
