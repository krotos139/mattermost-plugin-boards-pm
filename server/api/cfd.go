// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost-plugin-boards/server/app"
	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/services/audit"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"
)

func (a *API) registerCFDRoutes(r *mux.Router) {
	r.HandleFunc("/boards/{boardID}/cfd", a.sessionRequired(a.handleGetCFD)).Methods("GET")
}

func (a *API) handleGetCFD(w http.ResponseWriter, r *http.Request) {
	// swagger:operation GET /boards/{boardID}/cfd getCFD
	//
	// Returns the Cumulative Flow Diagram time series for a board grouped
	// by a select / multiSelect / person / multiPerson / personNotify /
	// multiPersonNotify property. The "from" and "to" query params are
	// epoch milliseconds; when omitted, defaults to the last 30 days.
	//
	// ---
	// produces:
	// - application/json
	// parameters:
	// - name: boardID
	//   in: path
	//   required: true
	//   type: string
	// - name: propertyId
	//   in: query
	//   required: true
	//   type: string
	// - name: from
	//   in: query
	//   required: false
	//   type: integer
	// - name: to
	//   in: query
	//   required: false
	//   type: integer
	// security:
	// - BearerAuth: []
	// responses:
	//   '200':
	//     description: success
	//     schema:
	//       "$ref": "#/definitions/CFDResult"
	//   default:
	//     description: internal error
	//     schema:
	//       "$ref": "#/definitions/ErrorResponse"

	userID := getUserID(r)
	boardID := mux.Vars(r)["boardID"]
	propertyID := r.URL.Query().Get("propertyId")
	if propertyID == "" {
		a.errorResponse(w, r, model.NewErrBadRequest("propertyId query parameter is required"))
		return
	}

	from, err := parseOptionalInt64(r.URL.Query().Get("from"))
	if err != nil {
		a.errorResponse(w, r, model.NewErrBadRequest(fmt.Sprintf("invalid 'from': %s", err.Error())))
		return
	}
	to, err := parseOptionalInt64(r.URL.Query().Get("to"))
	if err != nil {
		a.errorResponse(w, r, model.NewErrBadRequest(fmt.Sprintf("invalid 'to': %s", err.Error())))
		return
	}

	if !a.permissions.HasPermissionToBoard(userID, boardID, model.PermissionViewBoard) {
		a.errorResponse(w, r, model.NewErrPermission("access denied to board CFD"))
		return
	}

	auditRec := a.makeAuditRecord(r, "getCFD", audit.Fail)
	defer a.audit.LogRecord(audit.LevelRead, auditRec)
	auditRec.AddMeta("boardID", boardID)
	auditRec.AddMeta("propertyID", propertyID)

	result, err := a.app.GetCFD(boardID, propertyID, from, to, utils.GetMillis())
	if err != nil {
		switch {
		case errors.Is(err, app.ErrBoardNotFoundForCFD):
			a.errorResponse(w, r, model.NewErrNotFound("board not found"))
		case errors.Is(err, app.ErrCFDPropertyNotFound):
			a.errorResponse(w, r, model.NewErrBadRequest(err.Error()))
		default:
			a.errorResponse(w, r, err)
		}
		return
	}

	data, err := json.Marshal(result)
	if err != nil {
		a.errorResponse(w, r, err)
		return
	}

	jsonBytesResponse(w, http.StatusOK, data)
	auditRec.Success()
}

// parseOptionalInt64 returns 0 when the input is empty so the App layer
// can apply its own defaults; only a malformed (non-empty, non-numeric)
// value bubbles up as a 400.
func parseOptionalInt64(s string) (int64, error) {
	if s == "" {
		return 0, nil
	}
	return strconv.ParseInt(s, 10, 64)
}
