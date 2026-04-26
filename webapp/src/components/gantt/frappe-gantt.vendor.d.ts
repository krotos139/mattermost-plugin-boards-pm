// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Type shim for the vendored frappe-gantt ES bundle. Re-exports the same
// surface declared in webapp/src/types/frappe-gantt.d.ts.
import Gantt, {GanttTask, GanttOptions, GanttViewMode} from 'frappe-gantt'

export default Gantt
export {GanttTask, GanttOptions, GanttViewMode}
