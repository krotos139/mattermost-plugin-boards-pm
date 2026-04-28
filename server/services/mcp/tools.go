// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"
	"github.com/mattermost/mattermost/server/public/shared/mlog"
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
		s.toolGetCurrentUser(),
		s.toolListMyBoards(),
		s.toolGetBoardInfo(),
		s.toolListBoardMembers(),
		s.toolSearchCards(),
		s.toolGetCardDetails(),
		s.toolCreateCard(),
		s.toolUpdateCard(),
		s.toolBulkUpdateCards(),
		s.toolDeleteCard(),
		s.toolReorderCardContent(),
		s.toolAddSubtask(),
		s.toolUpdateSubtask(),
		s.toolDeleteSubtask(),
		s.toolAddCheckbox(),
		s.toolUpdateCheckbox(),
		s.toolDeleteCheckbox(),
		s.toolAddComment(),
		s.toolUpdateComment(),
		s.toolDeleteComment(),
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
	from, _ := extractDateMillisRange(raw)
	return from
}

// extractDateMillisRange parses a date / deadline property value and returns
// both ends of the date range as unix-ms (`from`, `to`). Either or both may
// be 0 when the corresponding bound is unset. Accepts the same shapes as
// extractDateMillis — `{"from":...,"to":...}` JSON-encoded as string, the same
// shape as a parsed map, a bare ms number, or ms-as-string.
func extractDateMillisRange(raw interface{}) (int64, int64) {
	if raw == nil {
		return 0, 0
	}
	parseString := func(s string) (int64, int64) {
		if s == "" {
			return 0, 0
		}
		if strings.HasPrefix(s, "{") {
			var d struct {
				From int64 `json:"from"`
				To   int64 `json:"to"`
			}
			if err := json.Unmarshal([]byte(s), &d); err == nil {
				return d.From, d.To
			}
		}
		var ms int64
		if _, err := fmt.Sscanf(s, "%d", &ms); err == nil {
			return ms, 0
		}
		return 0, 0
	}
	switch v := raw.(type) {
	case string:
		return parseString(v)
	case float64:
		return int64(v), 0
	case int64:
		return v, 0
	case map[string]interface{}:
		var from, to int64
		switch f := v["from"].(type) {
		case float64:
			from = int64(f)
		case int64:
			from = f
		}
		switch t := v["to"].(type) {
		case float64:
			to = int64(t)
		case int64:
			to = t
		}
		return from, to
	}
	return 0, 0
}

// extractStringArray turns a property value into a string slice. Multi-select /
// multi-person values are stored either as a real []string, a []interface{}
// of strings, or a JSON-stringified array. Returns nil for empty / unparseable.
func extractStringArray(raw interface{}) []string {
	if raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []string:
		return v
	case string:
		if v == "" {
			return nil
		}
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

// resolveNumber normalises a number-typed property value. Boards stores numbers
// as either float64 (after JSON decode) or as a string the user typed. When
// the value is integral we return int64 to keep the JSON output free of
// gratuitous trailing zeros.
func resolveNumber(raw interface{}) interface{} {
	switch v := raw.(type) {
	case float64:
		if v == float64(int64(v)) {
			return int64(v)
		}
		return v
	case int:
		return int64(v)
	case int64:
		return v
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		var n float64
		if _, err := fmt.Sscanf(v, "%f", &n); err == nil {
			if n == float64(int64(n)) {
				return int64(n)
			}
			return n
		}
		return v
	}
	return raw
}

// msDateOnlyISO renders a unix-ms timestamp as YYYY-MM-DD UTC. Returns empty
// for zero / negative values.
func msDateOnlyISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
}

// cardLinkFor builds a webapp deep link to a card. Format mirrors the URL the
// frontend constructs in CardActionsMenu. When the plugin has a SiteURL
// configured we prepend it so the agent can hand the user a clickable
// absolute URL straight from chat; otherwise the relative path is returned
// (which is still useful for in-product UI).
//
// canonicalOptionLabel strips the leading numeric prefix ("1. ") and any
// trailing emoji / symbol decoration from a select-option label, but
// preserves casing and inner whitespace. Use it for the *_canonical fields
// in cardSummary so the agent can quote a clean human label without
// re-doing the strip itself. Returns "" for empty input.
func (s *Server) cardLinkFor(b *model.Board, cardID string) string {
	if b == nil || cardID == "" {
		return ""
	}
	rel := fmt.Sprintf("/boards/team/%s/%s/0/%s", b.TeamID, b.ID, cardID)
	if base := s.siteURL(); base != "" {
		return base + rel
	}
	return rel
}

func canonicalOptionLabel(label string) string {
	s := optionLabelPrefixRE.ReplaceAllString(strings.TrimSpace(label), "")
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			b.WriteRune(r)
			prevSpace = false
		case unicode.IsSpace(r):
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
		case r == '-' || r == '_' || r == '/' || r == '.' || r == ',' || r == '(' || r == ')':
			b.WriteRune(r)
			prevSpace = false
		}
	}
	return strings.TrimSpace(b.String())
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
// progressively looser match. Order of attempts:
//
//  1. exact case-sensitive match against optionValue
//  2. exact case-insensitive match
//  3. normalized match: lowercase, trim, strip leading "1. " / "12. "
//     numeric prefix, and drop emoji / symbol characters
//
// Returns "" when nothing matches; lets the tools accept human labels
// ("In Progress", "high", "Medium 🔶", "1. High 🔥") in arguments without
// forcing the agent to reproduce the exact label including emoji decoration.
func findOptionIDByLabel(prop propTemplate, label string) string {
	if strings.TrimSpace(label) == "" {
		return ""
	}
	for _, opt := range prop.options() {
		if optionValue(opt) == label {
			return optionID(opt)
		}
	}
	target := strings.ToLower(strings.TrimSpace(label))
	for _, opt := range prop.options() {
		if strings.ToLower(optionValue(opt)) == target {
			return optionID(opt)
		}
	}
	targetNorm := normalizeOptionLabel(label)
	if targetNorm == "" {
		return ""
	}
	for _, opt := range prop.options() {
		if normalizeOptionLabel(optionValue(opt)) == targetNorm {
			return optionID(opt)
		}
	}
	return ""
}

// optionLabelPrefixRE matches a leading numeric ranking prefix used in many
// option labels ("1. High", "12. ToDo"). normalizeOptionLabel strips it so
// callers can pass either form.
var optionLabelPrefixRE = regexp.MustCompile(`^\d+\.\s+`)

// normalizeOptionLabel reduces a label to a comparable canonical form:
// lowercase, no leading numeric prefix, no emoji / symbol characters. Cyrillic
// / CJK / accented letters are preserved (only Unicode Symbol categories are
// dropped). Whitespace is collapsed to single spaces.
func normalizeOptionLabel(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = optionLabelPrefixRE.ReplaceAllString(s, "")
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			b.WriteRune(r)
			prevSpace = false
		case unicode.IsSpace(r):
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
		case r == '-' || r == '_' || r == '/' || r == '.' || r == ',':
			b.WriteRune(r)
			prevSpace = false
		}
	}
	return strings.TrimSpace(b.String())
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
// get_current_user
// =====================================================================

