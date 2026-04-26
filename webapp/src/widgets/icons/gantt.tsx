// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import './calendar.scss'

export default function GanttIcon(): JSX.Element {
    return (
        <svg
            width='24'
            height='24'
            viewBox='0 0 24 24'
            fill='currentColor'
            xmlns='http://www.w3.org/2000/svg'
            className='GanttIcon Icon'
        >
            <g opacity='0.8'>
                <path
                    d='M3 5h10v3H3V5zm5 5h11v3H8v-3zm-3 5h9v3H5v-3z'
                    fill='currentColor'
                />
            </g>
        </svg>
    )
}
