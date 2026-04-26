// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import {PropertyProps} from '../types'
import ConfirmTask from './confirmTask'

const Task = (props: PropertyProps): JSX.Element => (
    <ConfirmTask
        {...props}
        showEmptyPlaceholder={true}
    />
)

export default Task
