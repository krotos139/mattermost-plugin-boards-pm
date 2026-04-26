// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"
)

// toolHandler executes a single MCP tool. It receives the raw arguments
// payload (a JSON object the agent sent) and the resolved acting userID.
// Implementation-level errors are returned as Go errors and surfaced as
// JSON-RPC errors; per-call domain failures (permission denied, not found)
// should be encoded into the result payload with isError=true via toolError.
type toolHandler func(ctx context.Context, userID string, args json.RawMessage) (toolsCallResult, error)

// toolEntry pairs a tool's advertised metadata with its handler.
type toolEntry struct {
	def     toolDef
	handler toolHandler
}

// buildTools wires up the tool registry. Order in the slice is the order
// tools/list returns them — agents typically read sequentially, so keep
// discovery / read-only tools first.
func (s *Server) buildTools() map[string]toolHandler {
	entries := []toolEntry{
		s.toolListMyBoards(),
		s.toolGetBoardInfo(),
		s.toolSearchCards(),
		s.toolGetCardDetails(),
		s.toolCreateCard(),
		s.toolUpdateCard(),
		s.toolAddComment(),
	}
	out := make(map[string]toolHandler, len(entries))
	for _, e := range entries {
		out[e.def.Name] = e.handler
	}
	s.orderedToolDefs = make([]toolDef, len(entries))
	for i, e := range entries {
		s.orderedToolDefs[i] = e.def
	}
	return out
}

func (s *Server) toolDefs() []toolDef {
	return s.orderedToolDefs
}

func (s *Server) handleToolCall(ctx context.Context, userID string, req *rpcRequest) rpcResponse {
	var p toolsCallParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return rpcErr(req.ID, errCodeInvalidParams, "invalid tools/call params: "+err.Error())
	}
	handler, ok := s.tools[p.Name]
	if !ok {
		return rpcErr(req.ID, errCodeMethodNotFound, "unknown tool: "+p.Name)
	}
	result, err := handler(ctx, userID, p.Arguments)
	if err != nil {
		return rpcErr(req.ID, errCodeInternalError, err.Error())
	}
	return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result}
}

func rpcErr(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: msg},
	}
}

// toolError builds a tools/call result with isError=true. Use for per-call
// failures (permission, not-found, validation) so the agent sees the message
// in the same channel as success output.
func toolError(format string, args ...interface{}) toolsCallResult {
	return toolsCallResult{
		Content: []toolContent{{Type: "text", Text: fmt.Sprintf(format, args...)}},
		IsError: true,
	}
}

// toolJSON marshals v as the single text content of a successful tool result.
func toolJSON(v interface{}) (toolsCallResult, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return toolsCallResult{}, err
	}
	return toolsCallResult{Content: []toolContent{{Type: "text", Text: string(b)}}}, nil
}

// rawSchema is a tiny helper that lets us declare schemas inline as readable
// JSON literals while still passing them through json.RawMessage. Panics on
// invalid JSON because schemas are static developer-authored strings — a typo
// is a programming error, not a runtime condition.
func rawSchema(s string) json.RawMessage {
	var v interface{}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		panic(errors.New("mcp: invalid embedded schema: " + err.Error()))
	}
	out, _ := json.Marshal(v)
	return out
}

// =====================================================================
// Property-type classification
// =====================================================================
//
// Boards stores schema as a free-form list of property templates with a
// `type` discriminator. The MCP tools need to map abstract concepts
// ("the assignee field", "the status column") onto whichever templates a
// given board happens to use. The helpers below scan a board's
// cardProperties looking for properties of a given type family, and the
// tool implementations accept any matching property as the source.

const (
	propTypeText             = "text"
	propTypeSelect           = "select"
	propTypeMultiSelect      = "multiSelect"
	propTypeNumber           = "number"
	propTypeDate             = "date"
	propTypeDeadline         = "deadline"
	propTypeCreatedTime      = "createdTime"
	propTypeUpdatedTime      = "updatedTime"
	propTypePerson           = "person"
	propTypeMultiPerson      = "multiPerson"
	propTypePersonNotify     = "personNotify"
	propTypeMultiPersonNotify = "multiPersonNotify"
)

// personPropertyTypes lists the property templates that hold user references.
// search_cards.assigned_to and the assignee enrichment in get_card_details
// search across all of these.
var personPropertyTypes = map[string]bool{
	propTypePerson:            true,
	propTypeMultiPerson:       true,
	propTypePersonNotify:      true,
	propTypeMultiPersonNotify: true,
}

// dateLikePropertyTypes are the property types we accept as a "due date"
// when filtering by due_date_range. Deadline is the canonical one (it's the
// type the My Deadlines dashboard scans), but plain date is included too so
// boards using the upstream-style date column still work.
var dateLikePropertyTypes = map[string]bool{
	propTypeDate:     true,
	propTypeDeadline: true,
}

