// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl'

import {PropertyType, PropertyTypeEnum, FilterValueType} from '../types'

import Task from './task'

// Stores a single card id; the value rendered to the user (and onChange
// payload from react-select) is resolved from the redux cards store at
// render time inside TaskSelector.
export default class TaskProperty extends PropertyType {
    Editor = Task
    name = 'Task'
    type = 'task' as PropertyTypeEnum
    displayName = (intl: IntlShape) => intl.formatMessage({id: 'PropertyType.Task', defaultMessage: 'Task'})
    canFilter = true
    filterValueType = 'text' as FilterValueType
}
