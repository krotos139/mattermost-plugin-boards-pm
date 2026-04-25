// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package plugindelivery

import (
	"fmt"
	"time"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"

	mm_model "github.com/mattermost/mattermost/server/public/model"
)

const (
	// TODO: localize when i18n is available.
	deadlineApproachingTemplate = ":alarm_clock: Deadline reminder for **%s**: card [%s](%s) in board [%s](%s) is due %s."
)

// DeadlineApproachingDeliver sends a DM notifying the user that a card's
// deadline is approaching. propertyName is the human-readable label of the
// deadline property (e.g. "Due date"). deadlineAt is unix-millis UTC.
func (pd *PluginDelivery) DeadlineApproachingDeliver(userID string, propertyName string, board *model.Board, card *model.Block, deadlineAt int64) error {
	channel, err := pd.getDirectChannel(board.TeamID, userID, pd.botID)
	if err != nil {
		return fmt.Errorf("cannot get direct channel for %s: %w", userID, err)
	}

	cardLink := utils.MakeCardLink(pd.serverRoot, board.TeamID, board.ID, card.ID)
	boardLink := utils.MakeBoardLink(pd.serverRoot, board.TeamID, board.ID)
	dueAt := time.UnixMilli(deadlineAt).UTC().Format("2006-01-02 15:04 UTC")

	post := &mm_model.Post{
		UserId:    pd.botID,
		ChannelId: channel.Id,
		Message:   fmt.Sprintf(deadlineApproachingTemplate, propertyName, card.Title, cardLink, board.Title, boardLink, dueAt),
	}

	if _, err := pd.api.CreatePost(post); err != nil {
		return err
	}
	return nil
}