// extractPersonIDs returns the user-id list encoded in a card property value
// for any of the personPropertyTypes. Returns empty for missing or
// unparseable values.
func extractPersonIDs(raw interface{}) []string {
	if raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case string:
		if v == "" {
			return nil
		}
		// Multi-person values can be encoded as a JSON-stringified array.
		if strings.HasPrefix(v, "[") {
			var arr []string
			if err := json.Unmarshal([]byte(v), &arr); err == nil {
				return arr
			}
		}
		return []string{v}
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, x := range v {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// extractDateMillis parses a date / deadline property value and returns the
// "from" timestamp in unix-ms. Boards encodes dates as a JSON object
// `{"from": <ms>, "to": <ms>}` (string-quoted in some pathways), so we try a
// few shapes. Returns 0 when no usable from value is present.
func extractDateMillis(raw interface{}) int64 {
	if raw == nil {
		return 0
	}
	tryParse := func(s string) int64 {
		if s == "" {
			return 0
		}
		if strings.HasPrefix(s, "{") {
			var d struct {
				From int64 `json:"from"`
			}
			if err := json.Unmarshal([]byte(s), &d); err == nil {
				return d.From
			}
		}
		// Plain numeric millis encoded as string.
		var ms int64
		if _, err := fmt.Sscanf(s, "%d", &ms); err == nil {
			return ms
		}
		return 0
	}
	switch v := raw.(type) {
	case string:
		return tryParse(v)
	case float64:
		return int64(v)
	case int64:
		return v
	case map[string]interface{}:
		if f, ok := v["from"].(float64); ok {
			return int64(f)
		}
	}
	return 0
}

// propTemplate is a Boards card-property schema entry. The on-disk shape is
// untyped JSON (`map[string]interface{}`) — the server model never produced
// a concrete struct for it — so the MCP layer reads it via small accessor
// helpers below.
type propTemplate map[string]interface{}

func (p propTemplate) id() string   { s, _ := p["id"].(string); return s }
func (p propTemplate) name() string { s, _ := p["name"].(string); return s }
func (p propTemplate) ptype() string {
	s, _ := p["type"].(string)
	return s
}
func (p propTemplate) options() []map[string]interface{} {
	raw, _ := p["options"].([]interface{})
	out := make([]map[string]interface{}, 0, len(raw))
	for _, x := range raw {
		if m, ok := x.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

func optionID(o map[string]interface{}) string    { s, _ := o["id"].(string); return s }
func optionValue(o map[string]interface{}) string { s, _ := o["value"].(string); return s }
func optionColor(o map[string]interface{}) string { s, _ := o["color"].(string); return s }

// resolveOptionLabel finds the human label for a select-typed property's
// stored option-id value. Returns the raw value when no option matches.
func resolveOptionLabel(raw interface{}, prop propTemplate) string {
	id, ok := raw.(string)
	if !ok {
		return ""
	}
	for _, opt := range prop.options() {
		if optionID(opt) == id {
			return optionValue(opt)
		}
	}
	return id
}

// findOptionIDByLabel looks up the option id for a select property given a
// case-insensitive label match. Returns "" when nothing matches; lets the
// tools accept human labels ("In Progress") instead of opaque ids in
// arguments like status / priority.
func findOptionIDByLabel(prop propTemplate, label string) string {
	target := strings.ToLower(strings.TrimSpace(label))
	for _, opt := range prop.options() {
		if strings.EqualFold(optionValue(opt), target) {
			return optionID(opt)
		}
	}
	return ""
}

// boardProperties returns the typed view of a board's card-property templates.
func boardProperties(b *model.Board) []propTemplate {
	out := make([]propTemplate, 0, len(b.CardProperties))
	for _, m := range b.CardProperties {
		out = append(out, propTemplate(m))
	}
	return out
}

// findPropertyByName returns the first card property whose name matches
// (case-insensitive). Empty propTemplate (`nil`) is returned when nothing
// matches — callers must guard with `if prop == nil`.
func findPropertyByName(b *model.Board, name string) propTemplate {
	target := strings.ToLower(strings.TrimSpace(name))
	for _, p := range boardProperties(b) {
		if strings.ToLower(p.name()) == target {
			return p
		}
	}
	return nil
}

// findPropertiesByType returns all card-property templates with a given type.
func findPropertiesByType(b *model.Board, propType string) []propTemplate {
	var out []propTemplate
	for _, p := range boardProperties(b) {
		if p.ptype() == propType {
			out = append(out, p)
		}
	}
	return out
}

// findPersonProperties returns every assignee-bearing property on the board.
func findPersonProperties(b *model.Board) []propTemplate {
	var out []propTemplate
	for _, p := range boardProperties(b) {
		if personPropertyTypes[p.ptype()] {
			out = append(out, p)
		}
	}
	return out
}

// findDueDateProperty returns the most likely "due date" property on a
// board: prefer Deadline-typed (the My Deadlines / reminder source of
// truth), then any property literally named "Due Date" / "Due", finally
// the first Date-typed property. Returns nil when the board has none.
func findDueDateProperty(b *model.Board) propTemplate {
	if dl := findPropertiesByType(b, propTypeDeadline); len(dl) > 0 {
		return dl[0]
	}
	if p := findPropertyByName(b, "due date"); p != nil && dateLikePropertyTypes[p.ptype()] {
		return p
	}
	if p := findPropertyByName(b, "due"); p != nil && dateLikePropertyTypes[p.ptype()] {
		return p
	}
	if d := findPropertiesByType(b, propTypeDate); len(d) > 0 {
		return d[0]
	}
	return nil
}

// resolveAssignee turns a user-supplied assigned_to argument into a userID.
// "me" -> the calling user. A username -> looked up via the plugin API.
// Empty string means "not specified" and should be handled by the caller.
func (s *Server) resolveAssigneeID(callerID, raw string) (string, error) {
	v := strings.TrimSpace(raw)
	switch strings.ToLower(v) {
	case "", "me":
		return callerID, nil
	case "any", "unassigned":
		return v, nil // sentinel — caller interprets
	}
	user, appErr := s.api.GetUserByUsername(strings.TrimPrefix(v, "@"))
	if appErr != nil || user == nil {
		return "", fmt.Errorf("user not found: %s", raw)
	}
	return user.Id, nil
}

// =====================================================================
// list_my_boards
// =====================================================================

type boardSummary struct {
	ID           string `json:"id"`
	TeamID       string `json:"team_id"`
	Title        string `json:"title"`
	Description  string `json:"description,omitempty"`
	Type         string `json:"type"`
	Icon         string `json:"icon,omitempty"`
	UpdateAt     int64  `json:"update_at"`
	UpdateAtISO  string `json:"update_at_iso"`
	IsTemplate   bool   `json:"is_template,omitempty"`
}

func summarizeBoard(b *model.Board) boardSummary {
	return boardSummary{
		ID:          b.ID,
		TeamID:      b.TeamID,
		Title:       b.Title,
		Description: b.Description,
		Type:        string(b.Type),
		Icon:        b.Icon,
		UpdateAt:    b.UpdateAt,
		UpdateAtISO: msToISO(b.UpdateAt),
		IsTemplate:  b.IsTemplate,
	}
}

func (s *Server) toolListMyBoards() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "list_my_boards",
			Description: "Returns all Focalboard boards that the current user has access to. Use this when the user asks about their boards, projects, or wants to find tasks but doesn't specify a particular board. Returns board ID, title, description, board type (team/personal), and last modified date for each board.",
			InputSchema: rawSchema(`{
				"type": "object",
				"properties": {}
			}`),
		},
		handler: func(_ context.Context, userID string, _ json.RawMessage) (toolsCallResult, error) {
			boards, err := s.boardsForUser(userID)
			if err != nil {
				return toolError("list boards: %v", err), nil
			}
			out := make([]boardSummary, 0, len(boards))
			for _, b := range boards {
				if b.IsTemplate {
					continue
				}
				out = append(out, summarizeBoard(b))
			}
			sort.Slice(out, func(i, j int) bool { return out[i].UpdateAt > out[j].UpdateAt })
			return toolJSON(map[string]interface{}{"boards": out})
		},
	}
}

// boardsForUser returns every (non-deleted) board the user can see across
// every team they belong to, deduplicated by board id.
func (s *Server) boardsForUser(userID string) ([]*model.Board, error) {
	teams, appErr := s.api.GetTeamsForUser(userID)
	if appErr != nil {
		return nil, fmt.Errorf("get teams for user: %s", appErr.Message)
	}
	seen := make(map[string]struct{})
	var out []*model.Board
	for _, t := range teams {
		bs, err := s.backend.GetBoardsForUserAndTeam(userID, t.Id, true)
		if err != nil {
			return nil, err
		}
		for _, b := range bs {
			if _, dup := seen[b.ID]; dup {
				continue
			}
			seen[b.ID] = struct{}{}
			out = append(out, b)
		}
	}
	return out, nil
}

// =====================================================================
// get_board_info
// =====================================================================

type boardPropertySchema struct {
	ID          string                  `json:"id"`
	Name        string                  `json:"name"`
	Type        string                  `json:"type"`
	Options     []boardPropertyOption   `json:"options,omitempty"`
}

type boardPropertyOption struct {
	ID    string `json:"id"`
	Value string `json:"value"`
	Color string `json:"color,omitempty"`
}

type boardInfo struct {
	ID           string                `json:"id"`
	TeamID       string                `json:"team_id"`
	Title        string                `json:"title"`
	Description  string                `json:"description,omitempty"`
	Type         string                `json:"type"`
	Properties   []boardPropertySchema `json:"properties"`
	StatusValues []string              `json:"status_values,omitempty"`
	PriorityValues []string            `json:"priority_values,omitempty"`
	DueDateProperty string             `json:"due_date_property,omitempty"`
	AssigneeProperties []string        `json:"assignee_properties,omitempty"`
	Members      []boardMemberSummary  `json:"members,omitempty"`
	UpdateAt     int64                 `json:"update_at"`
}

type boardMemberSummary struct {
	UserID   string `json:"user_id"`
	Username string `json:"username,omitempty"`
	Role     string `json:"role"`
}

func (s *Server) toolGetBoardInfo() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "get_board_info",
			Description: "Returns metadata and schema for a specific board. This is essential to call BEFORE creating or modifying cards, because it tells you what status values are available (e.g., \"To Do\", \"In Progress\", \"Done\"), what custom fields exist, what priorities are allowed, and who the board members are. The board_id can be obtained from list_my_boards(). Always call this first if you plan to create or update cards on a board you haven't examined yet.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["board_id"],
				"properties": {
					"board_id": {"type": "string"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				BoardID string `json:"board_id"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.BoardID == "" {
				return toolError("board_id is required"), nil
			}
			if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionViewBoard) {
				return toolError("permission denied for board %s", args.BoardID), nil
			}
			board, err := s.backend.GetBoard(args.BoardID)
			if err != nil || board == nil {
				return toolError("board not found: %s", args.BoardID), nil
			}
			info := boardInfo{
				ID:          board.ID,
				TeamID:      board.TeamID,
				Title:       board.Title,
				Description: board.Description,
				Type:        string(board.Type),
				UpdateAt:    board.UpdateAt,
			}
			for _, p := range boardProperties(board) {
				schema := boardPropertySchema{
					ID:   p.id(),
					Name: p.name(),
					Type: p.ptype(),
				}
				for _, opt := range p.options() {
					schema.Options = append(schema.Options, boardPropertyOption{
						ID:    optionID(opt),
						Value: optionValue(opt),
						Color: optionColor(opt),
					})
				}
				info.Properties = append(info.Properties, schema)
				if personPropertyTypes[p.ptype()] {
					info.AssigneeProperties = append(info.AssigneeProperties, p.name())
				}
			}
			// Surface status / priority option values up-front so the agent
			// doesn't have to hunt through the property list.
			if statusProp := findPropertyByName(board, "status"); statusProp != nil && statusProp.ptype() == propTypeSelect {
				for _, opt := range statusProp.options() {
					info.StatusValues = append(info.StatusValues, optionValue(opt))
				}
			}
			if priorityProp := findPropertyByName(board, "priority"); priorityProp != nil && priorityProp.ptype() == propTypeSelect {
				for _, opt := range priorityProp.options() {
					info.PriorityValues = append(info.PriorityValues, optionValue(opt))
				}
			}
			if due := findDueDateProperty(board); due != nil {
				info.DueDateProperty = due.name()
			}
			return toolJSON(info)
		},
	}
}

// =====================================================================
// search_cards
// =====================================================================

type searchCardsArgs struct {
	BoardID      string `json:"board_id"`
	TextQuery    string `json:"text_query"`
	AssignedTo   string `json:"assigned_to"`
	Status       string `json:"status"`
	Priority     string `json:"priority"`
	DueDateRange string `json:"due_date_range"`
	HasSubtasks  *bool  `json:"has_subtasks"`
	Limit        int    `json:"limit"`
}

// cardSummary is a search-result row: card identity, title, key properties
// resolved to human labels, and the parent board id so the agent can fetch
// the full board context if needed.
type cardSummary struct {
	ID         string                 `json:"id"`
	BoardID    string                 `json:"board_id"`
	BoardTitle string                 `json:"board_title,omitempty"`
	Title      string                 `json:"title"`
	Status     string                 `json:"status,omitempty"`
	Priority   string                 `json:"priority,omitempty"`
	Assignees  []string               `json:"assignees,omitempty"`
	DueDate    string                 `json:"due_date,omitempty"`
	UpdateAt   int64                  `json:"update_at"`
	UpdateISO  string                 `json:"update_iso"`
	Properties map[string]interface{} `json:"properties,omitempty"`
}

func (s *Server) toolSearchCards() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "search_cards",
			Description: "Primary tool for finding tasks (cards). All parameters are optional and combine. Common patterns: assigned_to=\"me\" for the user's own tasks, due_date_range=\"overdue\"/\"today\"/\"this_week\"/\"next_week\" or a YYYY-MM-DD..YYYY-MM-DD range, status / priority match (case-insensitively) any select-property option label, text_query matches title text. Set assigned_to=\"any\" for team-wide search, \"unassigned\" for unclaimed work.",
			InputSchema: rawSchema(`{
				"type": "object",
				"properties": {
					"board_id":       {"type": "string", "description": "Optional. Restrict to a single board; omit to search across every board the user can access."},
					"text_query":     {"type": "string"},
					"assigned_to":    {"type": "string", "description": "\"me\", a username, \"any\", or \"unassigned\"."},
					"status":         {"type": "string"},
					"priority":       {"type": "string"},
					"due_date_range": {"type": "string", "description": "\"overdue\", \"today\", \"this_week\", \"next_week\", or YYYY-MM-DD..YYYY-MM-DD."},
					"has_subtasks":   {"type": "boolean"},
					"limit":          {"type": "integer", "minimum": 1, "maximum": 500, "description": "Max results. Default 50."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			args := searchCardsArgs{}
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &args); err != nil {
					return toolError("invalid arguments: %v", err), nil
				}
			}
			limit := args.Limit
			if limit <= 0 {
				limit = 50
			}
			if limit > 500 {
				limit = 500
			}

			// Determine which boards to search.
			var targetBoards []*model.Board
			if args.BoardID != "" {
				if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionViewBoard) {
					return toolError("permission denied for board %s", args.BoardID), nil
				}
				b, err := s.backend.GetBoard(args.BoardID)
				if err != nil || b == nil {
					return toolError("board not found: %s", args.BoardID), nil
				}
				targetBoards = []*model.Board{b}
			} else {
				bs, err := s.boardsForUser(userID)
				if err != nil {
					return toolError("list boards: %v", err), nil
				}
				for _, b := range bs {
					if !b.IsTemplate {
						targetBoards = append(targetBoards, b)
					}
				}
			}

			// Resolve assignee filter once.
			assigneeFilter, err := s.resolveAssigneeID(userID, args.AssignedTo)
			if err != nil {
				return toolError("%v", err), nil
			}

			// Resolve due-date window once.
			dueFrom, dueTo, dueErr := parseDueDateRange(args.DueDateRange)
			if dueErr != nil {
				return toolError("invalid due_date_range: %v", dueErr), nil
			}

			results := make([]cardSummary, 0, limit)
			for _, board := range targetBoards {
				if len(results) >= limit {
					break
				}
				cards, cerr := s.backend.GetCardsForBoard(board.ID, 0, 1000)
				if cerr != nil {
					continue
				}
				for _, card := range cards {
					if len(results) >= limit {
						break
					}
					if !cardMatches(card, board, args, assigneeFilter, dueFrom, dueTo, s.backend) {
						continue
					}
					results = append(results, cardSummaryFor(card, board))
				}
			}
			sort.Slice(results, func(i, j int) bool { return results[i].UpdateAt > results[j].UpdateAt })
			return toolJSON(map[string]interface{}{
				"cards": results,
				"count": len(results),
				"limit": limit,
			})
		},
	}
}

