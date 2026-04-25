// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl'

import {PropertyType, PropertyTypeEnum, FilterValueType} from '../types'

import MultiPerson from '../multiperson/multiperson'

export default class MultiPersonNotifyProperty extends PropertyType {
    Editor = MultiPerson
    name = 'MultiPersonNotify'
    type = 'multiPersonNotify' as PropertyTypeEnum
    displayName = (intl: IntlShape) => intl.formatMessage({id: 'PropertyType.MultiPersonNotify', defaultMessage: 'Multi person (notify)'})
    canFilter = true
    filterValueType = 'person' as FilterValueType
}
