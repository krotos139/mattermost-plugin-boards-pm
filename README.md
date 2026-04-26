# mattermost-plugin-boards-pm

A project-management-flavoured fork of [mattermost-plugin-boards](https://github.com/mattermost/mattermost-plugin-boards) (Focalboard, the Boards plugin for Mattermost). Same plugin ID (`focalboard`), same data, drop-in upgrade — all your existing boards, cards, comments and history are preserved when you swap the upstream plugin for this build.

This fork adds Gantt-style scheduling, deadlines with reminders, dashboard boards, mobile login handoff and a number of card-detail improvements that make Boards usable as a lightweight project tracker.

> **Status:** active personal fork. Tracks upstream `main`; fixes from upstream are merged manually.

---

## What's added

### Timeline view (Gantt)

A new view type that renders cards as draggable bars on a calendar, sized by a date property of your choice. Supports parent → child dependency arrows, drag-to-reschedule with a cascade that shifts all linked descendants by the same delta, in-bar progress fill driven by a number property, and bar coloring driven by a select property. The left side panel shows visible card properties as a table with **per-column resize** (drag the right edge of a header).

<!-- IMG: timeline-view-overview -->
![Timeline view overview](docs/images/timeline-view-overview.png)

<!-- IMG: timeline-view-dependencies -->
![Timeline view with dependency cascade](docs/images/timeline-view-dependencies.png)

<!-- IMG: timeline-view-side-panel-resize -->
![Resizable side-panel columns](docs/images/timeline-view-side-panel-resize.png)

### Deadline property + DM reminders

A new `deadline` property type that's a date with a reminder. When the deadline passes, the assigned user (taken from a `Person (notify)` or `Multi person (notify)` property on the same card) receives a Mattermost DM with a link back to the card. No need to leave Boards open — Mattermost itself nudges you.

<!-- IMG: deadline-property-edit -->
![Deadline property in card detail](docs/images/deadline-property-edit.png)

<!-- IMG: deadline-dm-reminder -->
![Deadline DM reminder](docs/images/deadline-dm-reminder.png)

### Person (notify) and Multi person (notify) properties

Variants of the existing `person` / `multiPerson` types that **send a DM to the user** the moment they're added to a card, with the card title and a link. The plain `person` variants stay quiet.

<!-- IMG: person-notify-property -->
![Person (notify) property assignment](docs/images/person-notify-property.png)

### Dashboard boards: My Deadlines and All Tasks

Two pinned items in the left sidebar that surface cross-board views without manually building them:

- **My Deadlines** — every card across every board where you're assigned (via Person/Multi-person/Notify properties) and a deadline is set, sorted by date.
- **All Tasks** — every card you can see across every board you're a member of.

Tap either to land on a synthetic, auto-refreshing board with the right cards and a kanban + table view.

<!-- IMG: my-deadlines-board -->
![My Deadlines dashboard](docs/images/my-deadlines-board.png)

<!-- IMG: all-tasks-board -->
![All Tasks dashboard](docs/images/all-tasks-board.png)

### Per-card activity history tab

Card detail now has **two tabs at the bottom**: Comments (the original) and **History**, which lists every property change, title rename, comment add/edit/delete and content-block edit on the card with the user, timestamp and before → after diff. Consecutive edits by the same user to the same property within 30 minutes coalesce into one entry, so a multi-day Timeline drag shows up as a single "5/3 → 5/8" line instead of one entry per day.

<!-- IMG: card-history-tab -->
![Per-card history tab](docs/images/card-history-tab.png)

### Subtasks content block

A new content-block type for cards: a checklist that also tells you what state your subtasks are in (todo / in-progress / done counts). Useful for breaking a card down without spawning child cards.

<!-- IMG: subtasks-block -->
![Subtasks content block](docs/images/subtasks-block.png)

### Mobile experience

#### `/boards` slash command — one-tap mobile login-free open

Type `/boards` in any Mattermost channel (works in the mobile app too) and you get an ephemeral message with a single-use link that opens Boards in your browser **already authenticated** — no re-login. Backed by a server-side handoff endpoint that mints a short-lived MM session cookie when the link is followed (60-second TTL, single-use).

`/boards` lands on the current team's dashboard; pass an explicit board path to deep-link, e.g. `/boards /boards/team/<teamID>/<boardID>`.

<!-- IMG: boards-slash-command -->
![/boards slash command result](docs/images/boards-slash-command.png)

<!-- IMG: boards-mobile-browser -->
![Boards opened in mobile browser via handoff](docs/images/boards-mobile-browser.png)

#### Touch UX

Touch DnD requires a 250ms long-press before drag starts, with a 20px scroll-tolerance threshold — so vertical scroll on phones no longer reorders cards. Sidebar auto-collapses after navigation on screens narrower than 768px, including for the new dashboard boards.

### Card detail layout

The Comments + History tabs panel now stretches to the full width of the card body instead of shrinking to the longest comment, matching the content-blocks editor below it.

<!-- IMG: card-detail-fullwidth-tabs -->
![Comments + History tabs at full card width](docs/images/card-detail-fullwidth-tabs.png)

### Activity log polish

Timeline drag commits are now **idempotent** — committing the same end-state twice (which can happen on hybrid touch/mouse devices) creates only one history entry, not two. Combined with the 30-minute coalesce in the History tab, dragging a card across many days produces one clean entry instead of a dozen.

---

## Installation

### Drop-in upgrade from upstream `mattermost-plugin-boards`

The plugin ID is unchanged (`focalboard`), so installing this build replaces any existing `mattermost-plugin-boards` install **without touching the database**. All boards, cards, comments and history survive.

1. Grab `boards-*.tar.gz` from the [Releases](https://github.com/krotos139/mattermost-plugin-boards-pm/releases) page (or build it yourself, below).
2. In Mattermost: System Console → Plugin Management → Upload Plugin → pick the tar.gz.
3. Enable the plugin. Existing boards become accessible immediately.

### Optional: configure deadline reminders / mobile handoff

- The deadline reminder scheduler runs server-side automatically — no admin toggle needed beyond enabling the plugin.
- The `/boards` slash command is registered automatically on plugin activation.

---

## Building from source

`make` is unavailable on Windows; the plain commands below work on every platform. The full build instructions (including notes on CGO, the `repack_plugin.py` step required for executable bits on linux/darwin binaries, and the watch-mode workflow) are in the upstream README sections below.

```bash
# Webapp — both build (for webapp/dist/main.js, the runtime bundle) and
# pack (for webapp/pack/, the production bundle):
cd webapp
npm install
npm run build && npm run pack

# Server — five platforms, no CGO needed for the plugin:
cd ../server
mkdir -p dist
LDFLAGS='-X github.com/mattermost/focalboard/server/model.Edition=plugin'
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}; ext=""
  [ "$os" = "windows" ] && ext=".exe"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 \
    go build -ldflags "$LDFLAGS" -trimpath \
    -o "dist/plugin-${os}-${arch}${ext}" .
done

# Bundle and re-pack so linux/darwin binaries get +x in the archive:
cd ..
PLUGIN_NAME=boards
rm -rf dist
mkdir -p dist/$PLUGIN_NAME/server dist/$PLUGIN_NAME/webapp
cp plugin.json LICENSE.txt NOTICE.txt dist/$PLUGIN_NAME/
cp -r assets pack public dist/$PLUGIN_NAME/ 2>/dev/null
cp -r webapp/pack dist/$PLUGIN_NAME/
cp -r server/dist dist/$PLUGIN_NAME/server/
cp -r webapp/dist dist/$PLUGIN_NAME/webapp/
python repack_plugin.py boards-pm.tar.gz
```

---

## Compatibility

- **Mattermost server:** 10.7.0+ (per `plugin.json` `min_server_version`).
- **Plugin ID:** `focalboard` (unchanged from upstream).
- **Database schema:** identical to upstream; no migrations of upstream tables.
- **Webapp bundle:** drop-in. `webapp/dist/main.js` is the runtime entrypoint Mattermost loads.

---

## Tracking upstream

```bash
git remote add upstream https://github.com/mattermost/mattermost-plugin-boards.git
git fetch upstream
git merge upstream/main          # or rebase if you prefer
```

---

## License

Same as upstream — see [LICENSE.txt](./LICENSE.txt) and [NOTICE.txt](./NOTICE.txt). The fork-specific code is contributed under the same license terms.

---

## Upstream README (build & deploy reference)

### Getting started

Clone [mattermost](https://github.com/mattermost/mattermost-server) into a sibling directory.

Set the environment variable `MM_DEBUG=true` so the plugin compiles only for the host OS / architecture instead of all five target platforms on every build.

In your Mattermost configuration, ensure `PluginSettings.EnableUploads` is `true` and `FileSettings.MaxFileSize` is large enough to accept the plugin bundle (e.g. `256000000`).

### Installing dependencies

```sh
cd ./webapp
npm install
```

### Building (Makefile, on platforms where make is available)

```bash
make dist
```

After a successful build, a `.tar.gz` file in `/dist` can be uploaded to Mattermost.

### Deploying with local mode

If your Mattermost server is running locally, enable [local mode](https://docs.mattermost.com/manage/mmctl-command-line-tool.html):

```json
{
    "ServiceSettings": {
        "EnableLocalMode": true,
        "LocalModeSocketLocation": "/var/tmp/mattermost_local.socket"
    }
}
```

then deploy:

```bash
make deploy
```

For a webapp watch loop:

```bash
export MM_SERVICESETTINGS_SITEURL=http://localhost:8065
make watch-plugin
```

### Unit testing

```bash
make ci          # full local CI
make server-test # server unit tests only
cd webapp && npm run check && npm run test
```