// cardMatches evaluates every search filter against one card. Filters with
// empty / zero values are skipped (i.e. "match anything").
func cardMatches(
	card *model.Card,
	board *model.Board,
	args searchCardsArgs,
	assigneeFilter string,
	dueFrom, dueTo int64,
	backend Backend,
) bool {
	if args.TextQuery != "" {
		if !strings.Contains(strings.ToLower(card.Title), strings.ToLower(args.TextQuery)) {
			return false
		}
	}
	if args.AssignedTo != "" {
		if !cardMatchesAssignee(card, board, args.AssignedTo, assigneeFilter) {
			return false
		}
	}
	if args.Status != "" {
		if !cardMatchesSelect(card, board, "status", args.Status) {
			return false
		}
	}
	if args.Priority != "" {
		if !cardMatchesSelect(card, board, "priority", args.Priority) {
			return false
		}
	}
	if dueFrom != 0 || dueTo != 0 {
		due := findDueDateProperty(board)
		if due == nil {
			return false
		}
		raw, ok := card.Properties[due.id()]
		if !ok {
			return false
		}
		ms := extractDateMillis(raw)
		if ms == 0 {
			return false
		}
		if dueFrom != 0 && ms < dueFrom {
			return false
		}
		if dueTo != 0 && ms > dueTo {
			return false
		}
	}
	if args.HasSubtasks != nil {
		hasSub, err := cardHasSubtasks(card, board, backend)
		if err != nil {
			return false
		}
		if hasSub != *args.HasSubtasks {
			return false
		}
	}
	return true
}

