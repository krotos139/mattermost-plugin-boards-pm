// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package plugindelivery

import (
	"fmt"

	"github.com/mattermost/mattermost-plugin-boards/server/services/notify"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"

	mm_model "github.com/mattermost/mattermost/server/public/model"
)

const (
	// TODO: localize when i18n is available.
	personAddedTemplate = "@%s added you to **%s** on the card [%s](%s) in board [%s](%s)"
)

// PersonAddedDeliver sends a DM notifying a user that they were added to a
// person-typed property (with notifications enabled) on a card.
func (pd *PluginDelivery) PersonAddedDeliver(addedUserID string, propertyName string, evt notify.BlockChangeEvent) error {
	if evt.ModifiedBy == nil {
		return fmt.Errorf("missing modifier for person-add notification")
	}
	author, err := pd.api.GetUserByID(evt.ModifiedBy.UserID)
	if err != nil {
		return fmt.Errorf("cannot find author user %s: %w", evt.ModifiedBy.UserID, err)
	}

	channel, err := pd.getDirectChannel(evt.TeamID, addedUserID, pd.botID)
	if err != nil {
		return fmt.Errorf("cannot get direct channel for %s: %w", addedUserID, err)
	}

	cardLink := utils.MakeCardLink(pd.serverRoot, evt.Board.TeamID, evt.Board.ID, evt.Card.ID)
	boardLink := utils.MakeBoardLink(pd.serverRoot, evt.Board.TeamID, evt.Board.ID)

	post := &mm_model.Post{
		UserId:    pd.botID,
		ChannelId: channel.Id,
		Message:   fmt.Sprintf(personAddedTemplate, author.Username, propertyName, evt.Card.Title, cardLink, evt.Board.Title, boardLink),
	}

	if _, err := pd.api.CreatePost(post); err != nil {
		return err
	}
	return nil
}
