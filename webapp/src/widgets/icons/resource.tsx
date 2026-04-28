// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import './calendar.scss'

// Two-people glyph used for the Resource view in the View menu. Same
// 24×24 viewbox + Icon class as the rest of the icon set so it inherits
// the menu's color and sizing.
export default function ResourceIcon(): JSX.Element {
    return (
        <svg
            width='24'
            height='24'
            viewBox='0 0 24 24'
            fill='currentColor'
            xmlns='http://www.w3.org/2000/svg'
            className='ResourceIcon Icon'
        >
            <g opacity='0.85'>
                <circle cx='9' cy='8' r='3'/>
                <circle cx='17' cy='9' r='2.4'/>
                <path d='M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6v1H3v-1z'/>
                <path d='M16.4 13.4c2.3 0.4 4 2.4 4 4.7v0.9h-4.4c0.05-0.3 0.07-0.5 0.07-0.7 0-1.8-0.7-3.5-1.9-4.7l0.4-0.2c0.6-0.2 1.2-0.2 1.85 0z'/>
            </g>
        </svg>
    )
}