// cardMatchesAssignee evaluates assigned_to. The filter argument can be
// "me" (resolved to caller id), a userID resolved from a username, "any"
// (matches anything with at least one person property set), or "unassigned"
// (matches when every person property is empty).
func cardMatchesAssignee(card *model.Card, board *model.Board, raw, resolved string) bool {
	props := findPersonProperties(board)
	if len(props) == 0 {
		// Board has no assignee column — only "any" / "unassigned" can match.
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "unassigned":
			return true
		case "any":
			return false
		default:
			return false
		}
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "any":
		for _, p := range props {
			if ids := extractPersonIDs(card.Properties[p.id()]); len(ids) > 0 {
				return true
			}
		}
		return false
	case "unassigned":
		for _, p := range props {
			if ids := extractPersonIDs(card.Properties[p.id()]); len(ids) > 0 {
				return false
			}
		}
		return true
	default:
		// resolved is an explicit user id; match against any person property.
		for _, p := range props {
			for _, id := range extractPersonIDs(card.Properties[p.id()]) {
				if id == resolved {
					return true
				}
			}
		}
		return false
	}
}

// cardMatchesSelect checks whether the card's named select-property value
// matches the requested label, case-insensitively. Boards with no such
// property never match (no row to filter on).
func cardMatchesSelect(card *model.Card, board *model.Board, propName, label string) bool {
	prop := findPropertyByName(board, propName)
	if prop == nil || prop.ptype() != propTypeSelect {
		return false
	}
	rawID, ok := card.Properties[prop.id()].(string)
	if !ok || rawID == "" {
		return false
	}
	for _, opt := range prop.options() {
		if optionID(opt) == rawID && strings.EqualFold(optionValue(opt), label) {
			return true
		}
	}
	return false
}

