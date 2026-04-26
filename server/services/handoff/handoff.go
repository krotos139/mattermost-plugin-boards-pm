// Package handoff implements a one-time-token bridge that lets the Mattermost
// mobile client open Boards in the device's system browser without forcing the
// user to log in again.
//
// Flow:
//   1. Mobile app (already authenticated to MM) POSTs /handoff/issue with an
//      optional `to` path. We trust the Mattermost-User-Id header that the MM
//      router injects after auth; that's the standard plugin-handler contract.
//   2. We mint a short-lived single-use token bound to that user and the
//      requested redirect target, and return it.
//   3. Mobile app opens https://<server>/plugins/focalboard/handoff/consume?t=<token>
//      in the system browser.
//   4. Consume validates the token, mints a fresh MM session via plugin.API,
//      sets the three session cookies (MMAUTHTOKEN/MMUSERID/MMCSRF), and 302s
//      to the stored target.
package handoff

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	mm_model "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

var (
	ErrUnauthorized    = errors.New("handoff: unauthorized")
	ErrInvalidRedirect = errors.New("handoff: invalid redirect target")
)

const (
	tokenTTL          = 60 * time.Second
	sessionTTL        = 24 * time.Hour
	defaultRedirectTo = "/boards/"

	cookieAuthToken = "MMAUTHTOKEN"
	cookieUserID    = "MMUSERID"
	cookieCSRF      = "MMCSRF"

	headerUserID = "Mattermost-User-Id"
)

type entry struct {
	userID    string
	to        string
	expiresAt time.Time
}

// Service issues and consumes handoff tokens. Tokens are kept in memory; a
// plugin restart invalidates outstanding tokens, which is fine given the 60s
// TTL and single-use semantics.
type Service struct {
	api    plugin.API
	logger mlog.LoggerIFace

	mu     sync.Mutex
	tokens map[string]entry
}

func New(api plugin.API, logger mlog.LoggerIFace) *Service {
	return &Service{
		api:    api,
		logger: logger,
		tokens: make(map[string]entry),
	}
}

// ServeHTTP dispatches /handoff/issue (POST) and /handoff/consume (GET).
// The plugin's outer ServeHTTP is responsible for routing /handoff/* here.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/handoff/issue":
		s.issue(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/handoff/consume":
		s.consume(w, r)
	default:
		http.NotFound(w, r)
	}
}

// IssueToken mints a single-use token for userID and stashes the redirect
// target. Callers in the same process (e.g. the /boards slash command) use
// this directly; the HTTP issue handler is a thin wrapper around it.
func (s *Service) IssueToken(userID, to string) (string, error) {
	if userID == "" {
		return "", ErrUnauthorized
	}
	if to == "" {
		to = defaultRedirectTo
	}
	if !validRedirect(to) {
		return "", ErrInvalidRedirect
	}

	token, err := newToken()
	if err != nil {
		return "", err
	}

	s.mu.Lock()
	s.purgeLocked()
	s.tokens[token] = entry{
		userID:    userID,
		to:        to,
		expiresAt: time.Now().Add(tokenTTL),
	}
	s.mu.Unlock()

	return token, nil
}

// ConsumePath is the plugin-relative URL a browser should hit to redeem a
// token. Callers prepend the server's SiteURL.
func ConsumePath(token string) string {
	return "/plugins/focalboard/handoff/consume?t=" + token
}

func (s *Service) issue(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get(headerUserID)
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	to := defaultRedirectTo
	if r.ContentLength > 0 {
		var body struct {
			To string `json:"to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil && body.To != "" {
			to = body.To
		}
	}

	token, err := s.IssueToken(userID, to)
	switch err {
	case nil:
	case ErrUnauthorized:
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	case ErrInvalidRedirect:
		http.Error(w, "invalid redirect target", http.StatusBadRequest)
		return
	default:
		s.logger.Error("handoff: failed to generate token", mlog.Err(err))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"token": token,
		"path":  ConsumePath(token),
	})
}

func (s *Service) consume(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	if token == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	e, ok := s.tokens[token]
	if ok {
		delete(s.tokens, token)
	}
	s.mu.Unlock()

	if !ok || time.Now().After(e.expiresAt) {
		http.Error(w, "token invalid or expired", http.StatusUnauthorized)
		return
	}

	expiresAt := time.Now().Add(sessionTTL)
	session, appErr := s.api.CreateSession(&mm_model.Session{
		UserId:    e.userID,
		ExpiresAt: expiresAt.UnixMilli(),
	})
	if appErr != nil {
		s.logger.Error("handoff: CreateSession failed", mlog.String("user_id", e.userID), mlog.Err(appErr))
		http.Error(w, "could not create session", http.StatusInternalServerError)
		return
	}

	secure := s.cookieSecure()
	common := func(name, value string, httpOnly bool) *http.Cookie {
		return &http.Cookie{
			Name:     name,
			Value:    value,
			Path:     "/",
			Expires:  expiresAt,
			MaxAge:   int(sessionTTL.Seconds()),
			HttpOnly: httpOnly,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		}
	}
	http.SetCookie(w, common(cookieAuthToken, session.Token, true))
	http.SetCookie(w, common(cookieUserID, session.UserId, false))
	http.SetCookie(w, common(cookieCSRF, session.GetCSRF(), false))

	http.Redirect(w, r, e.to, http.StatusFound)
}

// purgeLocked drops expired tokens. Caller must hold s.mu.
func (s *Service) purgeLocked() {
	now := time.Now()
	for k, v := range s.tokens {
		if now.After(v.expiresAt) {
			delete(s.tokens, k)
		}
	}
}

func (s *Service) cookieSecure() bool {
	cfg := s.api.GetConfig()
	if cfg == nil || cfg.ServiceSettings.SiteURL == nil {
		return false
	}
	return strings.HasPrefix(*cfg.ServiceSettings.SiteURL, "https://")
}

func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// validRedirect restricts handoff redirects to the boards UI surface. Anything
// outside that surface (off-host, protocol-relative, traversal) is rejected so
// the endpoint can't be turned into an open redirect.
func validRedirect(to string) bool {
	if to == "" || to == "/" {
		return true
	}
	if !strings.HasPrefix(to, "/") || strings.HasPrefix(to, "//") {
		return false
	}
	if strings.Contains(to, "..") {
		return false
	}
	return strings.HasPrefix(to, "/boards/") || strings.HasPrefix(to, "/plugins/focalboard/")
}
