// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Dashboard system boards (e.g. "My Deadlines"): per-user, per-team boards
// that aggregate cards from other boards into a virtual, read-only view.
// Cards on a dashboard are NOT stored — they are generated on each fetch
// from the source boards' actual cards.

package app

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"
)

// Dashboard property IDs are stable, hardcoded strings (not random utils.NewID)
// so views referencing them survive plugin restarts and the property layout
// is stable across users.
const (
	DashboardPropIDBoard     = "dash_board"
	DashboardPropIDDeadline  = "dash_deadline"
	DashboardPropIDStatus    = "dash_status"
	DashboardPropIDDaysUntil = "dash_days_until"

	// Synthetic block field keys — used by frontend to navigate to original card.
	dashboardSourceBoardField = "originalBoardId"
	dashboardSourceCardField  = "originalCardId"

	// Prefix on virtual card IDs so they don't collide with real ones.
	dashboardSyntheticIDPrefix = "synth-"

	// Source-board property types we recognize.
	deadlinePropType          = "deadline"
	personNotifyPropType      = "personNotify"
	multiPersonNotifyPropType = "multiPersonNotify"
	selectPropType            = "select"

	msPerDay = 24 * 60 * 60 * 1000
)

// dashboardCardProperties returns the fixed set of synthetic properties for
// a dashboard board. The user can configure views over them but cannot
// add/remove properties (enforced on the API side).
func dashboardCardProperties(kind string) []map[string]interface{} {
	switch kind {
	case model.DashboardKindDeadlines:
		return []map[string]interface{}{
			{"id": DashboardPropIDBoard, "name": "Board", "type": "text", "options": []interface{}{}},
			{"id": DashboardPropIDDeadline, "name": "Deadline", "type": "date", "options": []interface{}{}},
			{"id": DashboardPropIDStatus, "name": "Status", "type": "text", "options": []interface{}{}},
			{"id": DashboardPropIDDaysUntil, "name": "Days until", "type": "number", "options": []interface{}{}},
		}
	}
	return nil
}

func dashboardTitle(kind string) string {
	switch kind {
	case model.DashboardKindDeadlines:
		return "My Deadlines"
	}
	return "Dashboard"
}

func dashboardIcon(kind string) string {
	switch kind {
	case model.DashboardKindDeadlines:
		return "🏁"
	}
	return "📊"
}

// GetOrCreateDashboardBoard returns the per-user dashboard board of the given
// kind in the given team, creating it lazily on first call.
func (a *App) GetOrCreateDashboardBoard(userID string, teamID string, kind string) (*model.Board, error) {
	if dashboardCardProperties(kind) == nil {
		return nil, fmt.Errorf("unknown dashboard kind: %s", kind)
	}

	// Look for an existing one. Lookup is by userID+teamID+kind in memory —
	// SQL filters on JSON properties are not portable across mysql/pg/sqlite.
	boards, err := a.store.GetBoardsForUserAndTeam(userID, teamID, false)
	if err != nil {
		return nil, fmt.Errorf("cannot list user boards: %w", err)
	}
	for _, b := range boards {
		if b.CreatedBy == userID && b.DashboardKind() == kind {
			return b, nil
		}
	}

	// Not found — create. We bypass App.CreateBoard intentionally:
	// CreateBoard adds the new board to the user's default category
	// (showing it under "BOARDS" in the sidebar), which we don't want for
	// system dashboards. We add the user as admin so subsequent permission
	// checks (HasPermissionToBoard) succeed.
	board := &model.Board{
		ID:             utils.NewID(utils.IDTypeBoard),
		TeamID:         teamID,
		CreatedBy:      userID,
		ModifiedBy:     userID,
		Type:           model.BoardTypePrivate,
		MinimumRole:    model.BoardRoleViewer,
		Title:          dashboardTitle(kind),
		Icon:           dashboardIcon(kind),
		Properties:     map[string]interface{}{model.BoardPropertyDashboardKind: kind},
		CardProperties: dashboardCardProperties(kind),
	}

	newBoard, _, err := a.store.InsertBoardWithAdmin(board, userID)
	if err != nil {
		return nil, fmt.Errorf("cannot create dashboard board: %w", err)
	}

	// A board without a view renders as a blank screen. Seed a default
	// table view so the dashboard is immediately usable; the user can add
	// more views (kanban, calendar, gallery) later.
	defaultView := defaultDashboardView(newBoard.ID, kind, userID)
	if err := a.store.InsertBlock(defaultView, userID); err != nil {
		// Don't fail the whole call — the board is still usable, the user
		// can add a view manually.
		a.logger.Warn(fmt.Sprintf("dashboard: cannot create default view: %v", err))
	}
	return newBoard, nil
}