type currentUserInfo struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username,omitempty"`
	Email     string `json:"email,omitempty"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
}

func (s *Server) toolGetCurrentUser() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "get_current_user",
			Description: "Returns identity info for the user this MCP session is running as: user_id, username, email, plus first_name / last_name / nickname when those are populated in Mattermost (omitted when empty). Use this when you need to know who \"me\" is — to display the user's name, to address them, or when another tool requires a username. You do NOT need this for assigning cards: every tool that takes assigned_to / assignee accepts the literal string \"me\", which is resolved server-side to the calling user's id.",
			InputSchema: rawSchema(`{
				"type": "object",
				"properties": {}
			}`),
		},
		handler: func(_ context.Context, userID string, _ json.RawMessage) (toolsCallResult, error) {
			u, appErr := s.api.GetUser(userID)
			if appErr != nil || u == nil {
				return toolError("could not load user %s: %v", userID, appErr), nil
			}
			return toolJSON(currentUserInfo{
				UserID:    u.Id,
				Username:  u.Username,
				Email:     u.Email,
				FirstName: u.FirstName,
				LastName:  u.LastName,
				Nickname:  u.Nickname,
			})
		},
	}
}

// =====================================================================
// list_my_boards
// =====================================================================

type boardSummary struct {
	ID          string `json:"id"`
	TeamID      string `json:"team_id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type"`
	Icon        string `json:"icon,omitempty"`
	UpdateAt    int64  `json:"update_at"`
	UpdateAtISO string `json:"update_at_iso"`
	IsTemplate  bool   `json:"is_template,omitempty"`
}

func summarizeBoard(b *model.Board) boardSummary {
	return boardSummary{
		ID:          b.ID,
		TeamID:      b.TeamID,
		Title:       strings.TrimSpace(b.Title),
		Description: b.Description,
		Type:        boardTypeLabel(string(b.Type)),
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
			Description: "Returns all Focalboard boards the current user has access to. Use this when the user asks about their boards / projects / tasks but doesn't specify a particular board. Each entry has id, title, description, type (\"team\" / \"personal\" / \"open\"), and last-modified timestamp. Template boards are hidden by default — pass include_templates=true to include them too.",
			InputSchema: rawSchema(`{
				"type": "object",
				"properties": {
					"include_templates": {"type": "boolean", "description": "Also return template boards. Default false."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				IncludeTemplates bool `json:"include_templates"`
			}
			if len(raw) > 0 {
				_ = json.Unmarshal(raw, &args)
			}
			boards, err := s.boardsForUser(userID)
			if err != nil {
				return toolError("list boards: %v", err), nil
			}
			out := make([]boardSummary, 0, len(boards))
			for _, b := range boards {
				if b.IsTemplate && !args.IncludeTemplates {
					continue
				}
				out = append(out, summarizeBoard(b))
			}
			sort.Slice(out, func(i, j int) bool { return out[i].UpdateAt > out[j].UpdateAt })
			return toolJSON(map[string]interface{}{
				"boards": out,
				"count":  len(out),
			})
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
	ID                 string                `json:"id"`
	TeamID             string                `json:"team_id"`
	Title              string                `json:"title"`
	Description        string                `json:"description,omitempty"`
	Type               string                `json:"type"`
	IsTemplate         bool                  `json:"is_template,omitempty"`
	Properties         []boardPropertySchema `json:"properties"`
	StatusValues       []string              `json:"status_values,omitempty"`
	PriorityValues     []string              `json:"priority_values,omitempty"`
	DueDateProperty    string                `json:"due_date_property,omitempty"`
	AssigneeProperties []string              `json:"assignee_properties,omitempty"`
	Members            []boardMemberSummary  `json:"members,omitempty"`
	UpdateAt           int64                 `json:"update_at"`
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
			Description: "Returns metadata and schema for a specific board: title, description, status / priority option values, all custom property templates, the resolved due-date / assignee property names, and the list of board members (user_id + username + role). Call this BEFORE creating or modifying cards on an unfamiliar board so you know what option labels are valid. Distinguishes \"not found\" (404) from \"permission denied\" (403) in error messages so the agent doesn't ask the user for access to a board that doesn't exist.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["board_id"],
				"properties": {
					"board_id": {"type": "string", "description": "Board id from list_my_boards()."}
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
			// Order: existence check first, permission check second, so the
			// agent gets the more specific error. Reading the board itself
			// without permission is acceptable — we only surface metadata.
			board, err := s.backend.GetBoard(args.BoardID)
			if err != nil || board == nil {
				return toolError("not found: board %s", args.BoardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionViewBoard) {
				return toolError("permission denied: board %s", args.BoardID), nil
			}
			info := boardInfo{
				ID:          board.ID,
				TeamID:      board.TeamID,
				Title:       strings.TrimSpace(board.Title),
				Description: board.Description,
				Type:        boardTypeLabel(string(board.Type)),
				IsTemplate:  board.IsTemplate,
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
			info.Members = s.boardMembersFor(board.ID)
			return toolJSON(info)
		},
	}
}

// boardTypeLabel maps Boards' single-character board-type code to the
// human-readable noun the spec exposes ("personal" / "team" / "open"). Falls
// back to the raw code for unrecognised values so future additions still
// surface to the agent.
func boardTypeLabel(t string) string {
	switch t {
	case "P":
		return "personal"
	case "O":
		return "open"
	case "T":
		return "team"
	}
	return t
}

// boardMembersFor enumerates the members of a board enriched with usernames.
// Returns an empty slice on backend errors so the rest of the board info
// still renders — membership listing is best-effort surface area.
func (s *Server) boardMembersFor(boardID string) []boardMemberSummary {
	members, err := s.backend.GetMembersForBoard(boardID)
	if err != nil || len(members) == 0 {
		return nil
	}
	out := make([]boardMemberSummary, 0, len(members))
	for _, m := range members {
		role := "viewer"
		switch {
		case m.SchemeAdmin:
			role = "admin"
		case m.SchemeEditor:
			role = "editor"
		case m.SchemeCommenter:
			role = "commenter"
		}
		out = append(out, boardMemberSummary{
			UserID:   m.UserID,
			Username: s.usernameFor(m.UserID),
			Role:     role,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}

// =====================================================================
// search_cards
// =====================================================================

type searchCardsArgs struct {
	BoardID              string `json:"board_id"`
	TextQuery            string `json:"text_query"`
	AssignedTo           string `json:"assigned_to"`
	Status               string `json:"status"`
	Priority             string `json:"priority"`
	DueDateRange         string `json:"due_date_range"`
	HasSubtasks          *bool  `json:"has_subtasks"`
	Limit                int    `json:"limit"`
	Cursor               string `json:"cursor"`
	IncludeRawProperties bool   `json:"include_raw_properties"`
	IncludeTemplates     bool   `json:"include_templates"`
}

// paginationCursor is the opaque payload encoded into the `cursor` field
// returned in search responses. Today only an offset is needed; the JSON
// shape leaves room to add board-/card-id keys later for stable resumption
// across edits without breaking existing clients (unknown fields are ignored).
type paginationCursor struct {
	Offset int `json:"o"`
}

func encodeCursor(offset int) string {
	if offset <= 0 {
		return ""
	}
	b, _ := json.Marshal(paginationCursor{Offset: offset})
	return base64.URLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	raw, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return 0, fmt.Errorf("invalid cursor: %w", err)
	}
	var c paginationCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return 0, fmt.Errorf("invalid cursor: %w", err)
	}
	if c.Offset < 0 {
		return 0, errors.New("invalid cursor: negative offset")
	}
	return c.Offset, nil
}

// anyBoardHasSelectOption reports whether at least one board in the slice has
// a select property of the given name with an option matching `label`
// (fuzzy-matched via findOptionIDByLabel). Used to validate user-supplied
// status / priority filters before they silently match nothing.
func anyBoardHasSelectOption(boards []*model.Board, propName, label string) bool {
	for _, b := range boards {
		prop := findPropertyByName(b, propName)
		if prop == nil || prop.ptype() != propTypeSelect {
			continue
		}
		if findOptionIDByLabel(prop, label) != "" {
			return true
		}
	}
	return false
}

// collectSelectOptionLabels returns the deduplicated list of option labels
// across every board's named select property. Used to populate validation
// error messages so the agent can self-correct.
func collectSelectOptionLabels(boards []*model.Board, propName string) []string {
	seen := map[string]bool{}
	var out []string
	for _, b := range boards {
		prop := findPropertyByName(b, propName)
		if prop == nil || prop.ptype() != propTypeSelect {
			continue
		}
		for _, opt := range prop.options() {
			v := optionValue(opt)
			if v != "" && !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	return out
}

// assigneeRef is the JSON shape used wherever a tool returns a Mattermost
// user reference: a stable id plus the human-readable username so the agent
// can render the value without an extra users/get round-trip.
type assigneeRef struct {
	UserID   string `json:"user_id"`
	Username string `json:"username,omitempty"`
}

// dateRange is the resolved form of a date / deadline property — both ends in
// ISO YYYY-MM-DD. `to` is omitted when only a single date was set.
type dateRange struct {
	From string `json:"from"`
	To   string `json:"to,omitempty"`
}

// cardSummary is a search-result row: card identity, title, key properties
// resolved to human labels, and the parent board id so the agent can fetch
// the full board context if needed.
//
// Status / Priority / DueDate are pointers so unset values render as JSON
// `null` rather than `""` — that lets agents distinguish "field unset" from
// "field cleared to empty string". Assignees is always serialised (`[]` when
// empty, never `null`) so result rows have a uniform shape.
//
// Properties is the resolved map keyed by property name (so the agent doesn't
// need to call get_board_info first to translate ids). Pass
// include_raw_properties=true on the tool call to also receive the raw
// id-keyed map under properties_raw.
type cardSummary struct {
	ID                string                 `json:"id"`
	BoardID           string                 `json:"board_id"`
	BoardTitle        string                 `json:"board_title"`
	Title             string                 `json:"title"`
	Status            *string                `json:"status"`
	StatusCanonical   *string                `json:"status_canonical,omitempty"`
	Priority          *string                `json:"priority"`
	PriorityCanonical *string                `json:"priority_canonical,omitempty"`
	Assignees         []assigneeRef          `json:"assignees"`
	DueDate           *string                `json:"due_date"`
	CardLink          string                 `json:"card_link"`
	CreatedBy         *assigneeRef           `json:"created_by,omitempty"`
	ModifiedBy        *assigneeRef           `json:"modified_by,omitempty"`
	CreateAt          int64                  `json:"create_at,omitempty"`
	CreateISO         string                 `json:"create_iso,omitempty"`
	UpdateAt          int64                  `json:"update_at"`
	UpdateISO         string                 `json:"update_iso"`
	SubtaskCount      int                    `json:"subtask_count"`
	SubtaskChecked    int                    `json:"subtask_checked"`
	CheckboxCount     int                    `json:"checkbox_count"`
	CheckboxChecked   int                    `json:"checkbox_checked"`
	Properties        map[string]interface{} `json:"properties"`
	PropertiesRaw     map[string]interface{} `json:"properties_raw,omitempty"`
}

func (s *Server) toolSearchCards() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "search_cards",
			Description: "Primary tool for finding tasks (cards). All parameters are optional and combine. By default every card on the matched board(s) is returned, including cards with no status / priority / due date / assignee set — those fields come back as JSON null and `assignees` is `[]`. Status and priority match fuzzily: case-insensitive, with leading numeric prefixes (\"1. \") and trailing emoji decoration stripped, so passing \"high\" matches an option labelled \"1. High 🔥\". Properties are returned resolved by name (e.g. {\"Status\": \"Done\", \"Assignee\": {\"user_id\": \"...\", \"username\": \"...\"}}); pass include_raw_properties=true to also receive the raw id-keyed map. text_query is a case-insensitive substring match against the card title AND every text-bearing content block (description, comments, subtasks, checkboxes) — a hit anywhere is enough. Use the `cursor` returned in the response to paginate large result sets.",
			InputSchema: rawSchema(`{
				"type": "object",
				"properties": {
					"board_id":               {"type": "string", "description": "Optional. Restrict to a single board; omit to search across every board the user can access."},
					"text_query":             {"type": "string", "description": "Case-insensitive substring. Matches the card title and every text-bearing content block (description, comments, subtasks, checkboxes); a hit in any of these admits the card."},
					"assigned_to":            {"type": "string", "description": "\"me\" (caller), a Mattermost username, \"any\" (matches any card with at least one assignee set), or \"unassigned\" (no assignees)."},
					"status":                 {"type": "string", "description": "Status option label. Fuzzy: case-insensitive, leading \"1. \" / numeric prefix and emoji are ignored."},
					"priority":               {"type": "string", "description": "Priority option label. Same fuzzy matching rules as status."},
					"due_date_range":         {"type": "string", "description": "\"overdue\" (any due date < now), \"today\", \"this_week\", \"next_week\", or YYYY-MM-DD..YYYY-MM-DD (inclusive on both ends)."},
					"has_subtasks":           {"type": "boolean", "description": "Filter to cards that do (true) / don't (false) have at least one subtask block. Omit to skip the filter."},
					"limit":                  {"type": "integer", "minimum": 1, "maximum": 500, "description": "Page size. Default 50."},
					"cursor":                 {"type": "string", "description": "Opaque pagination cursor copied from a previous response's next_cursor. Omit on the first call."},
					"include_raw_properties": {"type": "boolean", "description": "Also return the raw id-keyed property map under properties_raw on each card. Default false."},
					"include_templates":      {"type": "boolean", "description": "Also include template boards (normally hidden). Default false."}
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
			offset, err := decodeCursor(args.Cursor)
			if err != nil {
				return toolError("%v", err), nil
			}

			// Determine which boards to search.
			var targetBoards []*model.Board
			if args.BoardID != "" {
				b, err := s.backend.GetBoard(args.BoardID)
				if err != nil || b == nil {
					return toolError("not found: board %s", args.BoardID), nil
				}
				if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionViewBoard) {
					return toolError("permission denied: board %s", args.BoardID), nil
				}
				targetBoards = []*model.Board{b}
			} else {
				bs, err := s.boardsForUser(userID)
				if err != nil {
					return toolError("list boards: %v", err), nil
				}
				for _, b := range bs {
					if b.IsTemplate && !args.IncludeTemplates {
						continue
					}
					targetBoards = append(targetBoards, b)
				}
			}
			if len(targetBoards) == 0 {
				return toolJSON(map[string]interface{}{
					"cards":       []cardSummary{},
					"count":       0,
					"total":       0,
					"limit":       limit,
					"next_cursor": "",
				})
			}

			// Validate select-typed filters before scanning so a typo doesn't
			// silently come back as zero matches.
			if args.Status != "" && !anyBoardHasSelectOption(targetBoards, "status", args.Status) {
				opts := collectSelectOptionLabels(targetBoards, "status")
				if len(opts) == 0 {
					return toolError("status %q rejected: none of the target boards have a Status select property", args.Status), nil
				}
				return toolError("status %q not in {%s}", args.Status, strings.Join(opts, ", ")), nil
			}
			if args.Priority != "" && !anyBoardHasSelectOption(targetBoards, "priority", args.Priority) {
				opts := collectSelectOptionLabels(targetBoards, "priority")
				if len(opts) == 0 {
					return toolError("priority %q rejected: none of the target boards have a Priority select property", args.Priority), nil
				}
				return toolError("priority %q not in {%s}", args.Priority, strings.Join(opts, ", ")), nil
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

			// Collect matches across boards. Sort by UpdateAt DESC, then apply
			// cursor offset and limit. Hard cap to prevent runaway memory if
			// the agent omits all filters on a huge install.
			const matchHardCap = 5000
			matches := make([]cardSummary, 0, limit*2)
			for _, board := range targetBoards {
				if len(matches) >= matchHardCap {
					break
				}
				cards, cerr := s.backend.GetCardsForBoard(board.ID, 0, 1000)
				if cerr != nil {
					continue
				}
				// Decide whether the per-card block fetch is needed before the
				// filter even runs (text_query scans block bodies, has_subtasks
				// counts subtask blocks). When neither filter needs blocks we
				// defer the fetch to the matched-card path so non-matching
				// cards don't pay for it.
				needBlocksForFilter := args.TextQuery != "" || args.HasSubtasks != nil
				for _, card := range cards {
					if len(matches) >= matchHardCap {
						break
					}
					var blocks []*model.Block
					blocksLoaded := false
					if needBlocksForFilter {
						blocks, _ = s.backend.GetBlocks(board.ID, card.ID, "")
						blocksLoaded = true
					}
					if !cardMatches(card, board, args, assigneeFilter, dueFrom, dueTo, blocks) {
						continue
					}
					if !blocksLoaded {
						blocks, _ = s.backend.GetBlocks(board.ID, card.ID, "")
					}
					matches = append(matches, s.cardSummaryForWithBlocks(card, board, args.IncludeRawProperties, blocks))
				}
			}
			sort.Slice(matches, func(i, j int) bool { return matches[i].UpdateAt > matches[j].UpdateAt })

			total := len(matches)
			if offset >= total {
				return toolJSON(map[string]interface{}{
					"cards":       []cardSummary{},
					"count":       0,
					"total":       total,
					"limit":       limit,
					"next_cursor": "",
				})
			}
			end := offset + limit
			if end > total {
				end = total
			}
			page := matches[offset:end]
			next := ""
			if end < total {
				next = encodeCursor(end)
			}
			return toolJSON(map[string]interface{}{
				"cards":       page,
				"count":       len(page),
				"total":       total,
				"limit":       limit,
				"next_cursor": next,
			})
		},
	}
}

// cardMatches evaluates every search filter against one card. Filters with
// empty / zero values are skipped (i.e. "match anything"). The caller passes
// the card's pre-fetched content blocks (or nil); cardMatches uses them for
// text body / has_subtasks filters but tolerates a nil slice when neither
// filter is active.
func cardMatches(
	card *model.Card,
	board *model.Board,
	args searchCardsArgs,
	assigneeFilter string,
	dueFrom, dueTo int64,
	blocks []*model.Block,
) bool {
	if args.TextQuery != "" {
		if !cardMatchesText(card, args.TextQuery, blocks) {
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
		hasSub := false
		for _, b := range blocks {
			if string(b.Type) == "subtask" {
				hasSub = true
				break
			}
		}
		if hasSub != *args.HasSubtasks {
			return false
		}
	}
	return true
}

// cardMatchesText returns true when the query is a case-insensitive substring
// of the card title or of any text-bearing content block (description text,
// comments, subtasks, checkboxes). The body scan is what makes search_cards
// useful for "find the card I wrote about X in a checkbox last week" — agents
// no longer have to walk get_card_details across every result.
func cardMatchesText(card *model.Card, query string, blocks []*model.Block) bool {
	if query == "" {
		return true
	}
	needle := strings.ToLower(query)
	if strings.Contains(strings.ToLower(card.Title), needle) {
		return true
	}
	for _, b := range blocks {
		switch string(b.Type) {
		case "text", "comment", "subtask", "checkbox":
			if strings.Contains(strings.ToLower(b.Title), needle) {
				return true
			}
		}
	}
	return false
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
// matches the requested label using fuzzy matching (lowercase, leading "1. "
// numeric prefix and emoji decoration both ignored — see findOptionIDByLabel
// for the full ordering of attempts). Boards with no such property never
// match (no row to filter on).
func cardMatchesSelect(card *model.Card, board *model.Board, propName, label string) bool {
	prop := findPropertyByName(board, propName)
	if prop == nil || prop.ptype() != propTypeSelect {
		return false
	}
	targetID := findOptionIDByLabel(prop, label)
	if targetID == "" {
		return false
	}
	rawID, _ := card.Properties[prop.id()].(string)
	return rawID == targetID
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

// cardSummaryFor projects a backend Card onto the MCP-facing cardSummary,
// resolving every property template into a human-readable form.
//
// Resolution rules per template type:
//
//   - select          -> option label string ("In Progress")
//   - multiSelect     -> []string of option labels
//   - person*         -> assigneeRef ({user_id, username})
//   - multiPerson*    -> []assigneeRef
//   - date / deadline -> dateRange ({from: "YYYY-MM-DD", to: ...})
//   - createdTime / updatedTime -> ISO timestamp string
//   - number          -> int64 / float64 (integral values stay int)
//   - others          -> raw value passed through (text / email / phone / url / checkbox)
//
// Stale property ids that no longer match any board template are dropped from
// the resolved map but preserved under properties_raw when includeRaw=true.
//
// cardSummaryFor fetches the card's content blocks itself to populate the
// subtask / checkbox counters; cardSummaryForWithBlocks lets the caller
// pass a pre-fetched block slice (used by search_cards which already has
// to load them for text-body matching, so we don't double-fetch).
func (s *Server) cardSummaryFor(card *model.Card, board *model.Board, includeRaw bool) cardSummary {
	blocks, _ := s.backend.GetBlocks(card.BoardID, card.ID, "")
	return s.cardSummaryForWithBlocks(card, board, includeRaw, blocks)
}

func (s *Server) cardSummaryForWithBlocks(card *model.Card, board *model.Board, includeRaw bool, blocks []*model.Block) cardSummary {
	rawProps := card.Properties
	if rawProps == nil {
		rawProps = map[string]interface{}{}
	}

	templatesByID := make(map[string]propTemplate, len(board.CardProperties))
	for _, p := range boardProperties(board) {
		templatesByID[p.id()] = p
	}

	resolved := map[string]interface{}{}
	for id, val := range rawProps {
		prop, ok := templatesByID[id]
		if !ok {
			continue
		}
		if v := s.resolvePropertyValue(val, prop); v != nil {
			resolved[prop.name()] = v
		}
	}

	out := cardSummary{
		ID:         card.ID,
		BoardID:    card.BoardID,
		BoardTitle: strings.TrimSpace(board.Title),
		Title:      strings.TrimSpace(card.Title),
		Assignees:  []assigneeRef{},
		CardLink:   s.cardLinkFor(board, card.ID),
		CreateAt:   card.CreateAt,
		CreateISO:  msToISO(card.CreateAt),
		UpdateAt:   card.UpdateAt,
		UpdateISO:  msToISO(card.UpdateAt),
		Properties: resolved,
	}
	if includeRaw {
		rawCopy := make(map[string]interface{}, len(rawProps))
		for k, v := range rawProps {
			rawCopy[k] = v
		}
		out.PropertiesRaw = rawCopy
	}

	if statusProp := findPropertyByName(board, "status"); statusProp != nil {
		if label := resolveOptionLabel(rawProps[statusProp.id()], statusProp); label != "" {
			out.Status = &label
			if c := canonicalOptionLabel(label); c != "" && c != label {
				out.StatusCanonical = &c
			}
		}
	}
	if priorityProp := findPropertyByName(board, "priority"); priorityProp != nil {
		if label := resolveOptionLabel(rawProps[priorityProp.id()], priorityProp); label != "" {
			out.Priority = &label
			if c := canonicalOptionLabel(label); c != "" && c != label {
				out.PriorityCanonical = &c
			}
		}
	}
	if due := findDueDateProperty(board); due != nil {
		if ms := extractDateMillis(rawProps[due.id()]); ms > 0 {
			iso := msDateOnlyISO(ms)
			out.DueDate = &iso
		}
	}
	seen := map[string]bool{}
	for _, p := range findPersonProperties(board) {
		for _, id := range extractPersonIDs(rawProps[p.id()]) {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			out.Assignees = append(out.Assignees, s.assigneeRefFor(id))
		}
	}
	if card.CreatedBy != "" {
		ref := s.assigneeRefFor(card.CreatedBy)
		out.CreatedBy = &ref
	}
	if card.ModifiedBy != "" && card.ModifiedBy != card.CreatedBy {
		ref := s.assigneeRefFor(card.ModifiedBy)
		out.ModifiedBy = &ref
	}
	// Subtask + checkbox counts. Caller passes the card's content blocks so
	// search_cards reuses the same fetch it already did for text-body
	// matching; single-card paths (create_card, update_card,
	// get_card_details) load them via the cardSummaryFor wrapper. Lets the
	// agent answer "show cards with open checkboxes" without N round-trips
	// through get_card_details.
	for _, b := range blocks {
		switch string(b.Type) {
		case "subtask":
			out.SubtaskCount++
			if v, ok := b.Fields["value"].(bool); ok && v {
				out.SubtaskChecked++
			}
		case "checkbox":
			out.CheckboxCount++
			if v, ok := b.Fields["value"].(bool); ok && v {
				out.CheckboxChecked++
			}
		}
	}
	return out
}

// resolvePropertyValue maps one stored property value onto its human-readable
// resolved form. See cardSummaryFor for the per-type rules.
func (s *Server) resolvePropertyValue(raw interface{}, prop propTemplate) interface{} {
	if raw == nil {
		return nil
	}
	switch prop.ptype() {
	case propTypeSelect:
		id, ok := raw.(string)
		if !ok || id == "" {
			return nil
		}
		for _, opt := range prop.options() {
			if optionID(opt) == id {
				return optionValue(opt)
			}
		}
		return id
	case propTypeMultiSelect:
		ids := extractStringArray(raw)
		if len(ids) == 0 {
			return nil
		}
		labels := make([]string, 0, len(ids))
		for _, id := range ids {
			label := id
			for _, opt := range prop.options() {
				if optionID(opt) == id {
					label = optionValue(opt)
					break
				}
			}
			labels = append(labels, label)
		}
		return labels
	case propTypePerson, propTypePersonNotify:
		id, ok := raw.(string)
		if !ok || id == "" {
			return nil
		}
		ref := s.assigneeRefFor(id)
		return ref
	case propTypeMultiPerson, propTypeMultiPersonNotify:
		ids := extractPersonIDs(raw)
		if len(ids) == 0 {
			return nil
		}
		out := make([]assigneeRef, 0, len(ids))
		for _, id := range ids {
			out = append(out, s.assigneeRefFor(id))
		}
		return out
	case propTypeDate, propTypeDeadline:
		from, to := extractDateMillisRange(raw)
		if from == 0 && to == 0 {
			return nil
		}
		out := dateRange{From: msDateOnlyISO(from)}
		if to != 0 {
			out.To = msDateOnlyISO(to)
		}
		return out
	case propTypeCreatedTime, propTypeUpdatedTime:
		if ms := extractDateMillis(raw); ms > 0 {
			return msToISO(ms)
		}
		return nil
	case propTypeNumber:
		return resolveNumber(raw)
	default:
		return raw
	}
}

// assigneeRefFor wraps a userID with its current username via the plugin API.
// Falls back to an empty username when the user is missing / inaccessible —
// callers always get a non-empty user_id to work with.
func (s *Server) assigneeRefFor(userID string) assigneeRef {
	return assigneeRef{UserID: userID, Username: s.usernameFor(userID)}
}

// =====================================================================
// get_card_details
// =====================================================================

// cardDetail is the get_card_details response body. Comments / subtasks /
// checkboxes / content_order are always emitted as arrays — empty as `[]`,
// never omitted — so the agent can write `card.subtasks.length` without
// guarding for a missing key. Description stays omitempty because empty
// description is naturally absent from the agent's prose.
type cardDetail struct {
	cardSummary
	Description  string         `json:"description,omitempty"`
	Comments     []cardComment  `json:"comments"`
	Subtasks     []cardSubtask  `json:"subtasks"`
	Checkboxes   []cardCheckbox `json:"checkboxes"`
	ContentOrder []string       `json:"content_order"`
}

// cardCheckbox is the resolved view of a Boards "checkbox" content block — a
// simple inline todo in the card body (text + checked flag). Distinct from a
// "checkbox" property template, which is a board-level column on the card.
type cardCheckbox struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Checked   bool   `json:"checked"`
	CreateAt  int64  `json:"create_at,omitempty"`
	CreateISO string `json:"create_iso,omitempty"`
}

// cardSubtask is the resolved view of a Boards "subtask" content block. The
// done/not-done state lives at block.Fields["value"] as a bool — the same
// shape checkbox blocks use. Earlier iterations of the API tried to expose
// the optionId of a subtask-states select property, but no Focalboard board
// actually configures that property, so the field was dead weight; the
// `checked` boolean is the only state Focalboard's UI renders.
type cardSubtask struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Checked   bool   `json:"checked"`
	CreateAt  int64  `json:"create_at,omitempty"`
	CreateISO string `json:"create_iso,omitempty"`
}

type cardComment struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Username  string `json:"username,omitempty"`
	Text      string `json:"text"`
	CreateAt  int64  `json:"create_at"`
	CreateISO string `json:"create_iso"`
}

func (s *Server) toolGetCardDetails() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "get_card_details",
			Description: "Returns full information about a card: title, description (markdown), status, priority, due date, assignees, all custom properties (resolved by name to human values, e.g. {\"Status\": \"Done\", \"Assignee\": {\"user_id\": \"...\", \"username\": \"...\"}}), comments (author + timestamp), subtask blocks (id, title, checked), checkbox blocks (id, title, checked), and content_order. comments / subtasks / checkboxes / content_order always come back as arrays (possibly empty), never omitted. Use the card_id obtained from search_cards() results. Pass include_raw_properties=true to also receive the raw id-keyed property map under properties_raw.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id"],
				"properties": {
					"card_id": {"type": "string", "description": "Card id from search_cards()."},
					"include_raw_properties": {"type": "boolean", "description": "Also return the raw id-keyed property map under properties_raw. Default false."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CardID               string `json:"card_id"`
				IncludeRawProperties bool   `json:"include_raw_properties"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" {
				return toolError("card_id is required"), nil
			}
			card, err := s.backend.GetCardByID(args.CardID)
			if err != nil || card == nil {
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionViewBoard) {
				return toolError("permission denied: card %s", args.CardID), nil
			}
			board, err := s.backend.GetBoard(card.BoardID)
			if err != nil || board == nil {
				return toolError("not found: parent board %s", card.BoardID), nil
			}

			contentOrder := card.ContentOrder
			if contentOrder == nil {
				contentOrder = []string{}
			}
			detail := cardDetail{
				cardSummary:  s.cardSummaryFor(card, board, args.IncludeRawProperties),
				Comments:     []cardComment{},
				Subtasks:     []cardSubtask{},
				Checkboxes:   []cardCheckbox{},
				ContentOrder: contentOrder,
			}

			// Pull all blocks parented to the card. Description is
			// concatenated text content; comments / subtasks / checkboxes
			// are surfaced separately. Subtask blocks are stored as
			// type=subtask (singular) — the plural would silently miss them.
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
				case "subtask":
					detail.Subtasks = append(detail.Subtasks, subtaskFromBlock(b))
				case "checkbox":
					detail.Checkboxes = append(detail.Checkboxes, checkboxFromBlock(b))
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
			Description: "Creates a new card on a board. Title is required. assigned_to accepts the literal \"me\" (the user calling this tool — never ask them for their id) or a Mattermost username. status / priority / due_date are convenience shortcuts mapped onto the board's actual property templates (Person*, Status select, Priority select, Deadline / Date). status and priority match fuzzily — case-insensitive, with leading numeric prefixes and emojis stripped. Pass `properties` for any custom field you need to set explicitly by id. Returns the created card in the same shape as get_card_details() — title, status, priority, assignees, due_date, resolved properties, card_link — so you don't need a follow-up read.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["board_id", "title"],
				"properties": {
					"board_id":       {"type": "string", "description": "Board id from list_my_boards()."},
					"title":          {"type": "string", "description": "Card title (will be trimmed of surrounding whitespace)."},
					"description":    {"type": "string", "description": "Markdown body. Stored as a single text content block."},
					"assigned_to":    {"type": "string", "description": "\"me\", a Mattermost username, or empty."},
					"status":         {"type": "string", "description": "Status option label (fuzzy)."},
					"priority":       {"type": "string", "description": "Priority option label (fuzzy)."},
					"due_date":       {"type": "string", "description": "YYYY-MM-DD."},
					"parent_card_id": {"type": "string", "description": "Reserved for future card-hierarchy support; ignored today."},
					"properties":     {"type": "object", "description": "Raw property values keyed by property id (use get_board_info() to discover ids)."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args createCardArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.BoardID == "" || strings.TrimSpace(args.Title) == "" {
				return toolError("board_id and title are required"), nil
			}
			board, err := s.backend.GetBoard(args.BoardID)
			if err != nil || board == nil {
				return toolError("not found: board %s", args.BoardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied: cannot create cards on board %s", args.BoardID), nil
			}

			properties := map[string]interface{}{}
			for k, v := range args.Properties {
				properties[k] = v
			}
			if err := s.applyConvenienceProps(board, userID, args.AssignedTo, args.Status, args.Priority, args.DueDate, properties); err != nil {
				return toolError("%v", err), nil
			}

			card := &model.Card{
				Title:        strings.TrimSpace(args.Title),
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
			if strings.TrimSpace(args.Description) != "" {
				descBlock := &model.Block{
					ID:       utils.NewID(utils.IDTypeBlock),
					BoardID:  args.BoardID,
					ParentID: created.ID,
					Type:     "text",
					Title:    args.Description,
				}
				_ = s.backend.InsertBlockAndNotify(descBlock, userID, false)
			}

			// Re-read the card so the response reflects any defaults the
			// backend filled in (CreateAt, UpdateAt, etc).
			persisted, err := s.backend.GetCardByID(created.ID)
			if err != nil || persisted == nil {
				persisted = created
			}
			return toolJSON(s.cardSummaryFor(persisted, board, false))
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

// validUpdateChangeKeys lists every recognised key inside `update_card.changes`.
// An unknown key is rejected up-front so a typo ("statuss") doesn't produce a
// silent no-op (the previous behaviour where everything else was applied and
// the typo was ignored). Keep alphabetical for easy auditing.
var validUpdateChangeKeys = map[string]struct{}{
	"assigned_to": {},
	"description": {},
	"due_date":    {},
	"priority":    {},
	"properties":  {},
	"status":      {},
	"title":       {},
}

func sortedValidUpdateChangeKeys() []string {
	out := make([]string, 0, len(validUpdateChangeKeys))
	for k := range validUpdateChangeKeys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (s *Server) toolUpdateCard() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "update_card",
			Description: "Updates an existing card. Pass `changes` as a dict; recognised keys are title, description, assigned_to, status, priority, due_date, properties — any other key is rejected with the list of valid ones (so a typo never silently no-ops). assigned_to accepts \"me\" (the calling user) or a Mattermost username. status / priority match fuzzily (case-insensitive, leading numeric prefix and emoji ignored). Properties is a partial id->value map merged into the card's existing properties. Returns the updated card in the same shape as get_card_details().",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "changes"],
				"properties": {
					"card_id": {"type": "string", "description": "Card id from search_cards()."},
					"changes": {"type": "object", "description": "Map of field-name to new value. Allowed keys: title, description, assigned_to, status, priority, due_date, properties."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args updateCardArgs
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" || len(args.Changes) == 0 {
				return toolError("card_id and a non-empty changes object are required"), nil
			}
			// Reject unknown keys before doing any work so we never leave a
			// partial update applied with an unrecognised key dropped.
			var unknown []string
			for k := range args.Changes {
				if _, ok := validUpdateChangeKeys[k]; !ok {
					unknown = append(unknown, k)
				}
			}
			if len(unknown) > 0 {
				sort.Strings(unknown)
				return toolError("unknown change key(s) %v — valid keys are %v",
					unknown, sortedValidUpdateChangeKeys()), nil
			}

			existing, err := s.backend.GetCardByID(args.CardID)
			if err != nil || existing == nil {
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, existing.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied: cannot edit cards on board %s", existing.BoardID), nil
			}
			board, err := s.backend.GetBoard(existing.BoardID)
			if err != nil || board == nil {
				return toolError("not found: parent board %s", existing.BoardID), nil
			}

			patch := &model.CardPatch{}
			updatedProps := map[string]interface{}{}

			if v, ok := args.Changes["title"].(string); ok {
				trimmed := strings.TrimSpace(v)
				patch.Title = &trimmed
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
			// Merge with the card's existing properties before sending the
			// patch. Boards' BlockPatch.Patch overwrites block.Fields["properties"]
			// wholesale with whatever map we put in CardPatch.UpdatedProperties,
			// so a partial map would drop every untouched property (status,
			// assignee, dates, etc.). The webapp avoids this by always sending
			// the full merged map; we have to do the same.
			if len(updatedProps) > 0 {
				merged := make(map[string]interface{}, len(existing.Properties)+len(updatedProps))
				for k, v := range existing.Properties {
					merged[k] = v
				}
				for k, v := range updatedProps {
					merged[k] = v
				}
				patch.UpdatedProperties = merged
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
			return toolJSON(s.cardSummaryFor(updated, board, false))
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
			Description: "Adds a comment to a card on behalf of the current user. Use this for quick notes / status updates / questions on a specific task instead of editing the description. Returns the new comment_id, card_id, card_link, and the create timestamp.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "text"],
				"properties": {
					"card_id": {"type": "string"},
					"text":    {"type": "string", "description": "Comment body (markdown). Cannot be empty."}
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
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionCommentBoardCards) {
				return toolError("permission denied: cannot comment on board %s", card.BoardID), nil
			}
			board, _ := s.backend.GetBoard(card.BoardID)
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
			// Re-read the persisted block so we return the real CreateAt the
			// store assigned, not the zero value the in-memory block had
			// before insert. add_subtask / add_checkbox use the same trick.
			persisted, err := s.backend.GetBlockByID(block.ID)
			if err != nil || persisted == nil {
				persisted = block
			}
			out := map[string]interface{}{
				"ok":         true,
				"comment_id": persisted.ID,
				"card_id":    card.ID,
				"create_at":  persisted.CreateAt,
				"create_iso": msToISO(persisted.CreateAt),
			}
			if board != nil {
				out["card_link"] = s.cardLinkFor(board, card.ID)
			}
			return toolJSON(out)
		},
	}
}

// =====================================================================
// list_board_members
// =====================================================================

func (s *Server) toolListBoardMembers() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "list_board_members",
			Description: "Returns the list of members of a board: user_id, username, role (admin / editor / commenter / viewer). Use this when the user asks who is on a board, when picking an assignee for a new card, or to validate a username before passing it to assigned_to in create_card / update_card.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["board_id"],
				"properties": {
					"board_id": {"type": "string", "description": "Board id from list_my_boards()."}
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
			board, err := s.backend.GetBoard(args.BoardID)
			if err != nil || board == nil {
				return toolError("not found: board %s", args.BoardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, args.BoardID, model.PermissionViewBoard) {
				return toolError("permission denied: board %s", args.BoardID), nil
			}
			members := s.boardMembersFor(args.BoardID)
			return toolJSON(map[string]interface{}{
				"board_id": args.BoardID,
				"members":  members,
				"count":    len(members),
			})
		},
	}
}

// =====================================================================
// bulk_update_cards
// =====================================================================

type bulkUpdateChange struct {
	CardID  string                 `json:"card_id"`
	Changes map[string]interface{} `json:"changes"`
}

type bulkUpdateResult struct {
	CardID  string       `json:"card_id"`
	OK      bool         `json:"ok"`
	Error   string       `json:"error,omitempty"`
	Card    *cardSummary `json:"card,omitempty"`
}

func (s *Server) toolBulkUpdateCards() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "bulk_update_cards",
			Description: "Applies the same kind of `changes` map (see update_card) to many cards in one call. Use this for batch operations like moving a list of cards to Done, reassigning everyone's tasks at once, etc. Each item is processed independently — successes return the resolved card, failures return an error string but don't abort the rest.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["updates"],
				"properties": {
					"updates": {
						"type": "array",
						"minItems": 1,
						"maxItems": 200,
						"items": {
							"type": "object",
							"required": ["card_id", "changes"],
							"properties": {
								"card_id": {"type": "string"},
								"changes": {"type": "object", "description": "Same allowed keys as update_card.changes."}
							}
						}
					}
				}
			}`),
		},
		handler: func(ctx context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				Updates []bulkUpdateChange `json:"updates"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if len(args.Updates) == 0 {
				return toolError("updates array is required"), nil
			}
			if len(args.Updates) > 200 {
				return toolError("at most 200 updates per call"), nil
			}
			updateHandler := s.toolUpdateCard().handler
			results := make([]bulkUpdateResult, 0, len(args.Updates))
			for _, u := range args.Updates {
				perCallArgs, _ := json.Marshal(updateCardArgs{CardID: u.CardID, Changes: u.Changes})
				res, _ := updateHandler(ctx, userID, perCallArgs)
				if res.IsError {
					msg := ""
					if len(res.Content) > 0 {
						msg = res.Content[0].Text
					}
					results = append(results, bulkUpdateResult{CardID: u.CardID, OK: false, Error: msg})
					continue
				}
				var summary cardSummary
				if len(res.Content) > 0 {
					_ = json.Unmarshal([]byte(res.Content[0].Text), &summary)
				}
				results = append(results, bulkUpdateResult{CardID: u.CardID, OK: true, Card: &summary})
			}
			ok := 0
			for _, r := range results {
				if r.OK {
					ok++
				}
			}
			return toolJSON(map[string]interface{}{
				"results":  results,
				"ok_count": ok,
				"total":    len(results),
			})
		},
	}
}

// =====================================================================
// delete_card
// =====================================================================

func (s *Server) toolDeleteCard() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "delete_card",
			Description: "Deletes a card. This is a soft delete (DeleteAt is set on the underlying block, the row remains for audit / undo). Requires the same manage-board-cards permission as create / update. Returns {ok: true, card_id} on success.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id"],
				"properties": {
					"card_id": {"type": "string", "description": "Card id from search_cards()."}
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
			existing, err := s.backend.GetCardByID(args.CardID)
			if err != nil || existing == nil {
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, existing.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied: cannot delete cards on board %s", existing.BoardID), nil
			}
			if err := s.backend.DeleteBlockAndNotify(args.CardID, userID, false); err != nil {
				return toolError("delete card: %v", err), nil
			}
			return toolJSON(map[string]interface{}{
				"ok":      true,
				"card_id": args.CardID,
			})
		},
	}
}

// =====================================================================
// reorder_card_content
// =====================================================================

func (s *Server) toolReorderCardContent() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "reorder_card_content",
			Description: "Replaces the card's content_order — the array that decides the rendered order of subtask / checkbox / text blocks in the card body. Pass ordered_ids as a permutation of the card's current child block ids; missing ids would silently disappear from the UI, so the call rejects partial lists. Use get_card_details() first to read the current ids and types. Returns {ok, card_id, content_order}.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "ordered_ids"],
				"properties": {
					"card_id":     {"type": "string", "description": "Card to reorder."},
					"ordered_ids": {"type": "array", "items": {"type": "string"}, "description": "Block ids in the desired order. Must be a permutation of the card's existing child block ids."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CardID     string   `json:"card_id"`
				OrderedIDs []string `json:"ordered_ids"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" {
				return toolError("card_id is required"), nil
			}
			card, err := s.backend.GetCardByID(args.CardID)
			if err != nil || card == nil {
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied: cannot edit cards on board %s", card.BoardID), nil
			}
			// Build the set of currently-attached child block ids (excludes
			// stale ids that may still be in contentOrder from before the
			// delete-cleanup fix). The new order must match this set
			// exactly so a typo doesn't drop a real block from rendering.
			children, err := s.backend.GetBlocks(card.BoardID, card.ID, "")
			if err != nil {
				return toolError("read child blocks: %v", err), nil
			}
			validIDs := make(map[string]bool, len(children))
			for _, b := range children {
				switch string(b.Type) {
				case "subtask", "checkbox", "text", "image", "divider":
					validIDs[b.ID] = true
				}
			}
			seen := make(map[string]bool, len(args.OrderedIDs))
			for _, id := range args.OrderedIDs {
				if !validIDs[id] {
					return toolError("ordered_ids contains %q which is not a child of card %s", id, args.CardID), nil
				}
				if seen[id] {
					return toolError("ordered_ids contains duplicate %q", id), nil
				}
				seen[id] = true
			}
			if len(seen) != len(validIDs) {
				var missing []string
				for id := range validIDs {
					if !seen[id] {
						missing = append(missing, id)
					}
				}
				sort.Strings(missing)
				return toolError("ordered_ids is missing %d existing child block(s): %v — read get_card_details first to enumerate them", len(missing), missing), nil
			}
			newOrder := append([]string{}, args.OrderedIDs...)
			patch := &model.CardPatch{ContentOrder: &newOrder}
			updated, err := s.backend.PatchCard(patch, card.ID, userID, false)
			if err != nil {
				return toolError("reorder: %v", err), nil
			}
			return toolJSON(map[string]interface{}{
				"ok":            true,
				"card_id":       updated.ID,
				"content_order": updated.ContentOrder,
			})
		},
	}
}

// =====================================================================
// add_subtask / update_subtask / delete_subtask
// =====================================================================
//
// Subtasks are stored as content blocks of type "subtask" parented to a card.
// The text lives in block.Title; the done/not-done state lives at
// block.Fields["value"] as a bool — the same shape Boards uses for the
// checkbox content block. (Earlier API revisions tried to map the state
// onto a board-level "subtask-states" select property via fields.optionId,
// but no Focalboard board configures that property out of the box, so the
// path was dead and the value never surfaced in the UI.) Adding a subtask
// requires appending its id to the parent card's contentOrder so the
// webapp renders it in the right position; deletion patches the same array
// to remove the id (otherwise content_order accumulates dead ids over time).

// subtaskFromBlock projects a stored subtask block into the cardSubtask
// shape used both by get_card_details (the read view) and by the create /
// update / delete tool responses, so an agent never has to map between two
// schemas.
func subtaskFromBlock(block *model.Block) cardSubtask {
	out := cardSubtask{
		ID:        block.ID,
		Title:     block.Title,
		CreateAt:  block.CreateAt,
		CreateISO: msToISO(block.CreateAt),
	}
	if v, ok := block.Fields["value"].(bool); ok {
		out.Checked = v
	}
	return out
}

// loadSubtask is the common preamble for the per-subtask edit tools: fetch
// the block, verify it really is a subtask, load the parent card, and
// check edit permission. The board return is omitted because subtask
// updates no longer consult board-level state. Errors surface to the agent
// via the returned toolsCallResult — pass it through.
func (s *Server) loadSubtask(userID, subtaskID string) (*model.Block, *model.Card, *toolsCallResult) {
	block, err := s.backend.GetBlockByID(subtaskID)
	if err != nil || block == nil {
		r := toolError("not found: subtask %s", subtaskID)
		return nil, nil, &r
	}
	if string(block.Type) != "subtask" {
		r := toolError("not a subtask: block %s is %s", subtaskID, block.Type)
		return nil, nil, &r
	}
	card, err := s.backend.GetCardByID(block.ParentID)
	if err != nil || card == nil {
		r := toolError("not found: parent card %s", block.ParentID)
		return nil, nil, &r
	}
	if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionManageBoardCards) {
		r := toolError("permission denied: cannot edit cards on board %s", card.BoardID)
		return nil, nil, &r
	}
	return block, card, nil
}

// removeFromContentOrder patches the parent card's ContentOrder to drop a
// deleted block id. Without this, the card accumulates dangling ids in
// content_order over time (the webapp tolerates them, but agents that
// honour content_order chase ghosts). Best-effort — if the patch fails the
// soft-delete is still applied and the error is logged but not surfaced
// (the user-visible delete already succeeded).
func (s *Server) removeFromContentOrder(card *model.Card, blockID, userID string) {
	if card == nil || blockID == "" {
		return
	}
	newOrder := make([]string, 0, len(card.ContentOrder))
	found := false
	for _, id := range card.ContentOrder {
		if id == blockID {
			found = true
			continue
		}
		newOrder = append(newOrder, id)
	}
	if !found {
		return
	}
	patch := &model.CardPatch{ContentOrder: &newOrder}
	if _, err := s.backend.PatchCard(patch, card.ID, userID, false); err != nil {
		s.logger.Warn("mcp: contentOrder cleanup after block delete failed",
			mlog.String("card_id", card.ID),
			mlog.String("block_id", blockID),
			mlog.Err(err),
		)
	}
}

func (s *Server) toolAddSubtask() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "add_subtask",
			Description: "Appends a subtask to a card. title is required. checked defaults to false. Subtasks render as their own row in the card body with a state toggle — semantically the same as a checkbox, but with a separate UI affordance for hierarchical work. Use add_checkbox for plain inline todos. Returns the created subtask in the same shape get_card_details() emits, plus card_link.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "title"],
				"properties": {
					"card_id": {"type": "string", "description": "Parent card id."},
					"title":   {"type": "string", "description": "Subtask text."},
					"checked": {"type": "boolean", "description": "Initial done state. Default false."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CardID  string `json:"card_id"`
				Title   string `json:"title"`
				Checked bool   `json:"checked"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" || strings.TrimSpace(args.Title) == "" {
				return toolError("card_id and non-empty title are required"), nil
			}
			card, err := s.backend.GetCardByID(args.CardID)
			if err != nil || card == nil {
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied: cannot edit cards on board %s", card.BoardID), nil
			}
			board, err := s.backend.GetBoard(card.BoardID)
			if err != nil || board == nil {
				return toolError("not found: parent board %s", card.BoardID), nil
			}

			block := &model.Block{
				ID:         utils.NewID(utils.IDTypeBlock),
				BoardID:    card.BoardID,
				ParentID:   card.ID,
				Type:       "subtask",
				Title:      strings.TrimSpace(args.Title),
				Fields:     map[string]interface{}{"value": args.Checked},
				CreatedBy:  userID,
				ModifiedBy: userID,
			}
			if err := s.backend.InsertBlockAndNotify(block, userID, false); err != nil {
				return toolError("insert subtask: %v", err), nil
			}

			// Append to the card's contentOrder so the new subtask shows up
			// in the UI. Mirrors what cardDetail.tsx does after insertBlock.
			newOrder := append([]string{}, card.ContentOrder...)
			newOrder = append(newOrder, block.ID)
			patch := &model.CardPatch{ContentOrder: &newOrder}
			if _, err := s.backend.PatchCard(patch, card.ID, userID, false); err != nil {
				s.logger.Warn("mcp: subtask inserted but contentOrder patch failed",
					mlog.String("card_id", card.ID),
					mlog.String("subtask_id", block.ID),
					mlog.Err(err),
				)
			}

			persisted, err := s.backend.GetBlockByID(block.ID)
			if err != nil || persisted == nil {
				persisted = block
			}
			return toolJSON(map[string]interface{}{
				"ok":        true,
				"subtask":   subtaskFromBlock(persisted),
				"card_id":   card.ID,
				"card_link": s.cardLinkFor(board, card.ID),
			})
		},
	}
}

