// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package mcp

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

// AdminKeyRow is the serialized form of a key for the admin keys table. The
// hash is used as the row identifier (revoke target); plaintext is never
// stored so it cannot be displayed.
type AdminKeyRow struct {
	Hash        string `json:"hash"`
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	Description string `json:"description"`
	CreatedAt   int64  `json:"created_at"`
}

// HandleAdminKeys serves admin-only requests against the issued-keys table.
// Routes (relative to /api/v2/mcp/admin/keys):
//
//	GET  ""                  → list all
//	POST "/<hash>/revoke"    → revoke one by hash
//
// Mattermost injects `Mattermost-User-Id` on every plugin HTTP request,
// sourced from the caller's authenticated session, so we trust it here and
// gate by IsSystemAdmin().
//
// This is a free function (not a method on Server) so it can be served even
// when the MCP listener is disabled — admins still need to audit/revoke
// historical keys after turning MCP off.
func HandleAdminKeys(w http.ResponseWriter, r *http.Request, subPath string, api SessionAPI, keys *KeyStore, logger mlog.LoggerIFace) {
	userID := strings.TrimSpace(r.Header.Get("Mattermost-User-Id"))
	if userID == "" {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	user, appErr := api.GetUser(userID)
	if appErr != nil || user == nil {
		writeJSONError(w, http.StatusInternalServerError, "user lookup failed")
		return
	}
	if !user.IsSystemAdmin() {
		writeJSONError(w, http.StatusForbidden, "forbidden")
		return
	}
	if keys == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "key store unavailable")
		return
	}

	subPath = strings.TrimPrefix(subPath, "/")
	if subPath == "" {
		adminKeysList(w, api, keys, logger)
		return
	}
	parts := strings.Split(subPath, "/")
	if len(parts) == 2 && parts[1] == "revoke" {
		adminKeysRevoke(w, r, parts[0], keys, logger)
		return
	}
	writeJSONError(w, http.StatusNotFound, "not found")
}

func adminKeysList(w http.ResponseWriter, api SessionAPI, keys *KeyStore, logger mlog.LoggerIFace) {
	all, err := keys.ListAllKeys()
	if err != nil {
		logger.Warn("mcp admin: list keys failed", mlog.Err(err))
		writeJSONError(w, http.StatusInternalServerError, "list failed")
		return
	}
	rows := make([]AdminKeyRow, 0, len(all))
	usernameCache := make(map[string]string)
	for _, k := range all {
		uname, ok := usernameCache[k.UserID]
		if !ok {
			if u, appErr := api.GetUser(k.UserID); appErr == nil && u != nil {
				uname = u.Username
			} else {
				uname = "(deleted)"
			}
			usernameCache[k.UserID] = uname
		}
		rows = append(rows, AdminKeyRow{
			Hash:        k.Hash,
			UserID:      k.UserID,
			Username:    uname,
			Description: k.Description,
			CreatedAt:   k.CreatedAt,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].CreatedAt > rows[j].CreatedAt
	})
	writeJSON(w, rows)
}

func adminKeysRevoke(w http.ResponseWriter, r *http.Request, hash string, keys *KeyStore, logger mlog.LoggerIFace) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := keys.RevokeByHash(hash); err != nil {
		if errors.Is(err, ErrKeyNotFound) {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		logger.Warn("mcp admin: revoke failed", mlog.String("hash", hash), mlog.Err(err))
		writeJSONError(w, http.StatusInternalServerError, "revoke failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}

// writeJSONError emits a JSON-shaped error so the webapp keys table can
// always parse the response, never tripping JSON.parse on an HTML 404.
func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
