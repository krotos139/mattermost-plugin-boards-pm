// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package mcp

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	mm_model "github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

// Per-user MCP API keys are persisted in the plugin KV store, keyed by the
// sha256 of the plaintext bearer:
//
//	mcp_keyhash_<sha256hex> → KeyMeta
//
// The plaintext is shown to the user once at issuance and never stored. To
// revoke from /boards revokeapi, the user pastes the same plaintext back in
// and we re-hash it to find the record. Admins revoke by hash from the
// settings-page table.
const (
	keyHashPrefix = "mcp_keyhash_"
	kvListBatch   = 100
)

// KVAPI is the subset of plugin.API used to persist API keys. Defined as an
// interface so the keys logic can be unit-tested with a fake.
type KVAPI interface {
	KVSetWithOptions(key string, value []byte, options mm_model.PluginKVSetOptions) (bool, *mm_model.AppError)
	KVGet(key string) ([]byte, *mm_model.AppError)
	KVDelete(key string) *mm_model.AppError
	KVList(page, perPage int) ([]string, *mm_model.AppError)
}

// KeyMeta is the persisted metadata for an issued API key. The hash doubles
// as the row identifier in the admin table; users never see it.
type KeyMeta struct {
	Hash        string `json:"hash"`
	UserID      string `json:"user_id"`
	Description string `json:"description"`
	CreatedAt   int64  `json:"created_at"`
}

// KeyStore manages issuance, lookup, and revocation of MCP API keys.
type KeyStore struct {
	api    KVAPI
	logger mlog.LoggerIFace
}

func NewKeyStore(api KVAPI, logger mlog.LoggerIFace) *KeyStore {
	return &KeyStore{api: api, logger: logger}
}

var (
	ErrKeyNotFound     = errors.New("api key not found or revoked")
	ErrKeyForbidden    = errors.New("not the owner of this key")
	ErrAmbiguousPrefix = errors.New("hash prefix matches more than one key — use a longer prefix")
)

// IssueKey generates a fresh random key, persists meta, and returns the
// plaintext (shown once) plus the meta record.
func (k *KeyStore) IssueKey(userID, description string) (string, *KeyMeta, error) {
	if userID == "" {
		return "", nil, errors.New("user id required")
	}
	plaintext, err := generateKeyPlaintext()
	if err != nil {
		return "", nil, err
	}
	meta := &KeyMeta{
		Hash:        hashKey(plaintext),
		UserID:      userID,
		Description: strings.TrimSpace(description),
		CreatedAt:   time.Now().UnixMilli(),
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return "", nil, fmt.Errorf("marshal key meta: %w", err)
	}
	if _, appErr := k.api.KVSetWithOptions(keyHashPrefix+meta.Hash, metaBytes, mm_model.PluginKVSetOptions{}); appErr != nil {
		return "", nil, fmt.Errorf("kv set keyhash: %s", appErr.Message)
	}
	return plaintext, meta, nil
}

// LookupUserIDByPlaintext hashes the bearer and resolves to the owning user.
// Returns ErrKeyNotFound for an unknown key.
func (k *KeyStore) LookupUserIDByPlaintext(plaintext string) (string, error) {
	if plaintext == "" {
		return "", ErrKeyNotFound
	}
	meta, err := k.findByHash(hashKey(plaintext))
	if err != nil {
		return "", err
	}
	return meta.UserID, nil
}

// ListKeysForUser returns all keys owned by the given userID.
func (k *KeyStore) ListKeysForUser(userID string) ([]*KeyMeta, error) {
	all, err := k.ListAllKeys()
	if err != nil {
		return nil, err
	}
	out := make([]*KeyMeta, 0, len(all))
	for _, m := range all {
		if m.UserID == userID {
			out = append(out, m)
		}
	}
	return out, nil
}

