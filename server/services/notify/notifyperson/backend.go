// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package notifyperson

import (
	"fmt"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/services/notify"
	"github.com/wiggin77/merror"

	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

const (
	backendName = "notifyPerson"

	// Property type identifiers for the new "with notification" person fields.
	personNotifyType      = "personNotify"
	multiPersonNotifyType = "multiPersonNotify"
)

type BackendParams struct {
	Delivery PersonAddedDelivery
	Logger   mlog.LoggerIFace
}

// Backend sends a DM to a user when they are added to a card property of type
// "personNotify" or "multiPersonNotify".
type Backend struct {
	delivery PersonAddedDelivery
	logger   mlog.LoggerIFace
}

func New(params BackendParams) *Backend {
	return &Backend{
		delivery: params.Delivery,
		logger:   params.Logger,
	}
}

func (b *Backend) Start() error {
	return nil
}

func (b *Backend) ShutDown() error {
	_ = b.logger.Flush()
	return nil
}

func (b *Backend) Name() string {
	return backendName
}

func (b *Backend) BlockChanged(evt notify.BlockChangeEvent) error {
	if evt.Board == nil || evt.Card == nil {
		return nil
	}
	if evt.Action == notify.Delete {
		return nil
	}
	if evt.BlockChanged == nil || evt.BlockChanged.Type != model.TypeCard {
		return nil
	}

	notifyProps := collectNotifyProperties(evt.Board.CardProperties)
	if len(notifyProps) == 0 {
		return nil
	}

	newProps := extractCardProperties(evt.BlockChanged)
	oldProps := extractCardProperties(evt.BlockOld)

	merr := merror.New()
	for propID, propName := range notifyProps {
		added := diffPersonValue(oldProps[propID], newProps[propID])
		if len(added) == 0 {
			continue
		}

		modifiedByID := ""
		if evt.ModifiedBy != nil {
			modifiedByID = evt.ModifiedBy.UserID
		}

		for _, userID := range added {
			// Don't notify the user who made the change (e.g. self-assignment).
			if userID == "" || userID == modifiedByID {
				continue
			}
			if err := b.delivery.PersonAddedDeliver(userID, propName, evt); err != nil {
				merr.Append(fmt.Errorf("cannot deliver person-add notification to %s: %w", userID, err))
				continue
			}
			b.logger.Debug("person-add notification delivered",
				mlog.String("user_id", userID),
				mlog.String("property_id", propID),
				mlog.String("card_id", evt.Card.ID),
			)
		}
	}
	return merr.ErrorOrNil()
}

// collectNotifyProperties returns a map of property id → property name for every
// property in the board whose type is one of the notify-enabled person types.
func collectNotifyProperties(cardProperties []map[string]interface{}) map[string]string {
	result := map[string]string{}
	for _, prop := range cardProperties {
		propType, _ := prop["type"].(string)
		if propType != personNotifyType && propType != multiPersonNotifyType {
			continue
		}
		propID, _ := prop["id"].(string)
		if propID == "" {
			continue
		}
		propName, _ := prop["name"].(string)
		if propName == "" {
			propName = propID
		}
		result[propID] = propName
	}
	return result
}

// extractCardProperties pulls the "properties" map out of a card block's Fields.
// Returns an empty map if the block is nil or has no properties.
func extractCardProperties(block *model.Block) map[string]interface{} {
	if block == nil || block.Fields == nil {
		return map[string]interface{}{}
	}
	props, ok := block.Fields["properties"].(map[string]interface{})
	if !ok {
		return map[string]interface{}{}
	}
	return props
}

// diffPersonValue returns the set of user IDs that are present in newVal but
// not in oldVal. Each value can be either a string (single person) or an array
// of strings (multi person). Returns nil for unrecognized types.
func diffPersonValue(oldVal, newVal interface{}) []string {
	newSet := personValueToSet(newVal)
	oldSet := personValueToSet(oldVal)

	added := make([]string, 0, len(newSet))
	for id := range newSet {
		if _, exists := oldSet[id]; !exists {
			added = append(added, id)
		}
	}
	return added
}

func personValueToSet(v interface{}) map[string]struct{} {
	out := map[string]struct{}{}
	switch val := v.(type) {
	case string:
		if val != "" {
			out[val] = struct{}{}
		}
	case []interface{}:
		for _, item := range val {
			if s, ok := item.(string); ok && s != "" {
				out[s] = struct{}{}
			}
		}
	case []string:
		for _, s := range val {
			if s != "" {
				out[s] = struct{}{}
			}
		}
	}
	return out
}
