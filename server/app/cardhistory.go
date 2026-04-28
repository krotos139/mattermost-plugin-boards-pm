// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Per-card activity log. Events are derived on the fly from the blocks_history
// table: every persisted version of the card itself or of any block whose
// parent_id is the card (content blocks, comments, attachments) is compared
// against the version immediately preceding it; differences become events.
//
// We do NOT have a separate audit table — the `update_at` and `modified_by`
// columns on blocks_history are sufficient for "who, when, what changed".

package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
)

// ErrBoardNotFoundForHistory is returned by GetCardHistory when the lookup
// for the parent board returns no rows. Distinct from a store-level error.
var ErrBoardNotFoundForHistory = errors.New("board not found")

// historyEventCap caps the number of events returned to the frontend.
// 100 keeps the payload small enough to render without virtualization;
// the user can request more later if we need to lift the cap.
const historyEventCap = 100

// systemActionUserID is the placeholder modified_by used by sync/import
// pathways. We skip those events — they represent machine activity, not a
// real user action.
const systemActionUserID = ""

// GetCardHistory returns up to historyEventCap chronologically-ordered events
// for the given card. The card must already be authorized for the caller; the
// API layer is responsible for the permission check.
func (a *App) GetCardHistory(boardID, cardID string) ([]*model.CardHistoryEvent, error) {
	board, err := a.store.GetBoard(boardID)
	if err != nil {
		return nil, fmt.Errorf("get board for history: %w", err)
	}
	if board == nil {
		return nil, fmt.Errorf("%w: %s", ErrBoardNotFoundForHistory, boardID)
	}

	// Pull the entire subtree history in insert_at ASC order so we can walk
	// each block's version stream in chronological order.
	rows, err := a.store.GetCardSubtreeHistory(cardID, model.QueryBlockHistoryOptions{Descending: false})
	if err != nil {
		return nil, fmt.Errorf("get card history: %w", err)
	}

	// Group versions by block id, preserving order.
	versionsByID := make(map[string][]*model.Block)
	for _, blk := range rows {
		versionsByID[blk.ID] = append(versionsByID[blk.ID], blk)
	}

	propLookup := buildPropertyLookup(board.CardProperties)
	// Resolve the subtask-states option lookup once. Subtask blocks store
	// their state in Fields.optionId, where optionId references one of the
	// options on the property pointed to by board.Properties.subtaskStatesPropertyId.
	// We pre-build "option id -> label" so diffSubBlockVersion can render
	// "before -> after" with human-readable values like "todo" / "done"
	// instead of the raw option ids that nothing else in the UI exposes.
	subtaskStateLabels := resolveSubtaskStateLabels(board.Properties, propLookup)

	events := make([]*model.CardHistoryEvent, 0)
	for blockID, versions := range versionsByID {
		if len(versions) == 0 {
			continue
		}
		isCard := blockID == cardID
		events = append(events, diffBlockVersions(versions, isCard, propLookup, subtaskStateLabels)...)
	}

	// Chronological order (oldest first). Stable secondary sort by blockID
	// avoids flapping when two events share a millisecond.
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].Timestamp != events[j].Timestamp {
			return events[i].Timestamp < events[j].Timestamp
		}
		return events[i].BlockID < events[j].BlockID
	})

	// Cap to the most recent N. Slice from the end so the user sees the
	// freshest activity; preserve ascending order within the slice.
	if len(events) > historyEventCap {
		events = events[len(events)-historyEventCap:]
	}
	return events, nil
}

// propertyInfo is the resolved name+type for a property id, looked up from
// the board's current cardProperties at request time.
type propertyInfo struct {
	name    string
	ptype   string
	options map[string]string // option id -> label, for select/multiSelect
}

func buildPropertyLookup(cardProperties []map[string]interface{}) map[string]propertyInfo {
	out := make(map[string]propertyInfo)
	for _, p := range cardProperties {
		id, _ := p["id"].(string)
		if id == "" {
			continue
		}
		name, _ := p["name"].(string)
		ptype, _ := p["type"].(string)
		info := propertyInfo{name: name, ptype: ptype}
		if rawOpts, ok := p["options"].([]interface{}); ok {
			info.options = make(map[string]string, len(rawOpts))
			for _, o := range rawOpts {
				m, _ := o.(map[string]interface{})
				if m == nil {
					continue
				}
				oid, _ := m["id"].(string)
				oval, _ := m["value"].(string)
				if oid != "" {
					info.options[oid] = oval
				}
			}
		}
		out[id] = info
	}
	return out
}