// ListAllKeys enumerates every issued key. Used by the admin keys table and
// (filtered) by /boards listapi.
func (k *KeyStore) ListAllKeys() ([]*KeyMeta, error) {
	var allKeys []string
	page := 0
	for {
		batch, appErr := k.api.KVList(page, kvListBatch)
		if appErr != nil {
			return nil, fmt.Errorf("kv list: %s", appErr.Message)
		}
		if len(batch) == 0 {
			break
		}
		allKeys = append(allKeys, batch...)
		if len(batch) < kvListBatch {
			break
		}
		page++
	}
	out := make([]*KeyMeta, 0)
	for _, key := range allKeys {
		if !strings.HasPrefix(key, keyHashPrefix) {
			continue
		}
		raw, appErr := k.api.KVGet(key)
		if appErr != nil || len(raw) == 0 {
			continue
		}
		var meta KeyMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			k.logger.Warn("mcp keys: skipping unparseable record",
				mlog.String("kv_key", key), mlog.Err(err))
			continue
		}
		// Always trust the KV key name as the canonical hash. Old records
		// (from a pre-1.1.3 schema where the keyhash row stored only
		// {KeyID, UserID}) deserialize with meta.Hash="" — derive it here so
		// listing and revoke can still operate on them.
		meta.Hash = strings.TrimPrefix(key, keyHashPrefix)
		out = append(out, &meta)
	}
	return out, nil
}

// RevokeByPlaintext is the user-facing revoke. The caller must own the key;
// pass isAdmin=true to skip the ownership check.
func (k *KeyStore) RevokeByPlaintext(callerUserID, plaintext string, isAdmin bool) error {
	if plaintext == "" {
		return ErrKeyNotFound
	}
	return k.revokeByHash(callerUserID, hashKey(plaintext), isAdmin)
}

// RevokeByHash is the admin-facing revoke (from the keys table). No
// ownership check — the HTTP handler must enforce IsSystemAdmin first.
func (k *KeyStore) RevokeByHash(hash string) error {
	return k.revokeByHash("", hash, true)
}

func (k *KeyStore) revokeByHash(callerUserID, hash string, isAdmin bool) error {
	meta, err := k.findByHash(hash)
	if err != nil {
		return err
	}
	if !isAdmin && meta.UserID != callerUserID {
		return ErrKeyForbidden
	}
	if appErr := k.api.KVDelete(keyHashPrefix + meta.Hash); appErr != nil {
		return fmt.Errorf("kv delete keyhash: %s", appErr.Message)
	}
	return nil
}

func (k *KeyStore) findByHash(hash string) (*KeyMeta, error) {
	if hash == "" {
		return nil, ErrKeyNotFound
	}
	raw, appErr := k.api.KVGet(keyHashPrefix + hash)
	if appErr != nil {
		return nil, fmt.Errorf("kv get keyhash: %s", appErr.Message)
	}
	if len(raw) == 0 {
		return nil, ErrKeyNotFound
	}
	var meta KeyMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	// Force the canonical hash to be the KV key we looked up under, so
	// records from earlier schemas (without a Hash field) get a usable
	// value and downstream KVDelete targets the right row.
	meta.Hash = hash
	return &meta, nil
}

// FindByHashPrefix scans the caller's keys for a hash that starts with the
// given prefix. Returns ErrKeyNotFound if none match, ErrAmbiguousPrefix if
// more than one matches.
func (k *KeyStore) FindByHashPrefix(callerUserID, prefix string) (*KeyMeta, error) {
	if prefix == "" {
		return nil, ErrKeyNotFound
	}
	owned, err := k.ListKeysForUser(callerUserID)
	if err != nil {
		return nil, err
	}
	var matches []*KeyMeta
	for _, m := range owned {
		if strings.HasPrefix(m.Hash, prefix) {
			matches = append(matches, m)
		}
	}
	switch len(matches) {
	case 0:
		return nil, ErrKeyNotFound
	case 1:
		return matches[0], nil
	default:
		return nil, ErrAmbiguousPrefix
	}
}

func generateKeyPlaintext() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

func hashKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
