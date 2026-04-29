// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Cumulative Flow Diagram aggregation. Walks the entire blocks_history
// for a board, reconstructs each card's per-day state for the chosen
// property, and returns a (series x days) count matrix the frontend
// renders as a stacked area chart.
//
// "State" is the property's value at end-of-day UTC. Deleted cards are
// counted up to the day before deletion. Cards that didn't exist yet on
// day D simply don't contribute. For multi-* properties a card with N
// values contributes once to each of the N bands ("assignments" semantics).

package app

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
)

// ErrBoardNotFoundForCFD is returned when the requested boardID has no
// matching board row.
var ErrBoardNotFoundForCFD = errors.New("board not found")

// ErrCFDPropertyNotFound is returned when the propertyId is missing,
// unknown, or of an unsupported type.
var ErrCFDPropertyNotFound = errors.New("CFD property not found or unsupported type")

// noneSeriesKey is the synthetic key used for the "no value" band.
const noneSeriesKey = "__none"

// cfdSupportedTypes is the allow-list of property types we group by.
var cfdSupportedTypes = map[string]bool{
	"select":            true,
	"multiSelect":       true,
	"person":            true,
	"multiPerson":       true,
	"personNotify":      true,
	"multiPersonNotify": true,
}

// cfdMultiTypes is the subset of cfdSupportedTypes whose values are arrays.
var cfdMultiTypes = map[string]bool{
	"multiSelect":       true,
	"multiPerson":       true,
	"multiPersonNotify": true,
}

// dayMillis is the UTC day length in milliseconds.
const dayMillis int64 = 24 * 60 * 60 * 1000