func defaultDashboardView(boardID string, kind string, userID string) *model.Block {
	now := utils.GetMillis()
	return &model.Block{
		ID:         utils.NewID(utils.IDTypeView),
		BoardID:    boardID,
		ParentID:   boardID,
		CreatedBy:  userID,
		ModifiedBy: userID,
		Schema:     1,
		Type:       model.TypeView,
		Title:      "Table",
		CreateAt:   now,
		UpdateAt:   now,
		Fields: map[string]interface{}{
			"viewType":             "table",
			"sortOptions":          []interface{}{map[string]interface{}{"propertyId": DashboardPropIDDeadline, "reversed": false}},
			"visiblePropertyIds":   []interface{}{DashboardPropIDBoard, DashboardPropIDDeadline, DashboardPropIDStatus, DashboardPropIDDaysUntil},
			"visibleOptionIds":     []interface{}{},
			"hiddenOptionIds":      []interface{}{},
			"collapsedOptionIds":   []interface{}{},
			"filter":               map[string]interface{}{"operation": "and", "filters": []interface{}{}},
			"cardOrder":            []interface{}{},
			"columnWidths":         map[string]interface{}{},
			"columnCalculations":   map[string]interface{}{},
			"kanbanCalculations":   map[string]interface{}{},
			"defaultTemplateId":    "",
		},
	}
}

// GetDashboardCards returns the virtual card blocks for a dashboard board.
// The blocks are NOT persisted — they are recomputed on every call.
// Caller is responsible for verifying the board belongs to the calling user.
func (a *App) GetDashboardCards(board *model.Board, userID string) ([]*model.Block, error) {
	if board.DashboardKind() != model.DashboardKindDeadlines {
		return nil, nil
	}

	sourceBoards, err := a.store.GetBoardsForUserAndTeam(userID, board.TeamID, false)
	if err != nil {
		return nil, fmt.Errorf("cannot list source boards: %w", err)
	}

	nowMillis := utils.GetMillis()
	out := make([]*model.Block, 0)

	for _, src := range sourceBoards {
		if src.IsSystemBoard() {
			continue
		}
		idx := indexSourceBoard(src.CardProperties)
		if idx.deadlinePropID == "" || len(idx.notifyPropIDs) == 0 {
			continue
		}

		blocks, err := a.store.GetBlocksForBoard(src.ID)
		if err != nil {
			a.logger.Warn(fmt.Sprintf("dashboard: cannot list blocks for board %s: %v", src.ID, err))
			continue
		}

		for _, blk := range blocks {
			if blk.Type != model.TypeCard || blk.DeleteAt > 0 {
				continue
			}
			cardProps, _ := blk.Fields["properties"].(map[string]interface{})
			if cardProps == nil {
				continue
			}

			if !isAssignedTo(cardProps, idx.notifyPropIDs, userID) {
				continue
			}

			deadlineMillis, ok := parseDeadlineMillis(cardProps[idx.deadlinePropID])
			if !ok {
				continue
			}

			statusText := ""
			if idx.statusPropID != "" {
				if optID, ok := cardProps[idx.statusPropID].(string); ok && optID != "" {
					statusText = selectOptionName(src.CardProperties, idx.statusPropID, optID)
				}
			}

			daysUntil := (deadlineMillis - nowMillis) / msPerDay

			virtual := &model.Block{
				ID:         dashboardSyntheticIDPrefix + blk.ID,
				BoardID:    board.ID,
				ParentID:   board.ID,
				Type:       model.TypeCard,
				Title:      blk.Title,
				CreatedBy:  blk.CreatedBy,
				ModifiedBy: blk.ModifiedBy,
				CreateAt:   blk.CreateAt,
				UpdateAt:   blk.UpdateAt,
				Schema:     blk.Schema,
				Fields: map[string]interface{}{
					"icon": getStringField(blk.Fields, "icon"),
					"properties": map[string]interface{}{
						DashboardPropIDBoard:     src.Title,
						DashboardPropIDDeadline:  rawString(cardProps[idx.deadlinePropID]),
						DashboardPropIDStatus:    statusText,
						DashboardPropIDDaysUntil: strconv.FormatInt(daysUntil, 10),
					},
					"contentOrder":            []interface{}{},
					dashboardSourceBoardField: src.ID,
					dashboardSourceCardField:  blk.ID,
				},
			}
			out = append(out, virtual)
		}
	}

	return out, nil
}

