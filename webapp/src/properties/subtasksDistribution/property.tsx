// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl'

import {PropertyType, PropertyTypeEnum} from '../types'

import SubtasksDistribution from './subtasksDistribution'

// SubtasksDistribution is a virtual property whose value is computed from
// the card's `subtask` content blocks. The Editor component reads the
// blocks straight from the contents store; this property contributes only
// the registration / display name / read-only flag.
export default class SubtasksDistributionProperty extends PropertyType {
    Editor = SubtasksDistribution
    name = 'Subtasks distribution'
    type = 'subtasksDistribution' as PropertyTypeEnum
    isReadOnly = true
    displayName = (intl: IntlShape) => intl.formatMessage({id: 'PropertyType.SubtasksDistribution', defaultMessage: 'Subtasks distribution'})
    displayValue = () => ''
    exportValue = () => ''
}
