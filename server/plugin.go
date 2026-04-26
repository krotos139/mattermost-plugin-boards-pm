// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/mattermost/mattermost-plugin-boards/server/boards"
	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/services/handoff"

	pluginapi "github.com/mattermost/mattermost/server/public/pluginapi"

	mm_model "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

var ErrPluginNotAllowed = errors.New("boards plugin not allowed while Boards product enabled")

// Plugin implements the interface expected by the Mattermost server to communicate between the server and plugin processes.
type Plugin struct {
	plugin.MattermostPlugin
	boardsApp *boards.BoardsApp
	handoff   *handoff.Service
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
	if err := p.MattermostPlugin.API.RegisterCommand(boardsCommand()); err != nil {
		logger.Warn("could not register /boards slash command", mlog.Err(err))
	}
	return p.boardsApp.Start()
}

const boardsCommandTrigger = "boards"

func boardsCommand() *mm_model.Command {
	return &mm_model.Command{
		Trigger:          boardsCommandTrigger,
		AutoComplete:     true,
		AutoCompleteDesc: "Open Boards in your browser, already authenticated",
		AutoCompleteHint: "[/boards/...]",
		DisplayName:      "Boards",
		Description:      "Get a one-time link that opens Boards in your browser without re-logging in",
	}
}

// ExecuteCommand handles /boards. It mints a single-use handoff token for the
// caller and replies with an ephemeral message containing a link the user can
// tap to land in Boards already authenticated. The optional argument is a
// path under /boards/ to deep-link into a specific board or view.
func (p *Plugin) ExecuteCommand(_ *plugin.Context, args *mm_model.CommandArgs) (*mm_model.CommandResponse, *mm_model.AppError) {
	if p.handoff == nil {
		return ephemeralResponse("Boards plugin is not fully started yet, please retry in a moment."), nil
	}

	to := strings.TrimSpace(strings.TrimPrefix(args.Command, "/"+boardsCommandTrigger))
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
		switch err {
		case handoff.ErrInvalidRedirect:
			return ephemeralResponse("That path isn't allowed. Try `/boards` for the home view, or `/boards /boards/team/<id>/<board>` for a specific board."), nil
		case handoff.ErrUnauthorized:
			return ephemeralResponse("Could not identify your user — please re-login to Mattermost."), nil
		default:
			return ephemeralResponse("Could not generate a link, please try again."), nil
		}
	}

	siteURL := ""
	if cfg := p.MattermostPlugin.API.GetConfig(); cfg != nil && cfg.ServiceSettings.SiteURL != nil {
		siteURL = *cfg.ServiceSettings.SiteURL
	}
	link := siteURL + handoff.ConsumePath(token)
	return ephemeralResponse(fmt.Sprintf("[Open Boards](%s) — link is valid for 60 seconds and works once.", link)), nil
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

	return p.boardsApp.OnConfigurationChange()
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

// ServeHTTP routes requests delivered by Mattermost. The /handoff/* surface is
// owned by the mobile-handoff bridge and bypasses the boards app router; all
// other paths fall through to the embedded Boards server.
func (p *Plugin) ServeHTTP(ctx *plugin.Context, w http.ResponseWriter, r *http.Request) {
	if p.handoff != nil && strings.HasPrefix(r.URL.Path, "/handoff/") {
		p.handoff.ServeHTTP(w, r)
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