// sourceBoardIndex caches which props on a source board carry the deadline,
// the person-notify recipients, and the (first) select used as Status.
type sourceBoardIndex struct {
	deadlinePropID string
	notifyPropIDs  []string
	statusPropID   string
}

func indexSourceBoard(cardProperties []map[string]interface{}) sourceBoardIndex {
	idx := sourceBoardIndex{}
	for _, prop := range cardProperties {
		propType, _ := prop["type"].(string)
		propID, _ := prop["id"].(string)
		if propID == "" {
			continue
		}
		switch propType {
		case deadlinePropType:
			if idx.deadlinePropID == "" {
				idx.deadlinePropID = propID
			}
		case personNotifyPropType, multiPersonNotifyPropType:
			idx.notifyPropIDs = append(idx.notifyPropIDs, propID)
		case selectPropType:
			if idx.statusPropID == "" {
				idx.statusPropID = propID
			}
		}
	}
	return idx
}

// isAssignedTo reports whether userID is referenced in any of the listed
// person-notify properties on the card.
func isAssignedTo(cardProps map[string]interface{}, notifyPropIDs []string, userID string) bool {
	for _, propID := range notifyPropIDs {
		switch v := cardProps[propID].(type) {
		case string:
			if v == userID {
				return true
			}
		case []interface{}:
			for _, item := range v {
				if s, ok := item.(string); ok && s == userID {
					return true
				}
			}
		case []string:
			for _, s := range v {
				if s == userID {
					return true
				}
			}
		}
	}
	return false
}

// parseDeadlineMillis decodes the on-card representation of a date/deadline
// property into a unix-millis "from" timestamp. Frontend stores either a
// plain millis-string ("1700000000000") or a JSON object with `from`.
func parseDeadlineMillis(raw interface{}) (int64, bool) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return 0, false
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, true
	}
	var obj struct {
		From int64 `json:"from"`
	}
	if err := json.Unmarshal([]byte(s), &obj); err == nil && obj.From > 0 {
		return obj.From, true
	}
	return 0, false
}

// selectOptionName resolves a select option ID to its human-readable label
// by scanning the source board's card properties.
func selectOptionName(cardProperties []map[string]interface{}, propertyID, optionID string) string {
	for _, prop := range cardProperties {
		id, _ := prop["id"].(string)
		if id != propertyID {
			continue
		}
		options, _ := prop["options"].([]interface{})
		for _, opt := range options {
			optMap, _ := opt.(map[string]interface{})
			if optMap == nil {
				continue
			}
			oid, _ := optMap["id"].(string)
			if oid == optionID {
				name, _ := optMap["value"].(string)
				return name
			}
		}
	}
	return ""
}

func rawString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func getStringField(fields map[string]interface{}, key string) string {
	if fields == nil {
		return ""
	}
	if s, ok := fields[key].(string); ok {
		return s
	}
	return ""
}