func (s *Server) toolUpdateSubtask() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "update_subtask",
			Description: "Edits a subtask. Pass title to change the text and/or checked to flip the done state. At least one of the two must be provided. Omit a field (don't pass the key) to leave it unchanged — passing checked=false explicitly clears the state, passing checked=true marks it done.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["subtask_id"],
				"properties": {
					"subtask_id": {"type": "string"},
					"title":      {"type": "string", "description": "New subtask text. Omit to leave unchanged."},
					"checked":    {"type": "boolean", "description": "New done state. Omit (do not pass the key) to leave unchanged."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			// Distinguish "checked omitted" from "checked: false" by reading
			// the raw JSON map directly.
			var rawArgs map[string]json.RawMessage
			if err := json.Unmarshal(raw, &rawArgs); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			var subtaskID, title string
			var checked bool
			titleSet, checkedSet := false, false
			if v, ok := rawArgs["subtask_id"]; ok {
				_ = json.Unmarshal(v, &subtaskID)
			}
			if v, ok := rawArgs["title"]; ok {
				_ = json.Unmarshal(v, &title)
				titleSet = true
			}
			if v, ok := rawArgs["checked"]; ok {
				_ = json.Unmarshal(v, &checked)
				checkedSet = true
			}
			if subtaskID == "" {
				return toolError("subtask_id is required"), nil
			}
			if !titleSet && !checkedSet {
				return toolError("at least one of title or checked must be provided"), nil
			}

			block, _, errResult := s.loadSubtask(userID, subtaskID)
			if errResult != nil {
				return *errResult, nil
			}

			patch := &model.BlockPatch{}
			if titleSet {
				trimmed := strings.TrimSpace(title)
				patch.Title = &trimmed
			}
			if checkedSet {
				patch.UpdatedFields = map[string]interface{}{"value": checked}
			}

			updated, err := s.backend.PatchBlockAndNotify(subtaskID, patch, userID, false)
			if err != nil {
				return toolError("update subtask: %v", err), nil
			}
			if updated == nil {
				updated = block
			}
			return toolJSON(map[string]interface{}{
				"ok":      true,
				"subtask": subtaskFromBlock(updated),
			})
		},
	}
}

