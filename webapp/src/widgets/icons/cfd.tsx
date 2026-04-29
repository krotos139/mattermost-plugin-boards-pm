// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import './calendar.scss'

// Stacked-area glyph used for the Cumulative Flow Diagram (CFD) view in
// the View menu. Three monotonically rising curves stacked along the
// X axis so the shape reads as "growing bands over time" at small sizes.
export default function CFDIcon(): JSX.Element {
    return (
        <svg
            width='24'
            height='24'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.4'
            strokeLinecap='round'
            strokeLinejoin='round'
            xmlns='http://www.w3.org/2000/svg'
            className='CFDIcon Icon'
        >
            <path
                d='M3 19 V5 M3 19 H21'
                stroke='currentColor'
            />
            <path
                d='M3 17 C7 16 11 14 15 12 C18 10.5 20 10 21 9.5 L21 19 L3 19 Z'
                fill='currentColor'
                opacity='0.55'
                stroke='none'
            />
            <path
                d='M3 14 C7 13 11 11.5 15 9.5 C18 8 20 7.5 21 7.2 L21 19 L3 19 Z'
                fill='currentColor'
                opacity='0.35'
                stroke='none'
            />
            <path
                d='M3 11 C7 10 11 8 15 6 C18 4.5 20 4 21 3.8 L21 19 L3 19 Z'
                fill='currentColor'
                opacity='0.18'
                stroke='none'
            />
        </svg>
    )
}
