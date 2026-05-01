// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import './calendar.scss'

// Glyph for the Scheduler view: a week-time-grid calendar with an event block,
// distinct from the simpler month-grid icon used for Calendar view.
export default function SchedulerIcon(): JSX.Element {
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
            className='SchedulerIcon Icon'
        >
            <rect
                x='3'
                y='5'
                width='18'
                height='15'
                rx='2'
            />
            <path d='M3 9 H21'/>
            <path d='M9 5 V3'/>
            <path d='M15 5 V3'/>
            <path d='M9 9 V20'/>
            <path d='M15 9 V20'/>
            <rect
                x='10'
                y='11'
                width='4'
                height='5'
                rx='0.5'
                fill='currentColor'
                opacity='0.4'
                stroke='none'
            />
        </svg>
    )
}
