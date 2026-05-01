// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useMemo, useState, useCallback, useEffect} from 'react'
import {useIntl} from 'react-intl'
import {DateUtils} from 'react-day-picker'
import MomentLocaleUtils from 'react-day-picker/moment'
import DayPicker from 'react-day-picker/DayPicker'

import moment from 'moment'

import mutator from '../../mutator'

import Editable from '../../widgets/editable'
import SwitchOption from '../../widgets/menu/switchOption'
import Button from '../../widgets/buttons/button'

import Modal from '../../components/modal'
import ModalWrapper from '../../components/modalWrapper'
import {Utils} from '../../utils'

import 'react-day-picker/lib/style.css'
import './date.scss'

import {PropertyProps} from '../types'

export type DateProperty = {
    from?: number
    to?: number
    includeTime?: boolean
    timeZone?: string
}

export function createDatePropertyFromString(initialValue: string): DateProperty {
    let dateProperty: DateProperty = {}
    if (initialValue) {
        const singleDate = new Date(Number(initialValue))
        if (singleDate && DateUtils.isDate(singleDate)) {
            dateProperty.from = singleDate.getTime()
        } else {
            try {
                dateProperty = JSON.parse(initialValue)
            } catch {
                //Don't do anything, return empty dateProperty
            }
        }
    }
    return dateProperty
}

function datePropertyToString(dateProperty: DateProperty): string {
    return dateProperty.from || dateProperty.to ? JSON.stringify(dateProperty) : ''
}

const loadedLocales: Record<string, moment.Locale> = {}

