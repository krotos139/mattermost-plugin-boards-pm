// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl'
import {DateUtils} from 'react-day-picker'

import {Options} from '../../components/calculations/options'
import {IPropertyTemplate} from '../../blocks/board'
import {Card} from '../../blocks/card'
import {Utils} from '../../utils'

import {PropertyTypeEnum, DatePropertyType} from '../types'

import DateComponent, {createDatePropertyFromString} from './date'

const timeZoneOffset = (date: number): number => {
    return new Date(date).getTimezoneOffset() * 60 * 1000
}

export default class DateProperty extends DatePropertyType {
    Editor = DateComponent
    name = 'Date'
    type = 'date' as PropertyTypeEnum
    displayName = (intl: IntlShape) => intl.formatMessage({id: 'PropertyType.Date', defaultMessage: 'Date'})
    calculationOptions = [Options.none, Options.count, Options.countEmpty,
        Options.countNotEmpty, Options.percentEmpty, Options.percentNotEmpty,
        Options.countValue, Options.countUniqueValue]
    displayValue = (propertyValue: string | string[] | undefined, _1: Card, _2: IPropertyTemplate, intl: IntlShape) => {
        let displayValue = ''
        if (propertyValue && typeof propertyValue === 'string') {
            const singleDate = new Date(parseInt(propertyValue, 10))
            if (singleDate && DateUtils.isDate(singleDate)) {
                displayValue = Utils.displayDate(new Date(parseInt(propertyValue, 10)), intl)
            } else {
                try {
                    const dateValue = JSON.parse(propertyValue as string)
                    // When `includeTime` is set, dateValue.{from,to} are stored
                    // as the actual UTC instants (no offset shift), so reading
                    // them back through `new Date(...)` gives the correct local
                    // wall-clock time. For the legacy date-only path the
                    // values are pre-shifted by tz offset and Utils.displayDate
                    // already prints just the date — no time gets injected.
                    const fmtTime = (ms: number) => {
                        const d = new Date(ms)
                        return d.toLocaleTimeString(intl.locale, {hour: '2-digit', minute: '2-digit'})
                    }
                    if (dateValue.from) {
                        displayValue = Utils.displayDate(new Date(dateValue.from), intl)
                        if (dateValue.includeTime) {
                            displayValue += ' ' + fmtTime(dateValue.from)
                        }
                    }
                    if (dateValue.to) {
                        displayValue += ' -> '
                        displayValue += Utils.displayDate(new Date(dateValue.to), intl)
                        if (dateValue.includeTime) {
                            displayValue += ' ' + fmtTime(dateValue.to)
                        }
                    }
                } catch {
                    // do nothing
                }
            }
        }
        return displayValue
    }

    getDateFrom = (value: string | string[] | undefined) => {
        const dateProperty = createDatePropertyFromString(value as string)
        if (!dateProperty.from) {
            return undefined
        }

        // date properties are stored as 12 pm UTC, convert to 12 am (00) UTC for calendar
        const dateFrom = dateProperty.from ? new Date(dateProperty.from + (dateProperty.includeTime ? 0 : timeZoneOffset(dateProperty.from))) : new Date()
        dateFrom.setHours(0, 0, 0, 0)
        return dateFrom
    }

    getDateTo = (value: string | string[] | undefined) => {
        const dateProperty = createDatePropertyFromString(value as string)
        if (!dateProperty.to) {
            return undefined
        }
        const dateToNumber = dateProperty.to + (dateProperty.includeTime ? 0 : timeZoneOffset(dateProperty.to))
        const dateTo = new Date(dateToNumber)
        dateTo.setHours(0, 0, 0, 0)
        return dateTo
    }
}