// GetCFD computes a Cumulative Flow Diagram for the given board grouped
// by the given property. from/to are millis-epoch; if from <= 0 it
// defaults to to - 30 days; if to <= 0 it defaults to "now" (caller-
// supplied via nowMillis to keep tests deterministic).
func (a *App) GetCFD(boardID, propertyID string, from, to, nowMillis int64) (*model.CFDResult, error) {
	board, err := a.store.GetBoard(boardID)
	if err != nil {
		return nil, fmt.Errorf("get board for cfd: %w", err)
	}
	if board == nil {
		return nil, fmt.Errorf("%w: %s", ErrBoardNotFoundForCFD, boardID)
	}

	prop, err := resolveCFDProperty(board.CardProperties, propertyID)
	if err != nil {
		return nil, err
	}

	if to <= 0 {
		to = nowMillis
	}
	if from <= 0 {
		from = to - 30*dayMillis
	}
	if from > to {
		from, to = to, from
	}

	// Truncate to UTC start-of-day so day stamps are stable.
	fromDay := startOfDayUTC(from)
	toDay := startOfDayUTC(to)

	// Pull the entire history descending-time-ordered. We only care about
	// card rows; content blocks and comments don't carry the property.
	rows, err := a.store.GetBlockHistoryDescendants(boardID, model.QueryBlockHistoryOptions{Descending: false})
	if err != nil {
		return nil, fmt.Errorf("get history for cfd: %w", err)
	}

	// Group card-version rows by id, in chronological order. Snapshots
	// inherit the row's update_at as their "valid from" timestamp; the
	// very first version uses create_at when update_at is missing.
	timelines := make(map[string][]cfdSnapshot)
	for _, blk := range rows {
		if blk.Type != model.TypeCard {
			continue
		}
		eff := blk.UpdateAt
		if eff == 0 {
			eff = blk.CreateAt
		}
		tokens := extractCFDTokens(blk.Fields, propertyID, prop.ptype)
		snap := cfdSnapshot{
			effectiveAt: eff,
			deleted:     blk.DeleteAt > 0,
			tokens:      tokens,
		}
		timelines[blk.ID] = append(timelines[blk.ID], snap)
	}

	// History query already orders by insert_at; the per-card slice is
	// therefore chronological, but stable-sort defensively to be robust
	// against future changes in store semantics.
	for id := range timelines {
		sort.SliceStable(timelines[id], func(i, j int) bool {
			return timelines[id][i].effectiveAt < timelines[id][j].effectiveAt
		})
	}

	// Build the day list. Each entry is the start-of-day timestamp; we
	// "snapshot" the world at end-of-day, i.e. effectiveAt <= day+24h.
	numDays := int((toDay-fromDay)/dayMillis) + 1
	if numDays < 1 {
		numDays = 1
	}
	dates := make([]int64, numDays)
	for i := 0; i < numDays; i++ {
		dates[i] = fromDay + int64(i)*dayMillis
	}

	// Token counts per day. We also remember insertion order so person
	// bands stack in a stable, first-seen sequence.
	tokenOrder := make([]string, 0, 16)
	tokenSeen := make(map[string]bool)
	tokenCounts := make(map[string][]int)

	addTokenCount := func(token string, dayIdx int) {
		if _, ok := tokenSeen[token]; !ok {
			tokenSeen[token] = true
			tokenOrder = append(tokenOrder, token)
		}
		row, ok := tokenCounts[token]
		if !ok {
			row = make([]int, numDays)
			tokenCounts[token] = row
		}
		row[dayIdx]++
	}

	// Walk every card in parallel through the day axis using a moving
	// pointer into its timeline.
	for _, snaps := range timelines {
		if len(snaps) == 0 {
			continue
		}
		ptr := 0
		var current cfdSnapshot
		hasCurrent := false
		for d := 0; d < numDays; d++ {
			endOfDay := dates[d] + dayMillis
			for ptr < len(snaps) && snaps[ptr].effectiveAt < endOfDay {
				current = snaps[ptr]
				hasCurrent = true
				ptr++
			}
			if !hasCurrent {
				continue
			}
			if current.deleted {
				continue
			}
			tokens := current.tokens
			if len(tokens) == 0 {
				addTokenCount(noneSeriesKey, d)
				continue
			}
			for _, tok := range tokens {
				if tok == "" {
					continue
				}
				addTokenCount(tok, d)
			}
		}
	}

	series, values := buildCFDSeries(prop, tokenOrder, tokenCounts, numDays)

	return &model.CFDResult{
		From:         fromDay,
		To:           toDay,
		Bucket:       "day",
		PropertyID:   propertyID,
		PropertyType: prop.ptype,
		Series:       series,
		Dates:        dates,
		Values:       values,
	}, nil
}

// cfdSnapshot is the materialized "what does this card look like at time T"
// derived from one blocks_history row.
type cfdSnapshot struct {
	effectiveAt int64
	deleted     bool
	tokens      []string
}

// cfdProperty is the resolved metadata about the property the user picked
// to group by.
type cfdProperty struct {
	id    string
	name  string
	ptype string
	// optionLabel and optionColor are populated only for select/multiSelect.
	// Removed options are absent from these maps so the caller can hide them.
	optionLabel map[string]string
	optionColor map[string]string
	// optionOrder is the canonical option order for select/multiSelect so
	// bands stack the way the user laid them out in the property settings.
	optionOrder []string
}

