// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package model

// HistoryEventKind enumerates the discrete activity-log events derived from
// a card's blocks_history rows. The values are stable strings consumed by
// the frontend renderer.
type HistoryEventKind string

const (
	HistoryEventCardCreated     HistoryEventKind = "card-created"
	HistoryEventTitleChanged    HistoryEventKind = "title"
	HistoryEventIconChanged     HistoryEventKind = "icon"
	HistoryEventPropertyChanged HistoryEventKind = "property"
	HistoryEventDescAdded       HistoryEventKind = "desc-added"
	HistoryEventDescEdited      HistoryEventKind = "desc-edited"
	HistoryEventDescRemoved     HistoryEventKind = "desc-removed"
	HistoryEventCommentAdded    HistoryEventKind = "comment-added"
	HistoryEventCommentEdited   HistoryEventKind = "comment-edited"
	HistoryEventCommentRemoved  HistoryEventKind = "comment-removed"
)

// CardHistoryEvent is one entry on the per-card activity timeline. Sent
// chronologically (oldest first) so the client can render Jira-style.
//
// swagger:model
type CardHistoryEvent struct {
	// Unix-millis when the event occurred (the underlying block version's
	// update_at).
	// required: true
	Timestamp int64 `json:"timestamp"`

	// User who caused the change.
	// required: true
	UserID string `json:"userId"`

	// Discriminator for what changed; see HistoryEvent* constants.
	// required: true
	Kind HistoryEventKind `json:"kind"`

	// Property events: id of the changed card property; "" otherwise.
	PropertyID string `json:"propertyId,omitempty"`

	// Property events: human-readable name resolved from the current board's
	// cardProperties at request time. Falls back to "(removed property)"
	// if the property has been deleted.
	PropertyName string `json:"propertyName,omitempty"`

	// Property events: type of the property (e.g. "select", "multiPerson") so
	// the frontend can render values with the right widget.
	PropertyType string `json:"propertyType,omitempty"`

	// Description / comment events: id of the affected sub-block.
	BlockID string `json:"blockId,omitempty"`

	// Description events: type of the underlying content block ("text",
	// "checkbox", "image", "divider", "attachment") so the frontend can pick
	// between rendering a quote of the body vs a generic "added an image".
	BlockType string `json:"blockType,omitempty"`

	// Old serialized value (stringified for primitives, JSON for arrays).
	// "" when the event has no prior value.
	Before string `json:"before,omitempty"`

	// New serialized value. "" for removal events.
	After string `json:"after,omitempty"`
}
