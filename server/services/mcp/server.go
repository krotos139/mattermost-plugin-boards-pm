// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package mcp

import (
	"context"
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
	CreateBoard(board *model.Board, userID string, addMember bool) (*model.Board, error)
	GetCardsForBoard(boardID string, page, perPage int) ([]*model.Card, error)
	GetCardByID(cardID string) (*model.Card, error)
	CreateCard(card *model.Card, boardID, userID string, disableNotify bool) (*model.Card, error)
	PatchCard(patch *model.CardPatch, cardID, userID string, disableNotify bool) (*model.Card, error)
	HasPermissionToBoard(userID, boardID string, permission *mm_model.Permission) bool
	HasPermissionToTeam(userID, teamID string, permission *mm_model.Permission) bool
	GetMembersForUser(userID string) ([]*model.BoardMember, error)
	GetMembersForBoard(boardID string) ([]*model.BoardMember, error)

	// Block-level operations used to read card content (description text,
	// subtasks, etc.) and to write comments. Comments are stored as blocks
	// of type=`comment` whose parentID is the card ID.
	GetBlocks(boardID, parentID, blockType string) ([]*model.Block, error)
	GetBlockByID(blockID string) (*model.Block, error)
	InsertBlockAndNotify(block *model.Block, modifiedByID string, disableNotify bool) error
	PatchBlockAndNotify(blockID string, blockPatch *model.BlockPatch, modifiedByID string, disableNotify bool) (*model.Block, error)
	DeleteBlockAndNotify(blockID string, modifiedBy string, disableNotify bool) error

	// File-level operations for attachment MCP tools. SaveFile uploads bytes
	// (the MCP layer wraps base64-decoded data in an io.Reader). GetFileInfo
	// returns metadata (mime, size, name) without reading the body.
	// ReadFileBytes streams the body fully into memory — callers must
	// pre-check size via GetFileInfo to avoid loading huge files.
	SaveFile(reader io.Reader, teamID, boardID, filename string, asTemplate bool) (string, error)
	GetFileInfo(filename string) (*mm_model.FileInfo, error)
	ReadFileBytes(teamID, boardID, filename string) ([]byte, *mm_model.FileInfo, error)
}

// SessionAPI is the subset of plugin.API we need to validate bearer tokens,
// enumerate teams, resolve usernames, and check sysadmin permissions.
type SessionAPI interface {
	GetSession(sessionID string) (*mm_model.Session, *mm_model.AppError)
	GetTeamsForUser(userID string) ([]*mm_model.Team, *mm_model.AppError)
	GetUser(userID string) (*mm_model.User, *mm_model.AppError)
	GetUserByUsername(username string) (*mm_model.User, *mm_model.AppError)
}

// Config controls how the MCP server is exposed. Zero value is invalid;
// always construct via the plugin's OnActivate flow.
type Config struct {
	// BindAddress is the IP the TCP listener binds to. Empty defaults to
	// 127.0.0.1 (loopback only). Set to 0.0.0.0 to accept off-host
	// connections — in that mode every TCP request must carry a per-user
	// API key in `Authorization: Bearer ...`.
	BindAddress string
	Port        int

	ServerName    string
	ServerVersion string

	// RequireBearerOnLoopback hardens the loopback transport: when true,
	// even local TCP callers must present a Bearer key. Default false (the
	// Mattermost Agents plugin can hit 127.0.0.1 with X-Mattermost-UserID
	// alone, since anything that can reach 127.0.0.1 already has shell
	// access to the host).
	RequireBearerOnLoopback bool

	// SiteURLFn returns the current Mattermost SiteURL (without trailing
	// slash). Wired by the plugin from MM ServiceSettings.SiteURL so the MCP
	// tools can emit absolute card_links the agent can hand straight to the
	// user. Called per request — admin SiteURL changes take effect without a
	// plugin restart. Returning empty produces relative links as before.
	SiteURLFn func() string
}