func (s *Server) toolDeleteSubtask() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "delete_subtask",
			Description: "Deletes a subtask block. Soft delete (DeleteAt is set on the underlying block) and the id is removed from the parent card's content_order so it stops showing up in get_card_details(). Requires manage-board-cards permission on the parent board. Returns {ok, subtask_id}.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["subtask_id"],
				"properties": {
					"subtask_id": {"type": "string"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				SubtaskID string `json:"subtask_id"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.SubtaskID == "" {
				return toolError("subtask_id is required"), nil
			}
			_, card, errResult := s.loadSubtask(userID, args.SubtaskID)
			if errResult != nil {
				return *errResult, nil
			}
			if err := s.backend.DeleteBlockAndNotify(args.SubtaskID, userID, false); err != nil {
				return toolError("delete subtask: %v", err), nil
			}
			s.removeFromContentOrder(card, args.SubtaskID, userID)
			return toolJSON(map[string]interface{}{
				"ok":         true,
				"subtask_id": args.SubtaskID,
			})
		},
	}
}

// =====================================================================
// add_checkbox / update_checkbox / delete_checkbox
// =====================================================================
//
// Checkbox content blocks are simple inline todos in the card body: a text
// title plus a boolean stored at block.Fields["value"]. Distinct from
// checkbox-typed property templates (those are columns on the card and are
// edited via update_card properties). Storage shape mirrors subtasks (block
// of type "checkbox", parented to the card, must be appended to the card's
// contentOrder to surface in the UI).

// checkboxFromBlock projects a stored checkbox block into the cardCheckbox
// shape. Used both when listing existing checkboxes in get_card_details and
// when echoing a freshly-mutated checkbox back from add / update.
func checkboxFromBlock(block *model.Block) cardCheckbox {
	out := cardCheckbox{
		ID:        block.ID,
		Title:     block.Title,
		CreateAt:  block.CreateAt,
		CreateISO: msToISO(block.CreateAt),
	}
	if v, ok := block.Fields["value"].(bool); ok {
		out.Checked = v
	}
	return out
}

// loadCheckbox is the per-call preamble for the per-checkbox edit tools:
// fetch the block, verify type, load the parent card, and check edit
// permission. Board lookup is deferred to the call sites that actually need
// it (currently only add_checkbox to render card_link).
func (s *Server) loadCheckbox(userID, checkboxID string) (*model.Block, *model.Card, *toolsCallResult) {
	block, err := s.backend.GetBlockByID(checkboxID)
	if err != nil || block == nil {
		r := toolError("not found: checkbox %s", checkboxID)
		return nil, nil, &r
	}
	if string(block.Type) != "checkbox" {
		r := toolError("not a checkbox: block %s is %s", checkboxID, block.Type)
		return nil, nil, &r
	}
	card, err := s.backend.GetCardByID(block.ParentID)
	if err != nil || card == nil {
		r := toolError("not found: parent card %s", block.ParentID)
		return nil, nil, &r
	}
	if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionManageBoardCards) {
		r := toolError("permission denied: cannot edit cards on board %s", card.BoardID)
		return nil, nil, &r
	}
	return block, card, nil
}

func (s *Server) toolAddCheckbox() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "add_checkbox",
			Description: "Appends a checkbox (inline todo) to a card. title is required. checked defaults to false. Checkboxes and subtasks have the same done/not-done state model (Fields.value=bool); pick whichever the user already uses elsewhere on their card — checkboxes for plain todo bullets, add_subtask for hierarchical work that benefits from a separate UI affordance. Returns the created checkbox in the same shape get_card_details() emits, plus card_link.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["card_id", "title"],
				"properties": {
					"card_id": {"type": "string", "description": "Parent card id."},
					"title":   {"type": "string", "description": "Checkbox text."},
					"checked": {"type": "boolean", "description": "Initial checked state. Default false."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CardID  string `json:"card_id"`
				Title   string `json:"title"`
				Checked bool   `json:"checked"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CardID == "" || strings.TrimSpace(args.Title) == "" {
				return toolError("card_id and non-empty title are required"), nil
			}
			card, err := s.backend.GetCardByID(args.CardID)
			if err != nil || card == nil {
				return toolError("not found: card %s", args.CardID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, card.BoardID, model.PermissionManageBoardCards) {
				return toolError("permission denied: cannot edit cards on board %s", card.BoardID), nil
			}
			board, err := s.backend.GetBoard(card.BoardID)
			if err != nil || board == nil {
				return toolError("not found: parent board %s", card.BoardID), nil
			}

			block := &model.Block{
				ID:         utils.NewID(utils.IDTypeBlock),
				BoardID:    card.BoardID,
				ParentID:   card.ID,
				Type:       "checkbox",
				Title:      strings.TrimSpace(args.Title),
				Fields:     map[string]interface{}{"value": args.Checked},
				CreatedBy:  userID,
				ModifiedBy: userID,
			}
			if err := s.backend.InsertBlockAndNotify(block, userID, false); err != nil {
				return toolError("insert checkbox: %v", err), nil
			}

			newOrder := append([]string{}, card.ContentOrder...)
			newOrder = append(newOrder, block.ID)
			patch := &model.CardPatch{ContentOrder: &newOrder}
			if _, err := s.backend.PatchCard(patch, card.ID, userID, false); err != nil {
				s.logger.Warn("mcp: checkbox inserted but contentOrder patch failed",
					mlog.String("card_id", card.ID),
					mlog.String("checkbox_id", block.ID),
					mlog.Err(err),
				)
			}

			persisted, err := s.backend.GetBlockByID(block.ID)
			if err != nil || persisted == nil {
				persisted = block
			}
			return toolJSON(map[string]interface{}{
				"ok":        true,
				"checkbox":  checkboxFromBlock(persisted),
				"card_id":   card.ID,
				"card_link": s.cardLinkFor(board, card.ID),
			})
		},
	}
}