// cardHasSubtasks checks whether the card has at least one persisted child
// block of type=subtasks. Boards' subtasks block is stored as a content
// block under the card; presence of any block of that type counts.
func cardHasSubtasks(card *model.Card, _ *model.Board, backend Backend) (bool, error) {
	blocks, err := backend.GetBlocks(card.BoardID, card.ID, "subtasks")
	if err != nil {
		return false, err
	}
	return len(blocks) > 0, nil
}

// parseDueDateRange returns [from, to] in unix-ms for the named window, or
// for an explicit "YYYY-MM-DD..YYYY-MM-DD" range. Both ends are *inclusive*
// to avoid the "is the last second of the day in this week?" edge case.
// Empty input -> (0, 0, nil) -> no filter.
func parseDueDateRange(raw string) (int64, int64, error) {
	v := strings.TrimSpace(strings.ToLower(raw))
	if v == "" {
		return 0, 0, nil
	}
	now := time.Now()
	startOfDay := func(t time.Time) time.Time {
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	}
	endOfDay := func(t time.Time) time.Time {
		return time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, t.Location())
	}
	switch v {
	case "overdue":
		return 0, now.UnixMilli(), nil
	case "today":
		return startOfDay(now).UnixMilli(), endOfDay(now).UnixMilli(), nil
	case "this_week":
		offset := int(now.Weekday()) // Sunday=0 ... by convention treat Mon as start of week
		if offset == 0 {
			offset = 7
		}
		monday := startOfDay(now.AddDate(0, 0, -offset+1))
		sunday := endOfDay(monday.AddDate(0, 0, 6))
		return monday.UnixMilli(), sunday.UnixMilli(), nil
	case "next_week":
		offset := int(now.Weekday())
		if offset == 0 {
			offset = 7
		}
		mondayThis := startOfDay(now.AddDate(0, 0, -offset+1))
		mondayNext := mondayThis.AddDate(0, 0, 7)
		sundayNext := endOfDay(mondayNext.AddDate(0, 0, 6))
		return mondayNext.UnixMilli(), sundayNext.UnixMilli(), nil
	}
	if strings.Contains(v, "..") {
		parts := strings.SplitN(v, "..", 2)
		from, err := time.Parse("2006-01-02", strings.TrimSpace(parts[0]))
		if err != nil {
			return 0, 0, fmt.Errorf("from date: %w", err)
		}
		to, err := time.Parse("2006-01-02", strings.TrimSpace(parts[1]))
		if err != nil {
			return 0, 0, fmt.Errorf("to date: %w", err)
		}
		return startOfDay(from).UnixMilli(), endOfDay(to).UnixMilli(), nil
	}
	return 0, 0, fmt.Errorf("unknown range %q (try overdue / today / this_week / next_week / YYYY-MM-DD..YYYY-MM-DD)", raw)
}