// Server is the MCP HTTP server. Lifecycle:
//
//	s := mcp.New(...)
//	s.Start()            // begins accepting on cfg.BindAddress:cfg.Port
//	... plugin runs ...
//	s.Stop(stopCtx)      // graceful drain
//
// Start/Stop are safe to call multiple times — Stop on a not-running server
// is a no-op, and double-Start returns an error.
type Server struct {
	cfg     Config
	backend Backend
	api     SessionAPI
	keys    *KeyStore
	logger  mlog.LoggerIFace

	mu       sync.Mutex
	listener net.Listener
	http     *http.Server
	running  bool

	tools           map[string]toolHandler
	orderedToolDefs []toolDef
}

func New(cfg Config, backend Backend, api SessionAPI, keys *KeyStore, logger mlog.LoggerIFace) *Server {
	s := &Server{
		cfg:     cfg,
		backend: backend,
		api:     api,
		keys:    keys,
		logger:  logger,
	}
	s.tools = s.buildTools()
	return s
}

// Keys exposes the underlying key store so the plugin can wire CLI / admin
// endpoints around the same instance.
func (s *Server) Keys() *KeyStore {
	return s.keys
}

// siteURL returns the configured Mattermost SiteURL without a trailing slash,
// or "" when SiteURLFn is unset / returns empty. cardLinkFor uses this to
// prepend an absolute base to deep links.
func (s *Server) siteURL() string {
	if s.cfg.SiteURLFn == nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(s.cfg.SiteURLFn()), "/")
}

// Start binds the TCP listener and starts serving in a goroutine. Returns
// once the listener is bound (so a subsequent client config that points at
// the URL will connect successfully).
func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return errServerAlreadyRunning
	}
	if s.cfg.Port <= 0 || s.cfg.Port > 65535 {
		return fmt.Errorf("%w: %d", errInvalidPort, s.cfg.Port)
	}

	bind := strings.TrimSpace(s.cfg.BindAddress)
	if bind == "" {
		bind = "127.0.0.1"
	}
	addr := net.JoinHostPort(bind, strconv.Itoa(s.cfg.Port))
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

	s.logger.Info("mcp: server listening",
		mlog.String("addr", addr),
		mlog.Bool("require_bearer_on_loopback", s.cfg.RequireBearerOnLoopback),
	)
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

// mcpTransport identifies how a request reached the MCP server. The auth
// rules differ for each because Mattermost's reverse proxy and inter-plugin
// API mutate request headers in different ways — see authenticate.
type mcpTransport int

const (
	// transportTCP — direct connection to the standalone MCP listener
	// (cfg.BindAddress:Port). Headers are exactly what the client sent.
	transportTCP mcpTransport = iota
	// transportInterPlugin — request arrived through Mattermost's
	// inter-plugin HTTP API (plugin://focalboard/mcp). Mattermost sets
	// `Mattermost-Plugin-ID` and never strips it. The source plugin
	// (e.g. mattermost-plugin-agents) is in-process so its
	// `X-Mattermost-UserID` header is trustworthy.
	transportInterPlugin
	// transportExternalHTTP — request arrived through Mattermost's
	// reverse proxy at /plugins/focalboard/mcp from the public network.
	// MM strips Authorization, Mattermost-User-Id, and Mattermost-Plugin-ID
	// before forwarding, then re-sets Mattermost-User-Id only for sessions
	// it has authenticated. Crucially MM does NOT strip the X-prefixed
	// X-Mattermost-UserID, which means an external attacker could forge it
	// — so we must never trust that header on this transport.
	transportExternalHTTP
)

// handleMCP is the entry point for the TCP listener. The auth path checks
// remote-loopback-ness internally to decide whether X-Mattermost-UserID is
// trusted.
func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	s.serveMCP(w, r, transportTCP)
}

