# mattermost-plugin-boards-pm

Project-management fork of [mattermost-plugin-boards](https://github.com/mattermost/mattermost-plugin-boards) (Focalboard). Same plugin id (`focalboard`), same data — drop-in replacement that adds extra views, deadlines with reminders, an MCP server for AI agents, and a few mobile UX fixes.

---

## Installation

Plugin id is unchanged, so this build replaces upstream Focalboard without touching the database — boards, cards, comments and history all survive.

1. Grab `boards-*.tar.gz` from [Releases](https://github.com/krotos139/mattermost-plugin-boards-pm/releases).
2. Mattermost: **System Console → Plugin Management → Upload Plugin** → pick the tarball.
3. Enable.

Requires Mattermost 10.7.0+. The deadline ticker, `/boards` slash command and dashboards activate automatically. The MCP server is off by default — see below.

---

## What's added over upstream Focalboard

- **Five extra views**: Timeline (Gantt), Resource (per-assignee swim lanes), Hierarchy (parent→child node graph), CFD (cumulative flow diagram), Scheduler (Schedule-X day/week/month/list/year).
- **Deadline property + DM reminders**, plus `Person (notify)` / `Multi person (notify)` types that DM users when assigned.
- **`Include time` toggle** on Date and Deadline editors — picks `HH:MM` per side of the range; Scheduler view honors it.
- **Dashboard boards** in the sidebar: *My Deadlines* and *All Tasks*, auto-aggregating cross-board.
- **Card extras**: Subtasks content block, per-card History tab, Attachments column, inline image/video blocks.
- **`/boards` slash command** — one-tap mobile open, no re-login.
- **MCP server** for AI agents (Claude Desktop, Cursor, the bundled Mattermost AI Agent) to drive Boards.

---

## Views

**Timeline (Gantt)** — Cards as draggable bars. Pick **Display by** (date prop), **Linked by** (task / multiTask for parent→child arrows), **Progress by** (number 0–100 to fill bar), **Color by** (select option color). Drag bars to reschedule; descendants in the dependency tree shift by the same delta.

**Resource** — Same Gantt layout pivoted by assignee. Each value of **Resources by** (person / multiPerson / select / multiSelect) gets a swim lane; overlapping bars on the same lane are flagged as conflicts. Drag a bar to a different lane to reassign; collapse a lane to a single aggregate bar.

**Hierarchy** — Cards as boxes connected by parent→child edges (defined by a Task / Multi task property). Auto-laid out via dagre; pick rank direction (TB/LR/BT/RL) and an optional Color by.

**CFD (Cumulative Flow Diagram)** — Stacked-area chart over a Select / Person property; one band per option. Pick a date range (last 7/30/90/365 / all / custom) and toggle which states are visible.

**Scheduler** — Time-grid calendar built on [Schedule-X](https://schedule-x.dev) v3.7. Day / Week / Month / Agenda / List sub-views from the library, plus a *Year* mode that shows 12 mini-month grids with one colored dot per unique event color landing on each day. Drag to move, edge-drag to resize, click a day in Year mode to jump back to week view on it. With `Include time` on, events sit in the time-grid at their wall-clock hour.

---

## Properties

**Deadline** — A date with a per-card reminder window (1h / 6h / 1d / 2d / 1w before; default 24h). When the threshold passes, every assigned user (from a `Person (notify)` / `Multi person (notify)` property on the same card) receives a Mattermost DM with a deep link. The card is marked notified once sent — change the deadline value to re-arm.

**Person (notify) / Multi person (notify)** — Like the standard person types, but DM the user the moment they're added. Plain `Person` / `Multi Person` stay quiet. These are also the property types the deadline reminder and `My Deadlines` dashboard scan.

**Task / Multi task** — Stores references to other cards on the same board, by id. `Task` holds one card id, `Multi task` an array. Used by Timeline view to draw parent→child dependency arrows and by Hierarchy view to lay out the node graph. Pick the property under **Linked by** (Timeline) or **Hierarchy by** (Hierarchy) and set values on a parent card to its children.

**Subtasks distribution** — Calculation-only column for boards that use the Subtasks content block. Renders the live `todo / in-progress / done` counts of each card's Subtasks block right in the column. Read-only — there's no editor.

**Include time** — A toggle in the Date / Deadline editor that exposes the existing `includeTime` model field. When on, both `from` and `to` get an `HH:MM` input alongside the date. Other views (Calendar, Gantt, Resource) keep treating values as date-only; only Scheduler uses the time component.

---

## Card extras

**Subtasks block** — Content-block type with a checklist where each row cycles through todo / in-progress / done; the header shows running counts.

**History tab** — Card detail has Comments + History tabs. History lists every property change, title rename, comment add/edit/delete and content-block edit with user, timestamp and before→after. Consecutive same-user same-property edits within 30 minutes coalesce into one entry.

**Attachments + media** — Cards have an Attachments column (download per row) plus inline image / video content blocks. Drag-drop or paste files: `image/*` → image block, `video/*` → video block, anything else → attachment list. Deleting an attachment also frees the underlying file when no other block references it.

---

## Dashboards

**My Deadlines** — Sidebar pin showing every card across all visible boards that has a `Deadline` property AND lists the current user in some `Person (notify)` / `Multi person (notify)` property. Sorted by deadline ascending. Cards using regular `Date` and `Person` won't appear — the dashboard is a deliberate opt-in.

**All Tasks** — Every card the user can see across every board they're a member of, sorted by last update. Capped at 5000 cards.

---

## Mobile

**`/boards` slash command** — Type `/boards` in any channel; an ephemeral one-shot link opens Boards in the browser already authenticated (60-second TTL). Append a path (`/boards /boards/team/<teamID>/<boardID>`) to deep-link.

**Touch UX** — DnD requires a 250ms long-press with a 20px scroll-tolerance, so vertical scroll on phones no longer reorders cards. Sidebar auto-collapses after navigation on screens narrower than 768px.

---

## MCP server (AI agent integration)

Optional Model Context Protocol server that lets the [Mattermost Agents](https://github.com/mattermost/mattermost-plugin-agents) plugin (or any external MCP client) drive Boards on the user's behalf. Calls run under the calling user's permissions — no global access.

**Enable**: System Console → Plugins → **Mattermost Boards (PM fork)**:

| Setting | Default | Effect |
| --- | --- | --- |
| Enable MCP Server | off | Master switch. |
| MCP Listen Address | `127.0.0.1:8975` | TCP listener `host:port`. Use `0.0.0.0:<port>` for non-loopback. |
| Require API key on loopback | off | Forces a Bearer key even on localhost. |

Two transports, same toolset:

- **Inter-plugin** (`plugin://focalboard/mcp`) — used by the bundled Mattermost AI Agent. No key needed; trust comes from Mattermost's `Mattermost-Plugin-ID` header.
- **TCP** (`http://<host>:<port>/mcp`) — for external clients. User runs `/boards getapi <description>` to mint a personal Bearer key (shown once); paste it into the client's MCP config. `/boards listapi` and `/boards revokeapi <prefix>` manage existing keys.

**Wire to Mattermost AI Agent**: System Console → AI Agents → MCP servers → Add. Name = anything, BaseURL = `plugin://focalboard/mcp`, headers empty. Re-add after every plugin upgrade so the Agent picks up new tools.

### Tools

| Tool | Purpose |
| --- | --- |
| `get_current_user` | Calling user's id / username / email. |
| `list_my_boards` | Non-template boards the user can see, sorted by last update. |
| `get_board_info` | Board schema: properties, status / priority option lists, due-date and assignee property names. Call first. |
| `create_board` | Create a private board on a team from a stub template. |
| `list_board_members` | Members of a board with role. |
| `search_cards` | Cross-board search. Filters: text query, `assigned_to`, `status`, `priority`, `due_date_range`, `has_subtasks`, `limit`. |
| `get_card_details` | Full card payload incl. comments, subtasks, checkboxes, `attachments[]`. |
| `create_card` | Title + shortcuts (`assigned_to`, `status`, `priority`, `due_date`) + free-form properties. |
| `update_card` | Partial update; reads existing properties and merges. |
| `bulk_update_cards` | Apply one update payload to many cards in one call. |
| `delete_card` | Delete a card. |
| `reorder_card_content` | Reorder content blocks (subtasks, comments, etc.) within a card. |
| `add_comment` / `update_comment` / `delete_comment` | Card comments. |
| `add_subtask` / `update_subtask` / `delete_subtask` | Subtasks block rows. |
| `add_checkbox` / `update_checkbox` / `delete_checkbox` | Checkbox rows. |
| `attach_file` | Upload a file. Routes by MIME: `image/*` → image block, `video/*` → video block, else → attachment list. |
| `get_attachment` | Stream a single attachment back. Text-like MIME inlined as UTF-8 (≤5 MiB default, hard cap 50 MiB); binaries returned as base64. |
| `delete_attachment` | Remove an attachment; underlying file is freed when no block references it. |

---

## Building from source

`make` isn't required:

```bash
# Webapp — both build (webapp/dist/main.js) and pack (webapp/pack/):
cd webapp && npm install && npm run build && npm run pack && cd ..

# Server — five platforms, no CGO:
cd server && mkdir -p dist
LDFLAGS='-s -w -X github.com/mattermost/focalboard/server/model.Edition=plugin'
for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=""; [ "$os" = "windows" ] && ext=".exe"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 \
    go build -ldflags "$LDFLAGS" -trimpath \
    -o "dist/plugin-${os}-${arch}${ext}" .
done && cd ..

# Bundle (repack_plugin.py preserves +x on linux/darwin binaries):
PLUGIN_NAME=boards
rm -rf dist && mkdir -p dist/$PLUGIN_NAME/server dist/$PLUGIN_NAME/webapp
cp plugin.json LICENSE.txt NOTICE.txt dist/$PLUGIN_NAME/
cp -r assets pack public dist/$PLUGIN_NAME/ 2>/dev/null
cp -r webapp/pack dist/$PLUGIN_NAME/
cp -r server/dist dist/$PLUGIN_NAME/server/
cp -r webapp/dist dist/$PLUGIN_NAME/webapp/
python repack_plugin.py boards-pm.tar.gz
```

---

## License

Same as upstream — see [LICENSE.txt](./LICENSE.txt) and [NOTICE.txt](./NOTICE.txt).
