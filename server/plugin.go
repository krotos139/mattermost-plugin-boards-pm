// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mattermost/mattermost-plugin-boards/server/boards"
	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/services/handoff"
	"github.com/mattermost/mattermost-plugin-boards/server/services/mcp"

	pluginapi "github.com/mattermost/mattermost/server/public/pluginapi"

	mm_model "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

const (
	mcpEnabledSetting           = "enablemcpserver"
	mcpListenAddrSetting        = "mcplistenaddress"
	mcpRequireBearerLoopbackKey = "mcprequirebearreronloopback"
	mcpDefaultListenAddr        = "127.0.0.1:8975"
)

var ErrPluginNotAllowed = errors.New("boards plugin not allowed while Boards product enabled")

// Plugin implements the interface expected by the Mattermost server to communicate between the server and plugin processes.
type Plugin struct {
	plugin.MattermostPlugin
	boardsApp   *boards.BoardsApp
	handoff     *handoff.Service
	mcpServer   *mcp.Server
	mcpKeys     *mcp.KeyStore
	mcpLogger   mlog.LoggerIFace
	appliedMCP  mcpAppliedConfig
}

// mcpAppliedConfig is the snapshot of MCP-related plugin settings that the
// running listener was started with. reconcileMCP compares this against the
// admin's current desired config to decide whether a restart is required.
type mcpAppliedConfig struct {
	enabled               bool
	host                  string
	port                  int
	requireBearerLoopback bool
}

func (p *Plugin) OnActivate() error {
	client := pluginapi.NewClient(p.MattermostPlugin.API, p.MattermostPlugin.Driver)

	logger, _ := mlog.NewLogger()
	pluginTargetFactory := newPluginTargetFactory(&client.Log)
	factories := &mlog.Factories{
		TargetFactory: pluginTargetFactory.createTarget,
	}
	cfgJSON := defaultLoggingConfig()
	err := logger.Configure("", cfgJSON, factories)
	if err != nil {
		return err
	}

	adapter := newServiceAPIAdapter(p.MattermostPlugin.API, client.Store, logger)

	boardsApp, err := boards.NewBoardsApp(adapter, manifest)
	if err != nil {
		return fmt.Errorf("cannot activate plugin: %w", err)
	}

	model.LogServerInfo(logger)

	p.boardsApp = boardsApp
	p.handoff = handoff.New(p.MattermostPlugin.API, logger)
	p.mcpLogger = logger
	p.mcpKeys = mcp.NewKeyStore(p.MattermostPlugin.API, logger)
	if err := p.MattermostPlugin.API.RegisterCommand(boardsCommand()); err != nil {
		logger.Warn("could not register /boards slash command", mlog.Err(err))
	}
	if err := p.boardsApp.Start(); err != nil {
		return err
	}

	p.reconcileMCP()
	return nil
}

// desiredMCPConfig reads the admin-facing plugin settings into the snapshot
// shape used by reconcileMCP. Returns the zero value when MCP is disabled
// or the server config is unavailable; reconcileMCP relies on `enabled` to
// drive teardown.
func (p *Plugin) desiredMCPConfig() mcpAppliedConfig {
	out := mcpAppliedConfig{}
	cfg := p.MattermostPlugin.API.GetConfig()
	if cfg == nil {
		return out
	}
	settings := cfg.PluginSettings.Plugins[boards.PluginName]
	out.enabled, _ = settings[mcpEnabledSetting].(bool)
	if !out.enabled {
		return out
	}

	listenAddr := mcpDefaultListenAddr
	if v, ok := settings[mcpListenAddrSetting].(string); ok {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			listenAddr = trimmed
		}
	}
	host, port, err := splitListenAddr(listenAddr)
	if err != nil {
		p.mcpLogger.Warn("mcp: invalid listen address; using default",
			mlog.String("input", listenAddr), mlog.Err(err))
		host, port, _ = splitListenAddr(mcpDefaultListenAddr)
	}
	out.host = host
	out.port = port
	out.requireBearerLoopback, _ = settings[mcpRequireBearerLoopbackKey].(bool)
	return out
}