func cardSummaryFor(card *model.Card, board *model.Board) cardSummary {
	out := cardSummary{
		ID:         card.ID,
		BoardID:    card.BoardID,
		BoardTitle: board.Title,
		Title:      card.Title,
		UpdateAt:   card.UpdateAt,
		UpdateISO:  msToISO(card.UpdateAt),
		Properties: card.Properties,
	}
	if statusProp := findPropertyByName(board, "status"); statusProp != nil {
		out.Status = resolveOptionLabel(card.Properties[statusProp.id()], statusProp)
	}
	if priorityProp := findPropertyByName(board, "priority"); priorityProp != nil {
		out.Priority = resolveOptionLabel(card.Properties[priorityProp.id()], priorityProp)
	}
	if due := findDueDateProperty(board); due != nil {
		if ms := extractDateMillis(card.Properties[due.id()]); ms > 0 {
			out.DueDate = msToISO(ms)
		}
	}
	for _, p := range findPersonProperties(board) {
		out.Assignees = append(out.Assignees, extractPersonIDs(card.Properties[p.id()])...)
	}
	return out
}

// =====================================================================
// get_card_details
// =====================================================================

type cardDetail struct {
	cardSummary
	Description string             `json:"description,omitempty"`
	Comments    []cardComment      `json:"comments,omitempty"`
	Subtasks    []map[string]interface{} `json:"subtasks,omitempty"`
	ContentOrder []string          `json:"content_order,omitempty"`
	CreatedBy   string             `json:"created_by,omitempty"`
	CreateAt    int64              `json:"create_at,omitempty"`
}

type cardComment struct {
	ID       string `json:"id"`
	UserID   string `json:"user_id"`
	Username string `json:"username,omitempty"`
	Text     string `json:"text"`
	CreateAt int64  `json:"create_at"`
	CreateISO string `json:"create_iso"`
}

