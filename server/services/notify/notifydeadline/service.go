// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Package notifydeadline runs a periodic ticker that scans for cards whose
// `deadline`-typed property is approaching and sends a DM to every user
// referenced by personNotify/multiPersonNotify properties on the same card.
//
// Unlike the notify.Backend implementations, this service is not driven by
// BlockChangeEvents — it is a self-paced background loop owned by the plugin
// lifecycle (Start/Stop in BoardsApp).
package notifydeadline

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/mattermost/mattermost-plugin-boards/server/model"

	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

const (
	// TickInterval is how often the ticker fires. Resolution is intentionally
	// coarse — the user-facing offset is in minutes/hours/days, ±10 minutes is fine.
	TickInterval = 10 * time.Minute

	// Default offset (in minutes) when a deadline property has no notifyOffsetMinutes
	// configured. Mirrors the frontend default in widgets/propertyMenu.tsx.
	defaultNotifyOffsetMinutes = 1440 // 24h

	// Property type identifiers shared with the frontend.
	deadlinePropType          = "deadline"
	personNotifyPropType      = "personNotify"
	multiPersonNotifyPropType = "multiPersonNotify"

	// Block field key holding the per-card properties map.
	propertiesField = "properties"
)

// Store is the subset of the main Store interface this service needs.
type Store interface {
	GetBoardsForCompliance(opts model.QueryBoardsForComplianceOptions) ([]*model.Board, bool, error)
	GetBlocksForBoard(boardID string) ([]*model.Block, error)
	IsDeadlineNotificationSent(cardID string, propertyID string, deadlineAt int64) (bool, error)
	MarkDeadlineNotificationSent(cardID string, propertyID string, deadlineAt int64) error
}

// Delivery is the channel that actually sends the DM. Implemented by
// plugindelivery.PluginDelivery.
type Delivery interface {
	DeadlineApproachingDeliver(userID string, propertyName string, board *model.Board, card *model.Block, deadlineAt int64) error
}

type Params struct {
	Store    Store
	Delivery Delivery
	Logger   mlog.LoggerIFace
}

type Service struct {
	store    Store
	delivery Delivery
	logger   mlog.LoggerIFace
}

func New(params Params) *Service {
	return &Service{
		store:    params.Store,
		delivery: params.Delivery,
		logger:   params.Logger,
	}
}

// Run blocks until ctx is cancelled, ticking every TickInterval. One immediate
// tick is fired on entry so freshly-installed plugins catch up without waiting.
func (s *Service) Run(ctx context.Context) {
	s.logger.Info("Deadline notification ticker started", mlog.Duration("interval", TickInterval))

	// Immediate first tick.
	s.runOnce(ctx)

	t := time.NewTicker(TickInterval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			s.logger.Info("Deadline notification ticker stopped")
			return
		case <-t.C:
			s.runOnce(ctx)
		}
	}
}

// runOnce executes a single scan over all boards. Errors are logged per-board
// so one bad board doesn't poison the whole tick.
func (s *Service) runOnce(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			s.logger.Error("Panic in deadline ticker", mlog.Any("recover", r))
		}
	}()

	boards, _, err := s.store.GetBoardsForCompliance(model.QueryBoardsForComplianceOptions{})
	if err != nil {
		s.logger.Error("Cannot list boards for deadline check", mlog.Err(err))
		return
	}

	now := time.Now().UnixMilli()
	for _, board := range boards {
		if ctx.Err() != nil {
			return
		}
		if err := s.processBoard(board, now); err != nil {
			s.logger.Warn("Deadline check failed for board",
				mlog.String("board_id", board.ID),
				mlog.Err(err),
			)
		}
	}
}

// boardPropertyIndex caches which cardProperties of a board are deadline-typed
// or person-notify-typed, so we don't recompute per card.
type boardPropertyIndex struct {
	deadlines  []deadlineProp // (id, name, offsetMin)
	notifyIDs  []string       // person/multi-person notify property IDs
}

type deadlineProp struct {
	id        string
	name      string
	offsetMin int64
}

func indexBoardProperties(board *model.Board) boardPropertyIndex {
	idx := boardPropertyIndex{}
	for _, prop := range board.CardProperties {
		propType, _ := prop["type"].(string)
		propID, _ := prop["id"].(string)
		if propID == "" {
			continue
		}
		switch propType {
		case deadlinePropType:
			name, _ := prop["name"].(string)
			if name == "" {
				name = propID
			}
			offset := defaultNotifyOffsetMinutes
			if raw, ok := prop["notifyOffsetMinutes"]; ok {
				switch v := raw.(type) {
				case float64:
					offset = int(v)
				case int:
					offset = v
				case int64:
					offset = int(v)
				}
			}
			idx.deadlines = append(idx.deadlines, deadlineProp{
				id:        propID,
				name:      name,
				offsetMin: int64(offset),
			})
		case personNotifyPropType, multiPersonNotifyPropType:
			idx.notifyIDs = append(idx.notifyIDs, propID)
		}
	}
	return idx
}