// reconcileMCP brings the MCP listener into agreement with current plugin
// settings. Idempotent: a no-op when desired matches the running snapshot.
// Called from OnActivate (initial start) and OnConfigurationChange (admin
// edits MCPListenAddress / EnableMCPServer / MCPRequireBearerOnLoopback in
// the System Console — without this hook the user has to disable+enable the
// plugin for changes to take effect).
//
// Failures are logged and swallowed — MCP is optional and should not block
// the rest of the plugin from operating.
func (p *Plugin) reconcileMCP() {
	desired := p.desiredMCPConfig()

	// Already in the desired state.
	if p.mcpServer != nil && desired == p.appliedMCP {
		return
	}

	// Tear down whatever's running before applying the new config. Stop is
	// safe on a not-running server (handleMCP still serves until Stop, then
	// returns ErrServerClosed which the goroutine swallows).
	if p.mcpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := p.mcpServer.Stop(ctx); err != nil {
			p.mcpLogger.Warn("mcp: stop returned error during reconcile", mlog.Err(err))
		}
		cancel()
		p.mcpServer = nil
		p.appliedMCP = mcpAppliedConfig{}
	}

	if !desired.enabled {
		return
	}

	pluginAPI := p.MattermostPlugin.API
	server := mcp.New(
		mcp.Config{
			BindAddress:             desired.host,
			Port:                    desired.port,
			ServerName:              "mattermost-boards",
			ServerVersion:           manifest.Version,
			RequireBearerOnLoopback: desired.requireBearerLoopback,
			SiteURLFn: func() string {
				cfg := pluginAPI.GetConfig()
				if cfg == nil || cfg.ServiceSettings.SiteURL == nil {
					return ""
				}
				return *cfg.ServiceSettings.SiteURL
			},
		},
		p.boardsApp.App(),
		pluginAPI,
		p.mcpKeys,
		p.mcpLogger,
	)
	// Retain the server reference unconditionally so Plugin.ServeHTTP can
	// dispatch /mcp requests delivered via the inter-plugin HTTP API.
	p.mcpServer = server
	p.appliedMCP = desired

	if desired.port > 0 {
		if err := server.Start(); err != nil {
			p.mcpLogger.Warn("mcp: TCP listener failed to start; plugin transport remains available", mlog.Err(err))
		}
	} else {
		p.mcpLogger.Info("mcp: TCP listener disabled (port=0); accessible only via plugin transport plugin://focalboard/mcp")
	}
}

// splitListenAddr parses a "host:port" string. host can be "0.0.0.0" or
// "127.0.0.1" or a hostname; port must be a positive integer.
func splitListenAddr(s string) (string, int, error) {
	host, portStr, err := net.SplitHostPort(strings.TrimSpace(s))
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 0 || port > 65535 {
		return "", 0, fmt.Errorf("port %q out of range", portStr)
	}
	if strings.TrimSpace(host) == "" {
		host = "127.0.0.1"
	}
	return host, port, nil
}

const boardsCommandTrigger = "boards"

func boardsCommand() *mm_model.Command {
	return &mm_model.Command{
		Trigger:          boardsCommandTrigger,
		AutoComplete:     true,
		AutoCompleteDesc: "Open Boards or manage MCP API keys",
		AutoCompleteHint: "[getapi <description> | listapi | revokeapi <prefix-or-key> | help]",
		DisplayName:      "Boards",
		Description:      "Open Boards in your browser, or manage personal MCP API keys for AI agents",
	}
}