// ServeInterPlugin handles requests delivered via Mattermost's inter-plugin
// HTTP API (plugin://focalboard/mcp). These are in-process and untouchable
// by external network actors, so X-Mattermost-UserID is trusted without
// further authentication (the Mattermost Agents plugin auto-injects it on
// every call).
//
// Plugin.ServeHTTP MUST gate this method on `Mattermost-Plugin-ID` being
// set — that header is the only signal that distinguishes inter-plugin from
// external HTTP at this layer, and Mattermost guarantees it is unspoofable
// (set by the server on inter-plugin, deleted on external).
func (s *Server) ServeInterPlugin(w http.ResponseWriter, r *http.Request) {
	s.serveMCP(w, r, transportInterPlugin)
}

// ServeExternalHTTP handles requests that arrived via Mattermost's reverse
// proxy at /plugins/focalboard/mcp. Despite the in-process delivery the
// caller is on the public network, so we never trust X-Mattermost-UserID
// (which MM does not strip) — only Mattermost-User-Id, which MM sets for
// the duration of authenticated cookie/session-token requests.
func (s *Server) ServeExternalHTTP(w http.ResponseWriter, r *http.Request) {
	s.serveMCP(w, r, transportExternalHTTP)
}

func (s *Server) serveMCP(w http.ResponseWriter, r *http.Request, transport mcpTransport) {
	switch r.Method {
	case http.MethodPost:
		s.serveMCPPost(w, r, transport)
	case http.MethodGet:
		s.serveMCPGet(w, r, transport)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) serveMCPPost(w http.ResponseWriter, r *http.Request, transport mcpTransport) {
	userID, err := s.authenticate(r, transport)
	if err != nil {
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

// serveMCPGet implements the "Listening for Messages from the Server" leg of
// the MCP Streamable HTTP transport (spec 2025-03-26). The spec lets a server
// answer GET with either an SSE stream or 405; we pick SSE because the
// mattermost-plugin-agents 2.0.0-rc7 client treats 405 as a fatal session
// error and stops issuing tools/list & tools/call afterwards.
//
// We have no server-initiated messages to push today (no sampling, no
// resumable streams, no async tool results), so the stream is just a
// long-lived channel of `: keepalive` SSE comments. That's enough to keep
// the SDK's session alive — when real server→client traffic appears later
// we can hang it off the same loop.
//
// Other Accepts continue to receive 405 per spec, in case some future
// client probes the endpoint with a non-stream Accept and wants to know
// the server doesn't speak that variant.
func (s *Server) serveMCPGet(w http.ResponseWriter, r *http.Request, transport mcpTransport) {
	if !acceptsEventStream(r) {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if _, err := s.authenticate(r, transport); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		// Inter-plugin transports route through Mattermost's plugin RPC
		// which buffers the response — we can't stream there. Fall back to
		// 405 so the client treats this as "no SSE here" rather than a hang.
		http.Error(w, "streaming not supported on this transport", http.StatusMethodNotAllowed)
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// nginx buffers text/event-stream by default; this header tells it to
	// flush each chunk immediately. Harmless when no proxy is in front.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
		return
	}
	flusher.Flush()

	// 25s sits inside the 15-30s window the spec recommends and is well
	// under the 60s default idle timeout most reverse proxies impose.
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func acceptsEventStream(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	if accept == "" {
		return false
	}
	for _, part := range strings.Split(accept, ",") {
		media := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if strings.EqualFold(media, "text/event-stream") || media == "*/*" {
			return true
		}
	}
	return false
}

// authenticate validates the request and returns the acting user's ID.
// Decision matrix:
//
//	 transport         | bearer | X-MM-UserID | MM-User-Id | result
//	-------------------+--------+-------------+------------+--------------------------
//	 inter-plugin      |   any  |    set      |     —      | trust X-MM-UserID
//	 inter-plugin      |   any  |   empty     |     —      | accept bearer if valid api key, else 401
//	 external HTTP     |   —    |     —       |    set     | trust MM-User-Id (set by MM after session check)
//	 external HTTP     |   —    |     —       |   empty    | 401 (X-MM-UserID is NEVER trusted here — MM doesn't strip it)
//	 TCP loopback      | apikey |     —       |     —      | run as key owner
//	 TCP loopback      | empty  |    set      |     —      | trust X-MM-UserID (unless RequireBearerOnLoopback)
//	 TCP non-loopback  | apikey |     —       |     —      | run as key owner
//	 TCP non-loopback  | empty  |     —       |     —      | 401 (header is never trusted off loopback)
//
// External HTTP cannot use Bearer because Mattermost's reverse proxy strips
// the Authorization header before forwarding to plugins. External MCP
// clients without a Mattermost cookie session must use the direct TCP
// listener instead.
//
// As a developer convenience for ad-hoc curl testing on the TCP path, a
// Bearer that doesn't match any api key is also tried as a real Mattermost
// session token.
func (s *Server) authenticate(r *http.Request, transport mcpTransport) (string, error) {
	bearer := extractBearer(r)
	userIDHeader := strings.TrimSpace(r.Header.Get("X-Mattermost-UserID"))

	switch transport {
	case transportInterPlugin:
		if userIDHeader != "" {
			return userIDHeader, nil
		}
		if uid, ok := s.resolveBearer(bearer); ok {
			return uid, nil
		}
		return "", errMissingPluginIdentity

	case transportExternalHTTP:
		// Mattermost-User-Id is set by the Mattermost server only after a
		// successful session check (cookie or query access_token). It is
		// stripped from every external request before that check, so its
		// presence here is authoritative.
		if mmUserID := strings.TrimSpace(r.Header.Get("Mattermost-User-Id")); mmUserID != "" {
			return mmUserID, nil
		}
		return "", errExternalUnauthenticated

	case transportTCP:
		// bearer wins over any header.
		if bearer != "" {
			if uid, ok := s.resolveBearer(bearer); ok {
				return uid, nil
			}
			return "", errInvalidAPIKey
		}
		if !isLoopback(r.RemoteAddr) {
			return "", errMissingBearerRemote
		}
		if s.cfg.RequireBearerOnLoopback {
			return "", errMissingBearerLoopback
		}
		if userIDHeader != "" {
			return userIDHeader, nil
		}
		return "", errMissingIdentity
	}
	return "", errMissingIdentity
}

// resolveBearer tries the value first as an issued MCP api key, then as a
// real Mattermost session token (curl-testing convenience). Returns
// (userID, true) on success.
func (s *Server) resolveBearer(bearer string) (string, bool) {
	if bearer == "" {
		return "", false
	}
	if s.keys != nil {
		if uid, err := s.keys.LookupUserIDByPlaintext(bearer); err == nil {
			return uid, true
		}
	}
	session, appErr := s.api.GetSession(bearer)
	if appErr == nil && session != nil && session.UserId != "" {
		return session.UserId, true
	}
	return "", false
}

func extractBearer(r *http.Request) string {
	const bearerPrefix = "Bearer "
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(auth, bearerPrefix) {
		return ""
	}
	return strings.TrimSpace(auth[len(bearerPrefix):])
}

// Sentinel auth errors. Distinct so the slash-command and curl test suite
// can match them, and so logs aren't littered with stringly-typed errors.
var (
	errMissingPluginIdentity   = errors.New("plugin transport request missing X-Mattermost-UserID and bearer")
	errMissingBearerRemote     = errors.New("missing Authorization: Bearer <api-key>")
	errMissingBearerLoopback   = errors.New("missing Authorization: Bearer <api-key> (loopback bearer required)")
	errMissingIdentity         = errors.New("missing X-Mattermost-UserID or Authorization: Bearer <api-key>")
	errExternalUnauthenticated = errors.New("unauthenticated: external HTTP MCP requests need a Mattermost session cookie (use the direct TCP listener with Bearer api-key for non-cookie clients)")
	errServerAlreadyRunning    = errors.New("mcp: server already running")
	errInvalidPort             = errors.New("mcp: invalid port")
	errInvalidAPIKey           = errors.New("invalid api key (or expired session token)")
)

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