func (s *Service) processBoard(board *model.Board, nowMillis int64) error {
	idx := indexBoardProperties(board)
	if len(idx.deadlines) == 0 || len(idx.notifyIDs) == 0 {
		// No deadline property, or nobody to notify on this board.
		return nil
	}

	blocks, err := s.store.GetBlocksForBoard(board.ID)
	if err != nil {
		return fmt.Errorf("cannot list blocks: %w", err)
	}

	for _, block := range blocks {
		if block.Type != model.TypeCard {
			continue
		}
		props := extractCardProperties(block)
		if len(props) == 0 {
			continue
		}

		recipients := collectRecipients(props, idx.notifyIDs)
		if len(recipients) == 0 {
			// No one would receive a DM — skip without recording, so that
			// adding an assignee later still triggers a notification.
			continue
		}

		for _, dl := range idx.deadlines {
			deadlineAt, ok := parseDeadlineMillis(props[dl.id])
			if !ok {
				continue
			}
			notifyAt := deadlineAt - dl.offsetMin*60*1000
			if notifyAt > nowMillis {
				// Not yet time to notify.
				continue
			}

			sent, err := s.store.IsDeadlineNotificationSent(block.ID, dl.id, deadlineAt)
			if err != nil {
				s.logger.Warn("Cannot check deadline notification state",
					mlog.String("card_id", block.ID),
					mlog.String("property_id", dl.id),
					mlog.Err(err),
				)
				continue
			}
			if sent {
				continue
			}

			s.deliverDeadline(board, block, dl, recipients, deadlineAt)

			if err := s.store.MarkDeadlineNotificationSent(block.ID, dl.id, deadlineAt); err != nil {
				s.logger.Warn("Cannot mark deadline notification as sent",
					mlog.String("card_id", block.ID),
					mlog.String("property_id", dl.id),
					mlog.Err(err),
				)
			}
		}
	}
	return nil
}

func (s *Service) deliverDeadline(board *model.Board, card *model.Block, dl deadlineProp, recipients []string, deadlineAt int64) {
	for _, userID := range recipients {
		if err := s.delivery.DeadlineApproachingDeliver(userID, dl.name, board, card, deadlineAt); err != nil {
			s.logger.Warn("Failed to deliver deadline DM",
				mlog.String("user_id", userID),
				mlog.String("card_id", card.ID),
				mlog.Err(err),
			)
			continue
		}
		s.logger.Debug("Deadline DM delivered",
			mlog.String("user_id", userID),
			mlog.String("card_id", card.ID),
			mlog.String("property_id", dl.id),
		)
	}
}

func extractCardProperties(block *model.Block) map[string]interface{} {
	if block == nil || block.Fields == nil {
		return nil
	}
	props, _ := block.Fields[propertiesField].(map[string]interface{})
	return props
}

// collectRecipients gathers a deduplicated list of user IDs from every
// person-notify / multi-person-notify property on the card.
func collectRecipients(cardProps map[string]interface{}, notifyPropIDs []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0)
	for _, propID := range notifyPropIDs {
		switch v := cardProps[propID].(type) {
		case string:
			if v != "" {
				if _, dup := seen[v]; !dup {
					seen[v] = struct{}{}
					out = append(out, v)
				}
			}
		case []interface{}:
			for _, item := range v {
				if s, ok := item.(string); ok && s != "" {
					if _, dup := seen[s]; !dup {
						seen[s] = struct{}{}
						out = append(out, s)
					}
				}
			}
		case []string:
			for _, s := range v {
				if s != "" {
					if _, dup := seen[s]; !dup {
						seen[s] = struct{}{}
						out = append(out, s)
					}
				}
			}
		}
	}
	return out
}

// parseDeadlineMillis decodes the on-card representation of a date/deadline
// property value into the unix-millis timestamp the notification offset is
// measured from. The frontend stores either a plain millis-string
// ("1700000000000") or a JSON object `{from, to?}`. For a range the deadline
// is the END date (`to`) — that's the moment the work is due, so the offset
// counts back from there. Falls back to `from` for single-date values.
// Returns ok=false for empty/invalid values.
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
		To   int64 `json:"to"`
	}
	if err := json.Unmarshal([]byte(s), &obj); err == nil {
		if obj.To > 0 {
			return obj.To, true
		}
		if obj.From > 0 {
			return obj.From, true
		}
	}
	return 0, false
}