// ExecuteCommand handles /boards and its subcommands:
//
//	/boards [path]                 — open Boards (existing handoff link)
//	/boards getapi <description>   — issue a new MCP API key
//	/boards listapi                — list your MCP API keys
//	/boards revokeapi <key>        — revoke by pasting the full plaintext key
//	/boards help                   — show usage
//
// Anything that doesn't parse as a subcommand and starts with "/" is still
// treated as a deep-link path for the legacy handoff flow, preserving
// backward compatibility with `/boards /boards/team/<id>/<board>`.
func (p *Plugin) ExecuteCommand(_ *plugin.Context, args *mm_model.CommandArgs) (*mm_model.CommandResponse, *mm_model.AppError) {
	rest := strings.TrimSpace(strings.TrimPrefix(args.Command, "/"+boardsCommandTrigger))

	// Subcommand dispatch. Path-style invocations always start with "/" so
	// they don't collide with the bare keywords below.
	if rest != "" && !strings.HasPrefix(rest, "/") {
		fields := strings.Fields(rest)
		switch strings.ToLower(fields[0]) {
		case "help":
			return ephemeralResponse(boardsHelpText()), nil
		case "getapi":
			desc := ""
			if len(fields) > 1 {
				desc = strings.TrimSpace(strings.TrimPrefix(rest, fields[0]))
			}
			return p.handleGetAPI(args, desc), nil
		case "listapi":
			return p.handleListAPI(args), nil
		case "revokeapi":
			if len(fields) < 2 {
				return ephemeralResponse("Usage: `/boards revokeapi <prefix-or-full-key>` — pass either the 8-char prefix from `/boards listapi` or the full plaintext key."), nil
			}
			return p.handleRevokeAPI(args, fields[1]), nil
		}
		return ephemeralResponse("Unknown subcommand. " + boardsHelpText()), nil
	}

	return p.handleHandoff(args, rest), nil
}

func (p *Plugin) handleHandoff(args *mm_model.CommandArgs, rest string) *mm_model.CommandResponse {
	if p.handoff == nil {
		return ephemeralResponse("Boards plugin is not fully started yet, please retry in a moment.")
	}

	to := rest
	if to == "" {
		// Land on the team route so TeamToBoardAndViewRedirect can pick the
		// last-opened or first visible board for this user. Without a team
		// in the URL the webapp lands on an empty "create board" state.
		if args.TeamId != "" {
			to = "/boards/team/" + args.TeamId
		} else {
			to = "/boards/"
		}
	} else if !strings.HasPrefix(to, "/") {
		to = "/" + to
	}

	token, err := p.handoff.IssueToken(args.UserId, to)
	if err != nil {
		switch {
		case errors.Is(err, handoff.ErrInvalidRedirect):
			return ephemeralResponse("That path isn't allowed. Try `/boards` for the home view, or `/boards /boards/team/<id>/<board>` for a specific board.")
		case errors.Is(err, handoff.ErrUnauthorized):
			return ephemeralResponse("Could not identify your user — please re-login to Mattermost.")
		default:
			return ephemeralResponse("Could not generate a link, please try again.")
		}
	}

	siteURL := ""
	if cfg := p.MattermostPlugin.API.GetConfig(); cfg != nil && cfg.ServiceSettings.SiteURL != nil {
		siteURL = *cfg.ServiceSettings.SiteURL
	}
	link := siteURL + handoff.ConsumePath(token)
	return ephemeralResponse(fmt.Sprintf("[Open Boards](%s) — link is valid for 60 seconds and works once.", link))
}

func (p *Plugin) handleGetAPI(args *mm_model.CommandArgs, description string) *mm_model.CommandResponse {
	if p.mcpKeys == nil {
		return ephemeralResponse("MCP key store is not initialized.")
	}
	if !p.mcpEnabled() {
		return ephemeralResponse("MCP server is disabled. Ask your admin to enable it in System Console → Plugins → Mattermost Boards.")
	}
	if description == "" {
		description = "(no description)"
	}
	plaintext, meta, err := p.mcpKeys.IssueKey(args.UserId, description)
	if err != nil {
		p.mcpLogger.Warn("mcp: issue key failed", mlog.Err(err))
		return ephemeralResponse("Could not issue an API key, please try again.")
	}
	mcpURL := p.mcpExternalURL()
	created := time.UnixMilli(meta.CreatedAt).UTC().Format(time.RFC3339)
	body := fmt.Sprintf(
		"### MCP API key issued\n"+
			"**Key (shown once — save it now):**\n```\n%s\n```\n"+
			"**Server URL:** `%s`\n"+
			"**Description:** %s\n"+
			"**Issued:** %s\n"+
			"**Prefix (for revoke):** `%s`\n\n"+
			"**Example MCP client config:**\n```json\n"+
			"{\n  \"mcpServers\": {\n    \"boards\": {\n      \"url\": \"%s\",\n      \"headers\": { \"Authorization\": \"Bearer %s\" }\n    }\n  }\n}\n```\n\n"+
			"To revoke later: `/boards revokeapi %s` (or paste the full key).",
		plaintext, mcpURL, description, created, hashPrefixRaw(meta.Hash), mcpURL, plaintext, hashPrefixRaw(meta.Hash),
	)
	return ephemeralResponse(body)
}

