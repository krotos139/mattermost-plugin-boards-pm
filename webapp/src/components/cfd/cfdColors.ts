// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Hex equivalents of the propColor* palette, mirrored from
// focalboard-variables.scss. SVG presentation attributes (fill / stroke)
// don't resolve `var(--…)` references, so we resolve to literal hex here.

const HEX_BY_NAME: Record<string, string> = {
    propColorDefault: '#dddfe4',
    propColorGray: '#ededed',
    propColorBrown: '#f7ddc3',
    propColorOrange: '#ffd3c1',
    propColorYellow: '#f7f0b6',
    propColorGreen: '#c7eac3',
    propColorBlue: '#b1d1f6',
    propColorPurple: '#e6d0ff',
    propColorPink: '#ffd6e9',
    propColorRed: '#ffa9a9',
}

// Stable, palette-cycled colors for person-typed bands. The id (user id)
// is hashed deterministically into the palette so the same user always
// shows in the same color across renders, but every user gets a distinct
// hue without anyone configuring colors per-user.
const PERSON_PALETTE = [
    'propColorBlue',
    'propColorGreen',
    'propColorPurple',
    'propColorOrange',
    'propColorPink',
    'propColorYellow',
    'propColorRed',
    'propColorBrown',
    'propColorGray',
]

// djb2 — fast, no-collisions-on-typical-input hash that maps short strings
// to 32-bit integers we can mod by the palette length.
function hashStringDJB2(s: string): number {
    let h = 5381
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0
    }
    return Math.abs(h)
}

// resolveBandColor returns a hex string for the given band. `colorName`
// comes from the server (option color for select bands; "" for person /
// no-value bands). For person bands we hash the band's `key` (user id)
// into the palette. For "no value" we return a neutral gray.
export function resolveBandColor(key: string, colorName: string): string {
    if (colorName && HEX_BY_NAME[colorName]) {
        return HEX_BY_NAME[colorName]
    }
    if (key === '__none') {
        return '#e3e3e3'
    }
    const idx = hashStringDJB2(key) % PERSON_PALETTE.length
    return HEX_BY_NAME[PERSON_PALETTE[idx]]
}
