// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl'

import {PropertyType, PropertyTypeEnum, FilterValueType} from '../types'

import Person from '../person/person'

export default class PersonNotifyProperty extends PropertyType {
    Editor = Person
    name = 'PersonNotify'
    type = 'personNotify' as PropertyTypeEnum
    displayName = (intl: IntlShape) => intl.formatMessage({id: 'PropertyType.PersonNotify', defaultMessage: 'Person (notify)'})
    canFilter = true
    filterValueType = 'person' as FilterValueType
    canGroup = true
}