func (s *Server) toolUpdateCheckbox() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "update_checkbox",
			Description: "Edits a checkbox. Pass title to change the text and/or checked to flip the state. At least one of the two must be provided. Omit a field (don't pass the key) to leave it unchanged — passing checked=false explicitly clears the box.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["checkbox_id"],
				"properties": {
					"checkbox_id": {"type": "string"},
					"title":       {"type": "string", "description": "New checkbox text. Omit to leave unchanged."},
					"checked":     {"type": "boolean", "description": "New checked state. Omit (do not pass the key) to leave unchanged."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			// Distinguish "checked omitted" from "checked: false" by
			// inspecting the raw JSON map directly.
			var rawArgs map[string]json.RawMessage
			if err := json.Unmarshal(raw, &rawArgs); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			var checkboxID, title string
			var checked bool
			titleSet, checkedSet := false, false
			if v, ok := rawArgs["checkbox_id"]; ok {
				_ = json.Unmarshal(v, &checkboxID)
			}
			if v, ok := rawArgs["title"]; ok {
				_ = json.Unmarshal(v, &title)
				titleSet = true
			}
			if v, ok := rawArgs["checked"]; ok {
				_ = json.Unmarshal(v, &checked)
				checkedSet = true
			}
			if checkboxID == "" {
				return toolError("checkbox_id is required"), nil
			}
			if !titleSet && !checkedSet {
				return toolError("at least one of title or checked must be provided"), nil
			}

			block, _, errResult := s.loadCheckbox(userID, checkboxID)
			if errResult != nil {
				return *errResult, nil
			}

			patch := &model.BlockPatch{}
			if titleSet {
				trimmed := strings.TrimSpace(title)
				patch.Title = &trimmed
			}
			if checkedSet {
				patch.UpdatedFields = map[string]interface{}{"value": checked}
			}

			updated, err := s.backend.PatchBlockAndNotify(checkboxID, patch, userID, false)
			if err != nil {
				return toolError("update checkbox: %v", err), nil
			}
			if updated == nil {
				updated = block
			}
			return toolJSON(map[string]interface{}{
				"ok":       true,
				"checkbox": checkboxFromBlock(updated),
			})
		},
	}
}