func (p *Plugin) handleListAPI(args *mm_model.CommandArgs) *mm_model.CommandResponse {
	if p.mcpKeys == nil {
		return ephemeralResponse("MCP key store is not initialized.")
	}
	keys, err := p.mcpKeys.ListKeysForUser(args.UserId)
	if err != nil {
		p.mcpLogger.Warn("mcp: list keys failed", mlog.Err(err))
		return ephemeralResponse("Could not list keys, please try again.")
	}
	if len(keys) == 0 {
		return ephemeralResponse("You have no MCP API keys. Run `/boards getapi <description>` to issue one.")
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].CreatedAt > keys[j].CreatedAt })
	var b strings.Builder
	b.WriteString("### Your MCP API keys\n\n| Key prefix | Description | Issued |\n|---|---|---|\n")
	for _, k := range keys {
		desc := k.Description
		if desc == "" {
			desc = "(no description)"
		}
		b.WriteString(fmt.Sprintf("| `%s` | %s | %s |\n",
			hashPrefixDisplay(k.Hash), desc, time.UnixMilli(k.CreatedAt).UTC().Format(time.RFC3339)))
	}
	b.WriteString("\nRevoke with `/boards revokeapi <prefix-or-full-key>` — paste the full key from your MCP client config, or just the 8-char prefix shown above.")
	return ephemeralResponse(b.String())
}

// hashPrefixDisplay returns a short, non-secret label for a key listing.
// Empty input renders as "—" so the listing stays readable for malformed
// records. Trailing ellipsis hints that the value is truncated.
func hashPrefixDisplay(hash string) string {
	if hash == "" {
		return "—"
	}
	if len(hash) > 8 {
		return hash[:8] + "…"
	}
	return hash
}

// hashPrefixRaw is the same prefix without decoration, suitable for pasting
// back into a slash command.
func hashPrefixRaw(hash string) string {
	if len(hash) > 8 {
		return hash[:8]
	}
	return hash
}

func (p *Plugin) handleRevokeAPI(args *mm_model.CommandArgs, input string) *mm_model.CommandResponse {
	if p.mcpKeys == nil {
		return ephemeralResponse("MCP key store is not initialized.")
	}
	// Detection: a freshly-issued plaintext is exactly 64 hex characters
	// (32 random bytes encoded). Anything else is treated as a hash prefix
	// drawn from `/boards listapi`.
	var err error
	if isHexLen(input, 64) {
		err = p.mcpKeys.RevokeByPlaintext(args.UserId, input, false)
	} else {
		var match *mcp.KeyMeta
		match, err = p.mcpKeys.FindByHashPrefix(args.UserId, input)
		if err == nil {
			err = p.mcpKeys.RevokeByHash(match.Hash)
		}
	}
	if err != nil {
		switch {
		case errors.Is(err, mcp.ErrKeyNotFound):
			return ephemeralResponse("No matching key. Run `/boards listapi` to see your prefixes, or paste the full key from your MCP client config.")
		case errors.Is(err, mcp.ErrAmbiguousPrefix):
			return ephemeralResponse("That prefix matches more than one of your keys — use a longer prefix.")
		case errors.Is(err, mcp.ErrKeyForbidden):
			return ephemeralResponse("That key was issued by another user; you can't revoke it.")
		default:
			p.mcpLogger.Warn("mcp: revoke key failed", mlog.Err(err))
			return ephemeralResponse("Could not revoke the key, please try again.")
		}
	}
	return ephemeralResponse("Revoked.")
}

