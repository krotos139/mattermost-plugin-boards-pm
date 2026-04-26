// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'

import {PropertyProps} from '../types'
import ConfirmTask from '../task/confirmTask'

const MultiTask = (props: PropertyProps): JSX.Element => (
    <ConfirmTask
        {...props}
        showEmptyPlaceholder={true}
    />
)

export default MultiTask