func (s *Server) toolGetCardDetails() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "get_card_details",
			Description: "Returns full information about a card: title, description text (markdown), status, priority, due date, assignees, all custom properties, comments (with author + timestamp), subtask blocks, and metadata. Use the card_id obtained from search_cards() results.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id"],
				"properties": {
					"card_id": {"type": "string"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CardID string `json:"card_id"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" {
				return toolError("card_id is required"), nil
			}
			card, err := s.backend.GetCardByID(args.CardID)
			if err != nil || card == nil {
				return toolError("card not found: %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionViewBoard) {
				return toolError("permission denied"), nil
			}
			board, err := s.backend.GetBoard(card.BoardID)
			if err != nil || board == nil {
				return toolError("parent board missing"), nil
			}

			detail := cardDetail{
				cardSummary:  cardSummaryFor(card, board),
				ContentOrder: card.ContentOrder,
				CreatedBy:    card.CreatedBy,
				CreateAt:     card.CreateAt,
			}

			// Pull all blocks parented to the card. Description is
			// concatenated text content; comments and subtasks are
			// surfaced separately.
			contentBlocks, _ := s.backend.GetBlocks(card.BoardID, card.ID, "")
			var descParts []string
			for _, b := range contentBlocks {
				switch string(b.Type) {
				case "text":
					if b.Title != "" {
						descParts = append(descParts, b.Title)
					}
				case "comment":
					detail.Comments = append(detail.Comments, cardComment{
						ID:        b.ID,
						UserID:    b.ModifiedBy,
						Username:  s.usernameFor(b.ModifiedBy),
						Text:      b.Title,
						CreateAt:  b.CreateAt,
						CreateISO: msToISO(b.CreateAt),
					})
				case "subtasks":
					detail.Subtasks = append(detail.Subtasks, map[string]interface{}{
						"id":     b.ID,
						"title":  b.Title,
						"fields": b.Fields,
					})
				}
			}
			detail.Description = strings.Join(descParts, "\n\n")
			sort.Slice(detail.Comments, func(i, j int) bool {
				return detail.Comments[i].CreateAt < detail.Comments[j].CreateAt
			})
			return toolJSON(detail)
		},
	}
}

func (s *Server) usernameFor(userID string) string {
	if userID == "" {
		return ""
	}
	u, appErr := s.api.GetUser(userID)
	if appErr != nil || u == nil {
		return ""
	}
	return u.Username
}

// =====================================================================
// create_card
// =====================================================================

type createCardArgs struct {
	BoardID      string                 `json:"board_id"`
	Title        string                 `json:"title"`
	Description  string                 `json:"description"`
	AssignedTo   string                 `json:"assigned_to"`
	Status       string                 `json:"status"`
	Priority     string                 `json:"priority"`
	DueDate      string                 `json:"due_date"`
	ParentCardID string                 `json:"parent_card_id"`
	Properties   map[string]interface{} `json:"properties"`
}

func (s *Server) toolCreateCard() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "create_card",
			Description: "Creates a new card on a board. Title is required. assigned_to / status / priority / due_date are convenience shortcuts mapped onto the board's actual property templates (Person*, Status select, Priority select, Deadline / Date) — call get_board_info() first if you don't know what's available. Pass `properties` for any field you need to set explicitly by id.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["board_id", "title"],
				"properties": {
					"board_id":       {"type": "string"},
					"title":          {"type": "string"},
					"description":    {"type": "string"},
					"assigned_to":    {"type": "string", "description": "\"me\", a username, or empty."},
					"status":         {"type": "string"},
					"priority":       {"type": "string"},
					"due_date":       {"type": "string", "description": "YYYY-MM-DD."},
					"parent_card_id": {"type": "string"},
					"properties":     {"type": "object"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args createCardArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.BoardID == "" || args.Title == "" {
				return toolError("board_id and title are required"), nil
			}
			if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied to create cards on board %s", args.BoardID), nil
			}
			board, err := s.backend.GetBoard(args.BoardID)
			if err != nil || board == nil {
				return toolError("board not found: %s", args.BoardID), nil
			}

			properties := map[string]interface{}{}
			for k, v := range args.Properties {
				properties[k] = v
			}
			if err := s.applyConvenienceProps(board, userID, args.AssignedTo, args.Status, args.Priority, args.DueDate, properties); err != nil {
				return toolError("%v", err), nil
			}

			card := &model.Card{
				Title:        args.Title,
				Properties:   properties,
				ContentOrder: []string{},
			}
			// parent_card_id is accepted for API compatibility with the agent
			// spec but Boards has no native card-to-card hierarchy. Pass it as
			// a value to a task / multiTask property instead, or use the
			// Subtasks content block on the parent card.
			_ = args.ParentCardID

			created, err := s.backend.CreateCard(card, args.BoardID, userID, false)
			if err != nil {
				return toolError("create card: %v", err), nil
			}

			// Description: write a single text content block as the card body.
			if args.Description != "" {
				descBlock := &model.Block{
					ID:       utils.NewID(utils.IDTypeBlock),
					BoardID:  args.BoardID,
					ParentID: created.ID,
					Type:     "text",
					Title:    args.Description,
				}
				_ = s.backend.InsertBlockAndNotify(descBlock, userID, false)
			}

			return toolJSON(map[string]interface{}{
				"card":      created,
				"board_id":  args.BoardID,
				"card_link": fmt.Sprintf("/boards/team/%s/%s/0/%s", board.TeamID, args.BoardID, created.ID),
			})
		},
	}
}

// applyConvenienceProps maps the high-level shortcut arguments
// (assigned_to / status / priority / due_date) onto whichever board property
// templates can absorb them. Unknown values produce a returned error, which
// the tool surfaces as a per-call failure to the agent.
func (s *Server) applyConvenienceProps(
	board *model.Board, userID string,
	assignedTo, status, priority, dueDate string,
	out map[string]interface{},
) error {
	if assignedTo != "" {
		uid, err := s.resolveAssigneeID(userID, assignedTo)
		if err != nil {
			return err
		}
		// Pick the first person-typed property on the board to drop the user
		// into. Multi-person variants get an array; single-person gets a
		// string id.
		props := findPersonProperties(board)
		if len(props) == 0 {
			return errors.New("board has no Person property — use properties{} explicitly")
		}
		target := props[0]
		switch target.ptype() {
		case propTypeMultiPerson, propTypeMultiPersonNotify:
			out[target.id()] = []string{uid}
		default:
			out[target.id()] = uid
		}
	}
	if status != "" {
		prop := findPropertyByName(board, "status")
		if prop == nil || prop.ptype() != propTypeSelect {
			return errors.New("board has no Status select property")
		}
		id := findOptionIDByLabel(prop, status)
		if id == "" {
			return fmt.Errorf("status %q not in {%s}", status, optionList(prop))
		}
		out[prop.id()] = id
	}
	if priority != "" {
		prop := findPropertyByName(board, "priority")
		if prop == nil || prop.ptype() != propTypeSelect {
			return errors.New("board has no Priority select property")
		}
		id := findOptionIDByLabel(prop, priority)
		if id == "" {
			return fmt.Errorf("priority %q not in {%s}", priority, optionList(prop))
		}
		out[prop.id()] = id
	}
	if dueDate != "" {
		due := findDueDateProperty(board)
		if due == nil {
			return errors.New("board has no Deadline / Date property to hold due_date")
		}
		t, err := time.Parse("2006-01-02", dueDate)
		if err != nil {
			return fmt.Errorf("due_date must be YYYY-MM-DD: %w", err)
		}
		// Encode as Boards' standard JSON shape so the value renders with
		// the existing date editor and works with the deadline reminder.
		encoded := fmt.Sprintf(`{"from":%d}`, t.UnixMilli())
		out[due.id()] = encoded
	}
	return nil
}

func optionList(p propTemplate) string {
	opts := p.options()
	out := make([]string, 0, len(opts))
	for _, opt := range opts {
		out = append(out, optionValue(opt))
	}
	return strings.Join(out, ", ")
}

// =====================================================================
// update_card
// =====================================================================

type updateCardArgs struct {
	CardID  string                 `json:"card_id"`
	Changes map[string]interface{} `json:"changes"`
}

func (s *Server) toolUpdateCard() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "update_card",
			Description: "Updates an existing card. Pass `changes` as a dict; recognised keys are title, description, assigned_to, status, priority, due_date, properties. Properties is a partial map (id -> value) merged into the card's existing properties. Use this for status transitions ('move to Done'), reassignment, due-date updates, etc.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "changes"],
				"properties": {
					"card_id": {"type": "string"},
					"changes": {"type": "object"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args updateCardArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" || len(args.Changes) == 0 {
				return toolError("card_id and changes are required"), nil
			}
			existing, err := s.backend.GetCardByID(args.CardID)
			if err != nil || existing == nil {
				return toolError("card not found: %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, existing.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied to edit cards on board %s", existing.BoardID), nil
			}
			board, err := s.backend.GetBoard(existing.BoardID)
			if err != nil || board == nil {
				return toolError("parent board missing"), nil
			}

			patch := &model.CardPatch{}
			updatedProps := map[string]interface{}{}

			if v, ok := args.Changes["title"].(string); ok {
				patch.Title = &v
			}
			if v, ok := args.Changes["properties"].(map[string]interface{}); ok {
				for k, val := range v {
					updatedProps[k] = val
				}
			}
			// Convenience mapping. Pull each known shortcut.
			assignedTo, _ := args.Changes["assigned_to"].(string)
			status, _ := args.Changes["status"].(string)
			priority, _ := args.Changes["priority"].(string)
			dueDate, _ := args.Changes["due_date"].(string)
			if assignedTo != "" || status != "" || priority != "" || dueDate != "" {
				if err := s.applyConvenienceProps(board, userID, assignedTo, status, priority, dueDate, updatedProps); err != nil {
					return toolError("%v", err), nil
				}
			}
			if len(updatedProps) > 0 {
				patch.UpdatedProperties = updatedProps
			}

			// Description: replace by deleting old text content blocks and
			// inserting a fresh one. To keep this implementation small we
			// just append a new text block; full replace would also need to
			// delete the old ones via PatchBlock with DeleteAt set.
			if newDesc, ok := args.Changes["description"].(string); ok && newDesc != "" {
				descBlock := &model.Block{
					ID:       utils.NewID(utils.IDTypeBlock),
					BoardID:  existing.BoardID,
					ParentID: existing.ID,
					Type:     "text",
					Title:    newDesc,
				}
				_ = s.backend.InsertBlockAndNotify(descBlock, userID, false)
			}

			updated, err := s.backend.PatchCard(patch, args.CardID, userID, false)
			if err != nil {
				return toolError("update card: %v", err), nil
			}
			return toolJSON(map[string]interface{}{"card": updated})
		},
	}
}

// =====================================================================
// add_comment
// =====================================================================

type addCommentArgs struct {
	CardID string `json:"card_id"`
	Text   string `json:"text"`
}

func (s *Server) toolAddComment() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "add_comment",
			Description: "Adds a comment to a card on behalf of the current user. Use this for quick notes / status updates / questions on a specific task instead of editing the description.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "text"],
				"properties": {
					"card_id": {"type": "string"},
					"text":    {"type": "string"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args addCommentArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" || strings.TrimSpace(args.Text) == "" {
				return toolError("card_id and non-empty text are required"), nil
			}
			card, err := s.backend.GetCardByID(args.CardID)
			if err != nil || card == nil {
				return toolError("card not found: %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionCommentBoardCards) {
				return toolError("permission denied to comment on board %s", card.BoardID), nil
			}
			block := &model.Block{
				ID:         utils.NewID(utils.IDTypeBlock),
				BoardID:    card.BoardID,
				ParentID:   card.ID,
				Type:       "comment",
				Title:      args.Text,
				CreatedBy:  userID,
				ModifiedBy: userID,
			}
			if err := s.backend.InsertBlockAndNotify(block, userID, false); err != nil {
				return toolError("insert comment: %v", err), nil
			}
			return toolJSON(map[string]interface{}{"comment_id": block.ID})
		},
	}
}

// =====================================================================
// helpers
// =====================================================================

// msToISO renders a unix-ms timestamp as an RFC3339 UTC string. Returns
// empty for zero / negative values so the tool output omits the field
// rather than showing "1970-01-01T00:00:00Z".
func msToISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}