func (s *Server) toolDeleteCheckbox() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "delete_checkbox",
			Description: "Deletes a checkbox content block. Soft delete (DeleteAt is set on the underlying block) and the id is removed from the parent card's content_order so it stops showing up in get_card_details(). Requires manage-board-cards permission on the parent board. Returns {ok, checkbox_id}.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["checkbox_id"],
				"properties": {
					"checkbox_id": {"type": "string"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CheckboxID string `json:"checkbox_id"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CheckboxID == "" {
				return toolError("checkbox_id is required"), nil
			}
			_, card, errResult := s.loadCheckbox(userID, args.CheckboxID)
			if errResult != nil {
				return *errResult, nil
			}
			if err := s.backend.DeleteBlockAndNotify(args.CheckboxID, userID, false); err != nil {
				return toolError("delete checkbox: %v", err), nil
			}
			s.removeFromContentOrder(card, args.CheckboxID, userID)
			return toolJSON(map[string]interface{}{
				"ok":          true,
				"checkbox_id": args.CheckboxID,
			})
		},
	}
}

// =====================================================================
// update_comment / delete_comment
// =====================================================================

func (s *Server) toolUpdateComment() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "update_comment",
			Description: "Edits the text of a comment. Only the comment author can edit; admins must use the Mattermost UI. Returns {ok, comment_id, text}.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["comment_id", "text"],
				"properties": {
					"comment_id": {"type": "string"},
					"text":       {"type": "string", "description": "New comment body. Cannot be empty — to remove a comment use delete_comment."}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			// Distinguish "text omitted" from "text: """ so the empty-string
			// case can return a more helpful "use delete_comment" message
			// instead of the generic "non-empty text required".
			var rawArgs map[string]json.RawMessage
			if err := json.Unmarshal(raw, &rawArgs); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			var commentID, text string
			if v, ok := rawArgs["comment_id"]; ok {
				_ = json.Unmarshal(v, &commentID)
			}
			textRaw, textSet := rawArgs["text"]
			if textSet {
				_ = json.Unmarshal(textRaw, &text)
			}
			if commentID == "" {
				return toolError("comment_id is required"), nil
			}
			if !textSet {
				return toolError("text is required"), nil
			}
			if strings.TrimSpace(text) == "" {
				return toolError("text cannot be empty — to remove a comment use delete_comment"), nil
			}
			block, err := s.backend.GetBlockByID(commentID)
			if err != nil || block == nil {
				return toolError("not found: comment %s", commentID), nil
			}
			if string(block.Type) != "comment" {
				return toolError("not a comment: block %s is %s", commentID, block.Type), nil
			}
			if block.CreatedBy != userID {
				return toolError("permission denied: comment %s belongs to a different user", commentID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, block.BoardID, model.PermissionCommentBoardCards) {
				return toolError("permission denied: cannot comment on board %s", block.BoardID), nil
			}
			patch := &model.BlockPatch{Title: &text}
			if _, err := s.backend.PatchBlockAndNotify(commentID, patch, userID, false); err != nil {
				return toolError("update comment: %v", err), nil
			}
			return toolJSON(map[string]interface{}{
				"ok":         true,
				"comment_id": commentID,
				"text":       text,
			})
		},
	}
}

func (s *Server) toolDeleteComment() toolEntry {
	return toolEntry{
		def: toolDef{
			Name: "delete_comment",
			Description: "Deletes a comment. Only the comment author can delete via this tool. Returns {ok, comment_id}.",
			InputSchema: rawSchema(`{
				"type": "object",
				"required": ["comment_id"],
				"properties": {
					"comment_id": {"type": "string"}
				}
			}`),
		},
		handler: func(_ context.Context, userID string, raw json.RawMessage) (toolsCallResult, error) {
			var args struct {
				CommentID string `json:"comment_id"`
			}
			if err := json.Unmarshal(raw, &args); err != nil {
				return toolError("invalid arguments: %v", err), nil
			}
			if args.CommentID == "" {
				return toolError("comment_id is required"), nil
			}
			block, err := s.backend.GetBlockByID(args.CommentID)
			if err != nil || block == nil {
				return toolError("not found: comment %s", args.CommentID), nil
			}
			if string(block.Type) != "comment" {
				return toolError("not a comment: block %s is %s", args.CommentID, block.Type), nil
			}
			if block.CreatedBy != userID {
				return toolError("permission denied: comment %s belongs to a different user", args.CommentID), nil
			}
			if !s.backend.HasPermissionToBoard(userID, block.BoardID, model.PermissionCommentBoardCards) {
				return toolError("permission denied: cannot comment on board %s", block.BoardID), nil
			}
			if err := s.backend.DeleteBlockAndNotify(args.CommentID, userID, false); err != nil {
				return toolError("delete comment: %v", err), nil
			}
			return toolJSON(map[string]interface{}{
				"ok":         true,
				"comment_id": args.CommentID,
			})
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
