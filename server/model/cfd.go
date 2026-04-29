// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package model

// CFDSeries is one band of the Cumulative Flow Diagram. For select-typed
// properties Key is the option id and Color is the option's palette name
// (e.g. "propColorGreen") so the client renders bands in the same colors
// the user picked. For person-typed properties Key is the user id and
// Color is empty — the client hashes the id into the palette.
//
// swagger:model
type CFDSeries struct {
	// Stable id used as the band key; option id for select, user id for
	// person, or "__none" for cards without a value.
	// required: true
	Key string `json:"key"`

	// Human-readable label. For select this is the option value; for
	// person this is the user id (frontend resolves to display name); for
	// "__none" this is "No value".
	// required: true
	Label string `json:"label"`

	// CSS palette name like "propColorGreen". Empty for person bands and
	// the "No value" band.
	// required: false
	Color string `json:"color"`
}

// CFDResult is the response of GET /boards/{boardID}/cfd. Values is a 2D
// matrix indexed [seriesIdx][dateIdx] so the frontend can iterate either
// axis cheaply.
//
// swagger:model
type CFDResult struct {
	// Inclusive start of the rendered range (epoch ms, start-of-UTC-day).
	// required: true
	From int64 `json:"from"`

	// Inclusive end (epoch ms, start-of-UTC-day).
	// required: true
	To int64 `json:"to"`

	// Currently always "day".
	// required: true
	Bucket string `json:"bucket"`

	// The property the CFD groups by.
	// required: true
	PropertyID string `json:"propertyId"`

	// The Boards property type (select / multiSelect / person /
	// multiPerson / personNotify / multiPersonNotify).
	// required: true
	PropertyType string `json:"propertyType"`

	// Bands rendered in stack order (first = bottom).
	// required: true
	Series []CFDSeries `json:"series"`

	// Day stamps (start-of-UTC-day, ms) parallel to Values' second axis.
	// required: true
	Dates []int64 `json:"dates"`

	// values[i][j] = number of cards (or assignments, for multi-*) in
	// Series[i] on Dates[j].
	// required: true
	Values [][]int `json:"values"`
}