func resolveCFDProperty(cardProperties []map[string]interface{}, propertyID string) (*cfdProperty, error) {
	if propertyID == "" {
		return nil, fmt.Errorf("%w: propertyId is required", ErrCFDPropertyNotFound)
	}
	for _, p := range cardProperties {
		id, _ := p["id"].(string)
		if id != propertyID {
			continue
		}
		ptype, _ := p["type"].(string)
		if !cfdSupportedTypes[ptype] {
			return nil, fmt.Errorf("%w: %s has unsupported type %q", ErrCFDPropertyNotFound, propertyID, ptype)
		}
		out := &cfdProperty{id: id, ptype: ptype}
		out.name, _ = p["name"].(string)
		if rawOpts, ok := p["options"].([]interface{}); ok {
			out.optionLabel = make(map[string]string, len(rawOpts))
			out.optionColor = make(map[string]string, len(rawOpts))
			out.optionOrder = make([]string, 0, len(rawOpts))
			for _, o := range rawOpts {
				m, _ := o.(map[string]interface{})
				if m == nil {
					continue
				}
				oid, _ := m["id"].(string)
				oval, _ := m["value"].(string)
				ocol, _ := m["color"].(string)
				if oid == "" {
					continue
				}
				out.optionLabel[oid] = oval
				out.optionColor[oid] = ocol
				out.optionOrder = append(out.optionOrder, oid)
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("%w: propertyId %s not on board", ErrCFDPropertyNotFound, propertyID)
}

// extractCFDTokens pulls the property value out of a card's fields and
// normalizes it to a slice of tokens.
//   - select / person / personNotify: 0 or 1 token (string value)
//   - multiSelect / multiPerson / multiPersonNotify: 0..N tokens (array)
//
// Returns an empty slice for "no value"; caller buckets that into __none.
func extractCFDTokens(fields map[string]interface{}, propertyID, ptype string) []string {
	if fields == nil {
		return nil
	}
	props, _ := fields["properties"].(map[string]interface{})
	if props == nil {
		return nil
	}
	raw, ok := props[propertyID]
	if !ok || raw == nil {
		return nil
	}
	if cfdMultiTypes[ptype] {
		switch arr := raw.(type) {
		case []interface{}:
			out := make([]string, 0, len(arr))
			for _, v := range arr {
				s, _ := v.(string)
				s = strings.TrimSpace(s)
				if s != "" {
					out = append(out, s)
				}
			}
			return out
		case []string:
			out := make([]string, 0, len(arr))
			for _, v := range arr {
				v = strings.TrimSpace(v)
				if v != "" {
					out = append(out, v)
				}
			}
			return out
		default:
			return nil
		}
	}
	s, _ := raw.(string)
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return []string{s}
}

// buildCFDSeries turns the per-token counts into the wire format. Series
// order is:
//
//   - select/multiSelect: option order from the property settings,
//     filtering out tokens that are not (or no longer) options;
//   - person types: first-seen order in history;
//   - and the synthetic "no value" band always last (rendered on top).
func buildCFDSeries(prop *cfdProperty, tokenOrder []string, tokenCounts map[string][]int, numDays int) ([]model.CFDSeries, [][]int) {
	isSelect := prop.ptype == "select" || prop.ptype == "multiSelect"
	series := make([]model.CFDSeries, 0, len(tokenOrder))
	values := make([][]int, 0, len(tokenOrder))

	if isSelect {
		// Honor option order; skip removed options entirely so the chart
		// only shows currently-valid options.
		for _, oid := range prop.optionOrder {
			counts, ok := tokenCounts[oid]
			if !ok {
				counts = make([]int, numDays)
			}
			label := prop.optionLabel[oid]
			if label == "" {
				label = oid
			}
			series = append(series, model.CFDSeries{
				Key:   oid,
				Label: label,
				Color: prop.optionColor[oid],
			})
			values = append(values, counts)
		}
	} else {
		for _, tok := range tokenOrder {
			if tok == noneSeriesKey {
				continue
			}
			counts := tokenCounts[tok]
			series = append(series, model.CFDSeries{
				Key:   tok,
				Label: tok,
				Color: "",
			})
			values = append(values, counts)
		}
	}

	if counts, ok := tokenCounts[noneSeriesKey]; ok {
		series = append(series, model.CFDSeries{
			Key:   noneSeriesKey,
			Label: "No value",
			Color: "",
		})
		values = append(values, counts)
	}

	return series, values
}

// startOfDayUTC returns the epoch-ms timestamp of the UTC midnight that
// starts the day containing t. We don't import "time" for this — integer
// math against the day length is sufficient and avoids tz parsing.
func startOfDayUTC(tMillis int64) int64 {
	if tMillis < 0 {
		return 0
	}
	return (tMillis / dayMillis) * dayMillis
}
