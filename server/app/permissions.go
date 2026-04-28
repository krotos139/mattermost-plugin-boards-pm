// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package app

import (
	mm_model "github.com/mattermost/mattermost/server/public/model"
)

func (a *App) HasPermissionToBoard(userID, boardID string, permission *mm_model.Permission) bool {
	return a.permissions.HasPermissionToBoard(userID, boardID, permission)
}

// HasPermissionToTeam mirrors HasPermissionToBoard but checks team-level
// permissions (e.g. PermissionCreatePublicChannel for a new public board on
// the team). Wired so the MCP create_board tool can gate without reaching
// past the App boundary into the permissions service directly.
func (a *App) HasPermissionToTeam(userID, teamID string, permission *mm_model.Permission) bool {
	return a.permissions.HasPermissionToTeam(userID, teamID, permission)
}