// isHexLen reports whether s is exactly n characters of [0-9a-f].
func isHexLen(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		case c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

// mcpEnabled reports whether the admin has enabled MCP in plugin settings.
func (p *Plugin) mcpEnabled() bool {
	cfg := p.MattermostPlugin.API.GetConfig()
	if cfg == nil {
		return false
	}
	settings := cfg.PluginSettings.Plugins[boards.PluginName]
	enabled, _ := settings[mcpEnabledSetting].(bool)
	return enabled
}

// mcpExternalURL builds a URL the user can paste into their MCP client.
// When the listener is bound to a wildcard address, we substitute the
// SiteURL hostname so the user gets something they can actually connect to.
func (p *Plugin) mcpExternalURL() string {
	listenAddr := mcpDefaultListenAddr
	if cfg := p.MattermostPlugin.API.GetConfig(); cfg != nil {
		settings := cfg.PluginSettings.Plugins[boards.PluginName]
		if v, ok := settings[mcpListenAddrSetting].(string); ok && strings.TrimSpace(v) != "" {
			listenAddr = strings.TrimSpace(v)
		}
		host, port, err := splitListenAddr(listenAddr)
		if err != nil {
			return fmt.Sprintf("http://%s/mcp", listenAddr)
		}
		if isWildcardAddr(host) && cfg.ServiceSettings.SiteURL != nil {
			if u, urlErr := url.Parse(*cfg.ServiceSettings.SiteURL); urlErr == nil && u.Hostname() != "" {
				host = u.Hostname()
			}
		}
		return fmt.Sprintf("http://%s/mcp", net.JoinHostPort(host, strconv.Itoa(port)))
	}
	return fmt.Sprintf("http://%s/mcp", listenAddr)
}

func isWildcardAddr(s string) bool {
	switch strings.TrimSpace(s) {
	case "0.0.0.0", "::", "[::]", "":
		return true
	}
	return false
}

func boardsHelpText() string {
	return "**`/boards` — open Boards or manage MCP API keys**\n" +
		"- `/boards` — get a one-time link that opens Boards in your browser without re-logging in.\n" +
		"- `/boards getapi <description>` — issue a personal MCP API key. Shown once.\n" +
		"- `/boards listapi` — list your issued keys (prefix, description, date).\n" +
		"- `/boards revokeapi <prefix-or-full-key>` — revoke by 8-char prefix or full plaintext.\n" +
		"- `/boards help` — this message."
}

func ephemeralResponse(text string) *mm_model.CommandResponse {
	return &mm_model.CommandResponse{
		ResponseType: mm_model.CommandResponseTypeEphemeral,
		Text:         text,
	}
}

// OnConfigurationChange is invoked when configuration changes may have been made.
func (p *Plugin) OnConfigurationChange() error {
	// Have we been setup by OnActivate?
	if p.boardsApp == nil {
		return nil
	}

	if err := p.boardsApp.OnConfigurationChange(); err != nil {
		return err
	}
	p.reconcileMCP()
	return nil
}

func (p *Plugin) OnWebSocketConnect(webConnID, userID string) {
	p.boardsApp.OnWebSocketConnect(webConnID, userID)
}

func (p *Plugin) OnWebSocketDisconnect(webConnID, userID string) {
	p.boardsApp.OnWebSocketDisconnect(webConnID, userID)
}

func (p *Plugin) WebSocketMessageHasBeenPosted(webConnID, userID string, req *mm_model.WebSocketRequest) {
	p.boardsApp.WebSocketMessageHasBeenPosted(webConnID, userID, req)
}

func (p *Plugin) OnDeactivate() error {
	if p.mcpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := p.mcpServer.Stop(ctx); err != nil {
			p.mcpLogger.Warn("mcp: stop returned error", mlog.Err(err))
		}
		cancel()
		p.mcpServer = nil
	}
	return p.boardsApp.Stop()
}

func (p *Plugin) OnPluginClusterEvent(ctx *plugin.Context, ev mm_model.PluginClusterEvent) {
	p.boardsApp.OnPluginClusterEvent(ctx, ev)
}

func (p *Plugin) MessageWillBePosted(ctx *plugin.Context, post *mm_model.Post) (*mm_model.Post, string) {
	return p.boardsApp.MessageWillBePosted(ctx, post)
}

