// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package mcp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	mm_model "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

// Backend is the subset of *app.App the MCP tools need. Defined as an
// interface so the mcp package doesn't pull the whole app package into its
// import graph and so tools can be tested with mocks.
type Backend interface {
	GetBoardsForUserAndTeam(userID, teamID string, includePublicBoards bool) ([]*model.Board, error)
	GetBoard(boardID string) (*model.Board, error)
	GetCardsForBoard(boardID string, page, perPage int) ([]*model.Card, error)
	GetCardByID(cardID string) (*model.Card, error)
	CreateCard(card *model.Card, boardID, userID string, disableNotify bool) (*model.Card, error)
	PatchCard(patch *model.CardPatch, cardID, userID string, disableNotify bool) (*model.Card, error)
	HasPermissionToBoard(userID, boardID string, permission *mm_model.Permission) bool
	GetMembersForUser(userID string) ([]*model.BoardMember, error)

	// Block-level operations used to read card content (description text,
	// subtasks, etc.) and to write comments. Comments are stored as blocks
	// of type=`comment` whose parentID is the card ID.
	GetBlocks(boardID, parentID, blockType string) ([]*model.Block, error)
	InsertBlockAndNotify(block *model.Block, modifiedByID string, disableNotify bool) error
}

// SessionAPI is the subset of plugin.API we need to validate bearer tokens,
// enumerate the requesting user's teams, and resolve usernames for the
// search_cards / create_card / update_card assigned_to argument.
type SessionAPI interface {
	GetSession(sessionID string) (*mm_model.Session, *mm_model.AppError)
	GetTeamsForUser(userID string) ([]*mm_model.Team, *mm_model.AppError)
	GetUser(userID string) (*mm_model.User, *mm_model.AppError)
	GetUserByUsername(username string) (*mm_model.User, *mm_model.AppError)
}

// Config controls how the MCP server is exposed. Zero value is invalid;
// always construct via the plugin's OnActivate flow.
type Config struct {
	Port          int
	ServerName    string
	ServerVersion string
	// SharedSecret, if non-empty, is required as `Authorization: Bearer <s>`
	// on every request. Combined with the auto-injected X-Mattermost-UserID
	// header from the Mattermost Agents plugin, this lets the MCP server
	// trust the caller's claimed user without doing per-call session lookups.
	// Empty means "loopback-trust mode" — any local caller is accepted.
	SharedSecret string
}

// Server is the loopback-only MCP HTTP server. Lifecycle:
//
//	s := mcp.New(...)
//	s.Start(ctx)         // begins accepting on 127.0.0.1:port
//	... plugin runs ...
//	s.Stop(stopCtx)      // graceful drain
//
// Start/Stop are safe to call multiple times — Stop on a not-running server
// is a no-op, and double-Start returns an error.
type Server struct {
	cfg     Config
	backend Backend
	api     SessionAPI
	logger  mlog.LoggerIFace

	mu       sync.Mutex
	listener net.Listener
	http     *http.Server
	running  bool

	tools           map[string]toolHandler
	orderedToolDefs []toolDef
}

func New(cfg Config, backend Backend, api SessionAPI, logger mlog.LoggerIFace) *Server {
	s := &Server{
		cfg:     cfg,
		backend: backend,
		api:     api,
		logger:  logger,
	}
	s.tools = s.buildTools()
	return s
}

// Start binds the loopback listener and starts serving in a goroutine.
// Returns once the listener is bound (so a subsequent Agents config that
// points at the URL will connect successfully).
func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return errors.New("mcp: server already running")
	}
	if s.cfg.Port <= 0 || s.cfg.Port > 65535 {
		return fmt.Errorf("mcp: invalid port %d", s.cfg.Port)
	}

	addr := "127.0.0.1:" + strconv.Itoa(s.cfg.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("mcp: listen on %s: %w", addr, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", s.handleMCP)
	mux.HandleFunc("/health", s.handleHealth)

	s.listener = ln
	s.http = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	s.running = true

	go func() {
		if err := s.http.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.logger.Error("mcp: http serve stopped with error", mlog.Err(err))
		}
	}()

	s.logger.Info("mcp: server listening", mlog.String("addr", addr))
	return nil
}

func (s *Server) Stop(ctx context.Context) error {
	s.mu.Lock()
	hs := s.http
	if !s.running {
		s.mu.Unlock()
		return nil
	}
	s.running = false
	s.mu.Unlock()

	if hs == nil {
		return nil
	}
	if err := hs.Shutdown(ctx); err != nil {
		return fmt.Errorf("mcp: shutdown: %w", err)
	}
	s.logger.Info("mcp: server stopped")
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// handleMCP serves the loopback HTTP listener path. It enforces a defence-
// in-depth loopback check on r.RemoteAddr before delegating to the shared
// request body. Use ServeHTTP for the plugin-transport entry point, which
// skips the loopback check because Mattermost's PluginHTTP delivers the
// request in-process (RemoteAddr is meaningless there).
func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r.RemoteAddr) {
		s.logger.Warn("mcp: rejecting non-loopback connection", mlog.String("remote", r.RemoteAddr))
		http.Error(w, "loopback only", http.StatusForbidden)
		return
	}
	s.serveMCP(w, r)
}