function DateRange(props: PropertyProps): JSX.Element {
    const {propertyValue, propertyTemplate, showEmptyPlaceholder, readOnly, board, card} = props
    const [value, setValue] = useState(propertyValue)
    const intl = useIntl()

    useEffect(() => {
        if (value !== propertyValue) {
            setValue(propertyValue)
        }
    }, [propertyValue, setValue])

    const onChange = useCallback((newValue) => {
        if (value !== newValue) {
            setValue(newValue)
        }
    }, [value, board.id, card, propertyTemplate.id])

    const getDisplayDate = (date: Date | null | undefined) => {
        let displayDate = ''
        if (date) {
            displayDate = Utils.displayDate(date, intl)
        }
        return displayDate
    }

    const timeZoneOffset = (date: number): number => {
        return new Date(date).getTimezoneOffset() * 60 * 1000
    }

    // HH:MM (24h) — value the native <input type="time"> wants. We deliberately
    // bypass moment/locale formatting here so the input element parses what we
    // hand it back without round-tripping through user locale (the picker UI
    // itself still localizes 12/24h based on browser settings).
    const padTwo = (n: number) => (n < 10 ? `0${n}` : `${n}`)
    const toTimeInputValue = (d: Date) => `${padTwo(d.getHours())}:${padTwo(d.getMinutes())}`

    // Build a JS Date that pins the calendar day to `day` and the wall-clock
    // time to (hours, minutes) — used everywhere we have to compose a date
    // value out of separate sources (day-picker click + a time input, or a
    // day-picker click in time-on mode where we want to keep the existing
    // time-of-day instead of resetting to noon).
    const combineDayAndTime = (day: Date, hours: number, minutes: number): Date => {
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0)
    }

    const dateProperty = useMemo(() => createDatePropertyFromString(value as string), [value])
    const [showDialog, setShowDialog] = useState(false)

    // Keep dateProperty as UTC,
    // dateFrom / dateTo will need converted to local time, to ensure date stays consistent
    // dateFrom / dateTo will be used for input and calendar dates
    const dateFrom = dateProperty.from ? new Date(dateProperty.from + (dateProperty.includeTime ? 0 : timeZoneOffset(dateProperty.from))) : undefined
    const dateTo = dateProperty.to ? new Date(dateProperty.to + (dateProperty.includeTime ? 0 : timeZoneOffset(dateProperty.to))) : undefined
    const [fromInput, setFromInput] = useState<string>(getDisplayDate(dateFrom))
    const [toInput, setToInput] = useState<string>(getDisplayDate(dateTo))

    const isRange = dateTo !== undefined

    const locale = intl.locale.toLowerCase()
    if (locale && locale !== 'en' && !loadedLocales[locale]) {
        // eslint-disable-next-line global-require
        loadedLocales[locale] = require(`moment/locale/${locale}`)
    }

    const handleDayClick = (day: Date) => {
        const range: DateProperty = {}
        // In time-on mode preserve the existing wall-clock time so picking a
        // different day in the calendar doesn't silently reset the user's
        // 14:30 meeting to noon. Falls back to 09:00 if there's no prior
        // time (the toggle's default), or noon for the legacy date-only path.
        if (dateProperty.includeTime) {
            const fromHrs = dateFrom?.getHours() ?? 9
            const fromMin = dateFrom?.getMinutes() ?? 0
            const dayWithTime = combineDayAndTime(day, fromHrs, fromMin)
            if (isRange) {
                const toHrs = dateTo?.getHours() ?? 17
                const toMin = dateTo?.getMinutes() ?? 0
                // DateUtils.addDayToRange compares by date only, so the time
                // we attach below survives unchanged through the range merge.
                const newRange = DateUtils.addDayToRange(dayWithTime, {from: dateFrom, to: dateTo})
                if (newRange.from) {
                    range.from = combineDayAndTime(newRange.from, fromHrs, fromMin).getTime()
                }
                if (newRange.to) {
                    range.to = combineDayAndTime(newRange.to, toHrs, toMin).getTime()
                }
            } else {
                range.from = dayWithTime.getTime()
                range.to = undefined
            }
        } else {
            day.setHours(12)
            if (isRange) {
                const newRange = DateUtils.addDayToRange(day, {from: dateFrom, to: dateTo})
                range.from = newRange.from?.getTime()
                range.to = newRange.to?.getTime()
            } else {
                range.from = day.getTime()
                range.to = undefined
            }
        }
        saveRangeValue(range)
    }

    const onRangeClick = () => {
        let range: DateProperty = {
            from: dateFrom?.getTime(),
            to: dateFrom?.getTime(),
        }
        if (isRange) {
            range = ({
                from: dateFrom?.getTime(),
                to: undefined,
            })
        }
        saveRangeValue(range)
    }

    const onClear = () => {
        saveRangeValue({})
    }

    const saveRangeValue = (range: DateProperty) => {
        const rangeUTC = {...range}
        // Caller-supplied `includeTime` always wins (e.g. the toggle handler
        // explicitly flips it). Otherwise keep whatever was on the existing
        // value — without this every saveRangeValue call from the day-picker
        // /text-input handlers would silently strip the flag, because none of
        // them carry it explicitly.
        if (rangeUTC.includeTime === undefined) {
            rangeUTC.includeTime = dateProperty.includeTime
        }
        if (rangeUTC.from) {
            rangeUTC.from -= rangeUTC.includeTime ? 0 : timeZoneOffset(rangeUTC.from)
        }
        if (rangeUTC.to) {
            rangeUTC.to -= rangeUTC.includeTime ? 0 : timeZoneOffset(rangeUTC.to)
        }
        // Don't persist `includeTime: false` — the absence of the field is the
        // legacy default and saves a few bytes per row.
        if (!rangeUTC.includeTime) {
            delete rangeUTC.includeTime
        }

        onChange(datePropertyToString(rangeUTC))
        setFromInput(getDisplayDate(range.from ? new Date(range.from) : undefined))
        setToInput(getDisplayDate(range.to ? new Date(range.to) : undefined))
    }

    const onIncludeTimeClick = () => {
        if (dateProperty.includeTime) {
            // Turn off: collapse the wall-clock time back to noon-local on
            // each side of the range. Noon (not midnight) is the existing
            // convention — it sidesteps DST off-by-ones the day-picker code
            // uses elsewhere. The flag is dropped via saveRangeValue.
            const collapse = (d: Date | undefined) => (d ? combineDayAndTime(d, 12, 0).getTime() : undefined)
            saveRangeValue({from: collapse(dateFrom), to: collapse(dateTo), includeTime: false})
        } else {
            // Turn on: pin the existing day(s) to a sensible default time
            // (09:00 start, 17:00 end) rather than picking up the noon
            // anchor from the date-only mode — a 12:00 default would feel
            // arbitrary in a scheduling context, while 9-to-5 reads as a
            // working block the user can adjust.
            const startAt = dateFrom ? combineDayAndTime(dateFrom, 9, 0).getTime() : undefined
            const endAt = dateTo ? combineDayAndTime(dateTo, 17, 0).getTime() : undefined
            saveRangeValue({from: startAt, to: endAt, includeTime: true})
        }
    }

    // Edit only the wall-clock time of `from` (or `to`), leaving the calendar
    // day alone. Used by the <input type="time"> elements rendered in time-on
    // mode. Bails on malformed input rather than throwing, so a half-typed
    // "12:" value doesn't blow up the editor.
    const setTimeOnFrom = (timeStr: string) => {
        if (!dateFrom) {
            return
        }
        const [hStr, mStr] = timeStr.split(':')
        const h = Number(hStr)
        const m = Number(mStr)
        if (Number.isNaN(h) || Number.isNaN(m)) {
            return
        }
        const newFrom = combineDayAndTime(dateFrom, h, m).getTime()
        saveRangeValue({from: newFrom, to: dateProperty.to, includeTime: true})
    }
    const setTimeOnTo = (timeStr: string) => {
        if (!dateTo) {
            return
        }
        const [hStr, mStr] = timeStr.split(':')
        const h = Number(hStr)
        const m = Number(mStr)
        if (Number.isNaN(h) || Number.isNaN(m)) {
            return
        }
        const newTo = combineDayAndTime(dateTo, h, m).getTime()
        saveRangeValue({from: dateProperty.from, to: newTo, includeTime: true})
    }

    let displayValue = ''
    if (dateFrom) {
        displayValue = getDisplayDate(dateFrom)
    }
    if (dateTo) {
        displayValue += ' → ' + getDisplayDate(dateTo)
    }

    const onClose = () => {
        const newDate = datePropertyToString(dateProperty)
        onChange(newDate)
        mutator.changePropertyValue(board.id, card, propertyTemplate.id, newDate)
        setShowDialog(false)
    }

    let buttonText = displayValue
    if (!buttonText && showEmptyPlaceholder) {
        buttonText = intl.formatMessage({id: 'DateRange.empty', defaultMessage: 'Empty'})
    }

    const className = props.property.valueClassName(readOnly)
    if (readOnly) {
        return <div className={className}>{displayValue}</div>
    }

    return (
        <div className={`DateRange ${displayValue ? '' : 'empty'} ` + className}>
            <Button
                onClick={() => setShowDialog(true)}
            >
                {buttonText}
            </Button>

            {showDialog &&
            <ModalWrapper>
                <Modal
                    onClose={() => onClose()}
                >
                    <div
                        className={className + '-overlayWrapper'}
                    >
                        <div className={className + '-overlay'}>
                            <div className={'inputContainer'}>
                                <Editable
                                    value={fromInput}
                                    placeholderText={moment.localeData(locale).longDateFormat('L')}
                                    onFocus={() => {
                                        if (dateFrom) {
                                            return setFromInput(Utils.inputDate(dateFrom, intl))
                                        }
                                        return undefined
                                    }}
                                    onChange={setFromInput}
                                    onSave={() => {
                                        const newDate = MomentLocaleUtils.parseDate(fromInput, 'L', intl.locale)
                                        if (newDate && DateUtils.isDate(newDate)) {
                                            // Preserve existing time-of-day when in time-on mode so a
                                            // re-typed date doesn't reset the hour back to noon.
                                            if (dateProperty.includeTime) {
                                                const h = dateFrom?.getHours() ?? 9
                                                const m = dateFrom?.getMinutes() ?? 0
                                                newDate.setHours(h, m, 0, 0)
                                            } else {
                                                newDate.setHours(12)
                                            }
                                            const range: DateProperty = {
                                                from: newDate.getTime(),
                                                to: dateTo?.getTime(),
                                            }
                                            saveRangeValue(range)
                                        } else {
                                            setFromInput(getDisplayDate(dateFrom))
                                        }
                                    }}
                                    onCancel={() => {
                                        setFromInput(getDisplayDate(dateFrom))
                                    }}
                                />
                                {dateProperty.includeTime && dateFrom &&
                                    <input
                                        type='time'
                                        className='DateRange__timeInput'
                                        value={toTimeInputValue(dateFrom)}
                                        onChange={(e) => setTimeOnFrom(e.target.value)}
                                    />
                                }
                                {dateTo &&
                                    <Editable
                                        value={toInput}
                                        placeholderText={moment.localeData(locale).longDateFormat('L')}
                                        onFocus={() => {
                                            if (dateTo) {
                                                return setToInput(Utils.inputDate(dateTo, intl))
                                            }
                                            return undefined
                                        }}
                                        onChange={setToInput}
                                        onSave={() => {
                                            const newDate = MomentLocaleUtils.parseDate(toInput, 'L', intl.locale)
                                            if (newDate && DateUtils.isDate(newDate)) {
                                                if (dateProperty.includeTime) {
                                                    const h = dateTo?.getHours() ?? 17
                                                    const m = dateTo?.getMinutes() ?? 0
                                                    newDate.setHours(h, m, 0, 0)
                                                } else {
                                                    newDate.setHours(12)
                                                }
                                                const range: DateProperty = {
                                                    from: dateFrom?.getTime(),
                                                    to: newDate.getTime(),
                                                }
                                                saveRangeValue(range)
                                            } else {
                                                setToInput(getDisplayDate(dateTo))
                                            }
                                        }}
                                        onCancel={() => {
                                            setToInput(getDisplayDate(dateTo))
                                        }}
                                    />
                                }
                                {dateProperty.includeTime && dateTo &&
                                    <input
                                        type='time'
                                        className='DateRange__timeInput'
                                        value={toTimeInputValue(dateTo)}
                                        onChange={(e) => setTimeOnTo(e.target.value)}
                                    />
                                }
                            </div>
                            <DayPicker
                                onDayClick={handleDayClick}
                                initialMonth={dateFrom || new Date()}
                                showOutsideDays={false}
                                locale={locale}
                                localeUtils={MomentLocaleUtils}
                                todayButton={intl.formatMessage({id: 'DateRange.today', defaultMessage: 'Today'})}
                                onTodayButtonClick={handleDayClick}
                                month={dateFrom}
                                selectedDays={[dateFrom, dateTo ? {from: dateFrom, to: dateTo} : {from: dateFrom, to: dateFrom}]}
                                modifiers={dateTo ? {start: dateFrom, end: dateTo} : {start: dateFrom, end: dateFrom}}
                            />
                            <hr/>
                            <SwitchOption
                                key={'EndDateOn'}
                                id={'EndDateOn'}
                                name={intl.formatMessage({id: 'DateRange.endDate', defaultMessage: 'End date'})}
                                isOn={isRange}
                                onClick={onRangeClick}
                            />
                            <SwitchOption
                                key={'IncludeTimeOn'}
                                id={'IncludeTimeOn'}
                                name={intl.formatMessage({id: 'DateRange.includeTime', defaultMessage: 'Include time'})}
                                isOn={!!dateProperty.includeTime}
                                onClick={onIncludeTimeClick}
                            />
                            <hr/>
                            <div
                                className='MenuOption menu-option'
                            >
                                <Button
                                    onClick={onClear}
                                >
                                    {intl.formatMessage({id: 'DateRange.clear', defaultMessage: 'Clear'})}
                                </Button>
                            </div>
                        </div>
                    </div>
                </Modal>
            </ModalWrapper>
            }
        </div>
    )
}

export default DateRange
