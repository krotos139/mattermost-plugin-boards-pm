// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package notifyperson

import (
	"github.com/mattermost/mattermost-plugin-boards/server/services/notify"
)

// PersonAddedDelivery delivers a notification to a user that was added to a person-typed property.
type PersonAddedDelivery interface {
	PersonAddedDeliver(addedUserID string, propertyName string, evt notify.BlockChangeEvent) error
}