// resolveSubtaskStateLabels returns option-id -> label for the property a
// board's subtaskStatesPropertyId points at. Returns nil when the board has
// no subtask states configured (the Subtasks block then renders a "configure
// in board settings" placeholder, and there is no state for history to log).
func resolveSubtaskStateLabels(boardProperties map[string]interface{}, props map[string]propertyInfo) map[string]string {
	if boardProperties == nil {
		return nil
	}
	propID, _ := boardProperties["subtaskStatesPropertyId"].(string)
	if propID == "" {
		return nil
	}
	info, ok := props[propID]
	if !ok || info.options == nil {
		return nil
	}
	return info.options
}

// diffBlockVersions walks one block's version stream and emits events for
// each consecutive (vN-1, vN) pair, plus an initial creation event for the
// card root.
func diffBlockVersions(versions []*model.Block, isCard bool, props map[string]propertyInfo, subtaskStateLabels map[string]string) []*model.CardHistoryEvent {
	out := make([]*model.CardHistoryEvent, 0)
	if len(versions) == 0 {
		return out
	}
	first := versions[0]

	// Card creation is its own event so the timeline starts somewhere.
	if isCard && first.ModifiedBy != systemActionUserID {
		out = append(out, &model.CardHistoryEvent{
			Timestamp: first.CreateAt,
			UserID:    first.ModifiedBy,
			Kind:      model.HistoryEventCardCreated,
			Before:    "",
			After:     first.Title,
		})
	}

	for i := 1; i < len(versions); i++ {
		prev, curr := versions[i-1], versions[i]
		if curr.ModifiedBy == systemActionUserID {
			continue
		}
		if isCard {
			out = append(out, diffCardVersion(prev, curr, props)...)
		} else {
			out = append(out, diffSubBlockVersion(prev, curr, subtaskStateLabels)...)
		}
	}

	// First version of a sub-block (creation) — only meaningful for content
	// blocks and comments. For card itself we already emitted "card-created"
	// above, so we skip the card here.
	if !isCard && first.ModifiedBy != systemActionUserID {
		creation := subBlockCreationEvent(first)
		if creation != nil {
			out = append(out, creation)
		}
	}

	// Removal: if the latest version is delete-marked, emit a removal.
	last := versions[len(versions)-1]
	if !isCard && last.DeleteAt > 0 && last.ModifiedBy != systemActionUserID {
		// Body of the deleted block: the delete row often blanks the title,
		// so fall back to the most recent non-empty title from the version
		// stream — this lets the UI show "deleted comment '<body>'".
		body := last.Title
		if body == "" {
			for i := len(versions) - 2; i >= 0; i-- {
				if versions[i].Title != "" {
					body = versions[i].Title
					break
				}
			}
		}
		out = append(out, &model.CardHistoryEvent{
			Timestamp: last.DeleteAt,
			UserID:    last.ModifiedBy,
			Kind:      removalKindFor(last.Type),
			BlockID:   last.ID,
			BlockType: string(last.Type),
			Before:    body,
		})
	}
	return out
}

func subBlockCreationEvent(b *model.Block) *model.CardHistoryEvent {
	kind := creationKindFor(b.Type)
	if kind == "" {
		return nil
	}
	return &model.CardHistoryEvent{
		Timestamp: b.CreateAt,
		UserID:    b.ModifiedBy,
		Kind:      kind,
		BlockID:   b.ID,
		BlockType: string(b.Type),
		After:     b.Title,
	}
}

func creationKindFor(t model.BlockType) model.HistoryEventKind {
	switch t {
	case model.TypeComment:
		return model.HistoryEventCommentAdded
	case model.TypeText, model.TypeCheckbox, model.TypeSubtask, model.TypeImage, model.TypeVideo, model.TypeDivider, model.TypeAttachment:
		return model.HistoryEventDescAdded
	}
	return ""
}

func removalKindFor(t model.BlockType) model.HistoryEventKind {
	switch t {
	case model.TypeComment:
		return model.HistoryEventCommentRemoved
	case model.TypeText, model.TypeCheckbox, model.TypeSubtask, model.TypeImage, model.TypeVideo, model.TypeDivider, model.TypeAttachment:
		return model.HistoryEventDescRemoved
	}
	return model.HistoryEventDescRemoved
}