// ServeHTTP exposes the MCP JSON-RPC endpoint for invocation through the
// plugin's own ServeHTTP, i.e. via Mattermost's inter-plugin HTTP API
// (plugin://focalboard/mcp). It performs the same authentication and
// dispatch as the loopback listener but does not check RemoteAddr — a
// PluginHTTP-delivered request is already trusted to originate inside the
// Mattermost server process.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.serveMCP(w, r)
}

func (s *Server) serveMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userID, err := s.authenticate(r)
	if err != nil {
		// Respond with HTTP 401 so the MCP client can react. The body is
		// human-readable; structured JSON-RPC errors are reserved for cases
		// where we successfully reached the dispatcher.
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "request too large or unreadable", http.StatusBadRequest)
		return
	}

	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPCError(w, nil, errCodeParseError, "parse error: "+err.Error())
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPCError(w, req.ID, errCodeInvalidRequest, "jsonrpc must be '2.0'")
		return
	}

	resp, omit := s.dispatch(r.Context(), userID, &req)
	if omit {
		// Notification — JSON-RPC 2.0 forbids a response body for these.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, resp)
}

// authenticate validates the request and returns the acting user's ID.
//
// The Mattermost Agents plugin auto-injects `X-Mattermost-UserID: <id>` on
// every MCP call (its config-time Headers field is static and admin-shared,
// with no per-user templating). So we identify the caller from that header
// and, if a shared secret is configured, gate the endpoint with a constant-
// equality check on `Authorization: Bearer <secret>`.
//
// As a fallback for direct testing (curl, etc.) without X-Mattermost-UserID,
// we still accept a real Mattermost session token in Authorization: Bearer.
func (s *Server) authenticate(r *http.Request) (string, error) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	userIDHeader := strings.TrimSpace(r.Header.Get("X-Mattermost-UserID"))

	const bearer = "Bearer "
	var bearerValue string
	if strings.HasPrefix(authHeader, bearer) {
		bearerValue = strings.TrimSpace(authHeader[len(bearer):])
	}

	// Path A: Agents-plugin style. X-Mattermost-UserID identifies the user;
	// the Bearer value (if any) is matched against the configured shared
	// secret. Use subtle.ConstantTimeCompare to avoid leaking length/timing.
	if userIDHeader != "" {
		if s.cfg.SharedSecret != "" {
			if bearerValue == "" {
				return "", errors.New("missing Authorization: Bearer <shared-secret>")
			}
			a := []byte(bearerValue)
			b := []byte(s.cfg.SharedSecret)
			if len(a) != len(b) || subtle.ConstantTimeCompare(a, b) != 1 {
				return "", errors.New("invalid shared secret")
			}
		}
		return userIDHeader, nil
	}

	// Path B: direct caller (no X-Mattermost-UserID). Treat Bearer as a real
	// session token. Useful for ad-hoc curl testing and back-compat.
	if bearerValue == "" {
		return "", errors.New("missing X-Mattermost-UserID or Authorization: Bearer <session-token>")
	}
	session, appErr := s.api.GetSession(bearerValue)
	if appErr != nil {
		return "", fmt.Errorf("invalid session: %s", appErr.Message)
	}
	if session == nil || session.UserId == "" {
		return "", errors.New("session has no user")
	}
	return session.UserId, nil
}

// dispatch routes a parsed JSON-RPC request to the matching handler. Returns
// (response, true) for notifications so the caller suppresses the body.
func (s *Server) dispatch(ctx context.Context, userID string, req *rpcRequest) (rpcResponse, bool) {
	if req.isNotification() {
		// We don't act on any client→server notifications today; just ack.
		return rpcResponse{}, true
	}

	switch req.Method {
	case "initialize":
		return s.handleInitialize(req), false
	case "ping":
		return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: struct{}{}}, false
	case "tools/list":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  toolsListResult{Tools: s.toolDefs()},
		}, false
	case "tools/call":
		return s.handleToolCall(ctx, userID, req), false
	default:
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: errCodeMethodNotFound, Message: "method not found: " + req.Method},
		}, false
	}
}

func (s *Server) handleInitialize(req *rpcRequest) rpcResponse {
	var p initializeParams
	if len(req.Params) > 0 {
		_ = json.Unmarshal(req.Params, &p)
	}
	version := p.ProtocolVersion
	if version == "" {
		version = ProtocolVersion
	}
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: initializeResult{
			ProtocolVersion: version,
			Capabilities:    serverCapabilities{Tools: &toolsCapability{}},
			ServerInfo:      serverInfo{Name: s.cfg.ServerName, Version: s.cfg.ServerVersion},
		},
	}
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	if err := enc.Encode(v); err != nil {
		// Headers already sent — best-effort log.
		_ = err
	}
}

func writeRPCError(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	writeJSON(w, rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: msg},
	})
}

func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
