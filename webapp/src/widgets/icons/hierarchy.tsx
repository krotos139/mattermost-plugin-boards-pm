// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import './calendar.scss'

// Three-node tree glyph used for the Hierarchy view in the View menu.
// Same 24×24 viewbox + Icon class as the rest of the icon set so it
// inherits the menu's color and sizing.
export default function HierarchyIcon(): JSX.Element {
    return (
        <svg
            width='24'
            height='24'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.6'
            strokeLinecap='round'
            strokeLinejoin='round'
            xmlns='http://www.w3.org/2000/svg'
            className='HierarchyIcon Icon'
        >
            <rect x='9' y='3' width='6' height='4' rx='1' fill='currentColor' opacity='0.85'/>
            <rect x='2.5' y='15' width='6' height='4' rx='1' fill='currentColor' opacity='0.85'/>
            <rect x='9' y='15' width='6' height='4' rx='1' fill='currentColor' opacity='0.85'/>
            <rect x='15.5' y='15' width='6' height='4' rx='1' fill='currentColor' opacity='0.85'/>
            <path d='M12 7v3M5.5 11h13M5.5 11v4M12 11v4M18.5 11v4'/>
        </svg>
    )
}
