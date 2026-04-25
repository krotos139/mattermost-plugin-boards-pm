// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package api

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/services/audit"
)

func (a *API) registerDashboardRoutes(r *mux.Router) {
	// Returns the user's per-team dashboard board of the given kind, creating
	// it lazily on first access. The user always operates on their own
	// dashboard — the userID is taken from the session, not from the URL.
	r.HandleFunc("/teams/{teamID}/dashboards/{kind}", a.sessionRequired(a.handleGetDashboardBoard)).Methods("GET")
}

func (a *API) handleGetDashboardBoard(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	teamID := vars["teamID"]
	kind := vars["kind"]
	userID := getUserID(r)

	if userID == "" {
		a.errorResponse(w, r, model.NewErrUnauthorized("access denied"))
		return
	}

	if !a.permissions.HasPermissionToTeam(userID, teamID, model.PermissionViewTeam) {
		a.errorResponse(w, r, model.NewErrPermission("access denied to team"))
		return
	}

	board, err := a.app.GetOrCreateDashboardBoard(userID, teamID, kind)
	if err != nil {
		a.errorResponse(w, r, err)
		return
	}

	auditRec := a.makeAuditRecord(r, "getDashboardBoard", audit.Fail)
	defer a.audit.LogRecord(audit.LevelRead, auditRec)
	auditRec.AddMeta("boardID", board.ID)
	auditRec.AddMeta("kind", kind)

	data, err := json.Marshal(board)
	if err != nil {
		a.errorResponse(w, r, err)
		return
	}
	jsonBytesResponse(w, http.StatusOK, data)
	auditRec.Success()
}