func (p *Plugin) MessageWillBeUpdated(ctx *plugin.Context, newPost, oldPost *mm_model.Post) (*mm_model.Post, string) {
	return p.boardsApp.MessageWillBeUpdated(ctx, newPost, oldPost)
}

func (p *Plugin) RunDataRetention(nowTime, batchSize int64) (int64, error) {
	return p.boardsApp.RunDataRetention(nowTime, batchSize)
}

func (p *Plugin) GenerateSupportData(ctx *plugin.Context) ([]*mm_model.FileData, error) {
	return p.boardsApp.GenerateSupportData(ctx)
}

const (
	// mcpPluginRoutePath is the request path served via Mattermost's
	// inter-plugin HTTP API. Admins configure mattermost-plugin-agents with
	// BaseURL: plugin://focalboard/mcp; that's delivered to this plugin's
	// ServeHTTP with r.URL.Path = "/mcp".
	mcpPluginRoutePath = "/mcp"
	// mcpAdminKeysPathPrefix is the admin keys endpoint reached at
	// /plugins/focalboard/api/v2/mcp/admin/keys[/...] from the webapp
	// admin-console custom setting component. Served regardless of MCP
	// listener state so admins can audit/revoke historical keys.
	mcpAdminKeysPathPrefix = "/api/v2/mcp/admin/keys"
)

// ServeHTTP routes requests delivered by Mattermost. /handoff/* is owned by
// the mobile-handoff bridge, /mcp by the MCP server (when enabled), and the
// admin keys API by the keys table component (always available once the
// plugin has activated). Everything else falls through to BoardsApp.
//
// /mcp is delivered through two distinct Mattermost code paths that look
// identical at this layer (same URL.Path, same in-process call). To keep
// the inter-plugin path's `X-Mattermost-UserID` trust from also applying
// to external HTTP, we dispatch on `Mattermost-Plugin-ID`: Mattermost sets
// that header on inter-plugin calls and explicitly strips it on external
// requests, so its presence is unspoofable.
func (p *Plugin) ServeHTTP(ctx *plugin.Context, w http.ResponseWriter, r *http.Request) {
	if p.handoff != nil && strings.HasPrefix(r.URL.Path, "/handoff/") {
		p.handoff.ServeHTTP(w, r)
		return
	}
	if p.mcpServer != nil && r.URL.Path == mcpPluginRoutePath {
		if strings.TrimSpace(r.Header.Get("Mattermost-Plugin-ID")) != "" {
			p.mcpServer.ServeInterPlugin(w, r)
		} else {
			p.mcpServer.ServeExternalHTTP(w, r)
		}
		return
	}
	if p.mcpKeys != nil && strings.HasPrefix(r.URL.Path, mcpAdminKeysPathPrefix) {
		sub := strings.TrimPrefix(r.URL.Path, mcpAdminKeysPathPrefix)
		mcp.HandleAdminKeys(w, r, sub, p.MattermostPlugin.API, p.mcpKeys, p.mcpLogger)
		return
	}
	p.boardsApp.ServeHTTP(ctx, w, r)
}

func defaultLoggingConfig() string {
	return `
	{
		"def": {
			"type": "focalboard_plugin_adapter",
			"options": {},
			"format": "plain",
			"format_options": {
				"delim": " ",
				"min_level_len": 0,
				"min_msg_len": 0,
				"enable_color": false,
				"enable_caller": true
			},
			"levels": [
				{"id": 5, "name": "debug"},
				{"id": 4, "name": "info", "color": 36},
				{"id": 3, "name": "warn"},
				{"id": 2, "name": "error", "color": 31},
				{"id": 1, "name": "fatal", "stacktrace": true},
				{"id": 0, "name": "panic", "stacktrace": true}
			]
		},
		"errors_file": {
			"Type": "file",
			"Format": "plain",
			"Levels": [
				{"ID": 2, "Name": "error", "Stacktrace": true}
			],
			"Options": {
				"Compress": true,
				"Filename": "focalboard_errors.log",
				"MaxAgeDays": 0,
				"MaxBackups": 5,
				"MaxSizeMB": 10
			},
			"MaxQueueSize": 1000
		}
	}`
}