func diffCardVersion(prev, curr *model.Block, props map[string]propertyInfo) []*model.CardHistoryEvent {
	out := make([]*model.CardHistoryEvent, 0)

	if prev.Title != curr.Title {
		out = append(out, &model.CardHistoryEvent{
			Timestamp: curr.UpdateAt,
			UserID:    curr.ModifiedBy,
			Kind:      model.HistoryEventTitleChanged,
			Before:    prev.Title,
			After:     curr.Title,
		})
	}

	prevIcon := getIcon(prev)
	currIcon := getIcon(curr)
	if prevIcon != currIcon {
		out = append(out, &model.CardHistoryEvent{
			Timestamp: curr.UpdateAt,
			UserID:    curr.ModifiedBy,
			Kind:      model.HistoryEventIconChanged,
			Before:    prevIcon,
			After:     currIcon,
		})
	}

	prevProps := getCardProps(prev)
	currProps := getCardProps(curr)

	// Union of keys to catch additions, removals and changes.
	keys := make(map[string]struct{})
	for k := range prevProps {
		keys[k] = struct{}{}
	}
	for k := range currProps {
		keys[k] = struct{}{}
	}
	for propID := range keys {
		bv := serializePropValue(prevProps[propID])
		av := serializePropValue(currProps[propID])
		if bv == av {
			continue
		}
		info, ok := props[propID]
		name := info.name
		if !ok || name == "" {
			name = "(removed property)"
		}
		out = append(out, &model.CardHistoryEvent{
			Timestamp:    curr.UpdateAt,
			UserID:       curr.ModifiedBy,
			Kind:         model.HistoryEventPropertyChanged,
			PropertyID:   propID,
			PropertyName: name,
			PropertyType: info.ptype,
			Before:       bv,
			After:        av,
		})
	}

	return out
}

func diffSubBlockVersion(prev, curr *model.Block, subtaskStateLabels map[string]string) []*model.CardHistoryEvent {
	out := make([]*model.CardHistoryEvent, 0)

	// A delete is encoded as a row with delete_at>0; the removal event is
	// emitted separately by the caller using the final version. Skip here
	// to avoid double-counting.
	if curr.DeleteAt > 0 && prev.DeleteAt == 0 {
		return out
	}

	if prev.Title != curr.Title {
		if kind := editKindFor(curr.Type); kind != "" {
			out = append(out, &model.CardHistoryEvent{
				Timestamp: curr.UpdateAt,
				UserID:    curr.ModifiedBy,
				Kind:      kind,
				BlockID:   curr.ID,
				BlockType: string(curr.Type),
				Before:    prev.Title,
				After:     curr.Title,
			})
		}
	}

	// Subtask state cycle (todo / in-progress / done) lives in
	// Fields.optionId, NOT in the title. The title-only diff above misses
	// it entirely, which means picking a state in the UI used to leave no
	// trace in history. Emit a separate edit event whenever the option
	// changes; render labels via the board's subtaskStates property so
	// the activity log shows "before: todo, after: done" instead of
	// opaque option ids.
	if curr.Type == model.TypeSubtask {
		prevOpt := stringField(prev, "optionId")
		currOpt := stringField(curr, "optionId")
		if prevOpt != currOpt {
			out = append(out, &model.CardHistoryEvent{
				Timestamp: curr.UpdateAt,
				UserID:    curr.ModifiedBy,
				Kind:      model.HistoryEventSubtaskStateChanged,
				BlockID:   curr.ID,
				BlockType: string(curr.Type),
				Before:    subtaskStateLabel(prevOpt, subtaskStateLabels),
				After:     subtaskStateLabel(currOpt, subtaskStateLabels),
			})
		}
	}

	return out
}

func stringField(b *model.Block, key string) string {
	if b == nil || b.Fields == nil {
		return ""
	}
	s, _ := b.Fields[key].(string)
	return s
}

// subtaskStateLabel resolves an option id to a human-readable label using
// the lookup pre-built from board.cardProperties[subtaskStatesPropertyId].
// Returns "" for the unset state ("none picked yet"), and the raw id with
// a "(removed)" suffix when an admin has dropped the option from the
// property since the event was written.
func subtaskStateLabel(optionID string, labels map[string]string) string {
	if optionID == "" {
		return ""
	}
	if label, ok := labels[optionID]; ok {
		return label
	}
	return optionID + " (removed)"
}

func editKindFor(t model.BlockType) model.HistoryEventKind {
	switch t {
	case model.TypeComment:
		return model.HistoryEventCommentEdited
	case model.TypeText, model.TypeCheckbox, model.TypeSubtask:
		return model.HistoryEventDescEdited
	}
	return ""
}

func getIcon(b *model.Block) string {
	if b == nil || b.Fields == nil {
		return ""
	}
	s, _ := b.Fields["icon"].(string)
	return s
}

func getCardProps(b *model.Block) map[string]interface{} {
	if b == nil || b.Fields == nil {
		return nil
	}
	p, _ := b.Fields["properties"].(map[string]interface{})
	return p
}

// serializePropValue normalizes a property value into a stable string so
// we can detect changes regardless of whether the underlying JSON
// represents a multi-person value as []string or []interface{}.
// Native Focalboard values are usually plain strings, but multi-* types
// store arrays.
func serializePropValue(v interface{}) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case []interface{}, []string:
		b, err := json.Marshal(x)
		if err != nil {
			return ""
		}
		return string(b)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return fmt.Sprintf("%v", x)
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return ""
		}
		return string(b)
	}
}
