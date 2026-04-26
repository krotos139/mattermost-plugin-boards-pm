// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl'

import {PropertyType, PropertyTypeEnum, FilterValueType} from '../types'

import MultiTask from './multitask'

export default class MultiTaskProperty extends PropertyType {
    Editor = MultiTask
    name = 'MultiTask'
    type = 'multiTask' as PropertyTypeEnum
    displayName = (intl: IntlShape) => intl.formatMessage({id: 'PropertyType.MultiTask', defaultMessage: 'Multi task'})
    canFilter = true
    filterValueType = 'text' as FilterValueType
}
