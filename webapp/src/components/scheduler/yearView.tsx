// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Year view for the Scheduler — 12 mini-month grids in a responsive layout.
// Days with at least one event are tinted using the resolved event color
// from the configured Color-by property; clicking a day jumps the parent
// SchedulerView back to Calendar mode positioned on that day.
//
// We render this ourselves rather than as a Schedule-X custom view because
// (a) Schedule-X v3.7's `createPreactView` requires a Preact component,
// which would force a JSX-pragma split inside the same file tree and
// preclude reuse of React-based Boards components if we ever want to
// embed property cells; (b) the year view's interaction model (click a
// day to navigate) is fundamentally different from Schedule-X's drag/
// resize-driven views — keeping it outside their pipeline avoids fighting
// the library for unusual gestures.

import React, {useMemo} from 'react'
import {useIntl} from 'react-intl'

import './yearView.scss'

export type YearEvent = {
    cardId: string
    start: Date  // local-midnight on the start day (or wall-clock for time events)
    end: Date    // ditto, last day inclusive
    colorMain?: string  // CSS color for the per-day tint dot — falls back to neutral
}

type Props = {
    year: number
    events: YearEvent[]
    onYearChange: (year: number) => void
    onDayClick: (date: Date) => void
}

// Local copy of the focalboard week-start convention. Boards doesn't
// expose firstDayOfWeek through a single shared constant — keep this in
// sync with the rest of the calendar surface (Calendar view defaults to
// Mon-Sun in most locales). Index 0 = Monday … 6 = Sunday.
const FIRST_DAY_OF_WEEK_MONDAY = 1

function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

// Number of millis between two dates, ignoring time-of-day. Used to walk
// from start to end of an event when binning events into per-day buckets.
const ONE_DAY_MS = 86_400_000

const YearView = (props: Props): JSX.Element => {
    const {year, events, onYearChange, onDayClick} = props
    const intl = useIntl()

    // Pre-bin events into a `YYYY-MM-DD` → array map so each day-cell
    // render becomes an O(1) lookup. Multi-day events are expanded into
    // every day they cover — bounded by ONE_DAY_MS steps so a hypothetical
    // year-long event doesn't fan out forever.
    const eventsByDay = useMemo(() => {
        const map = new Map<string, YearEvent[]>()
        for (const ev of events) {
            const start = startOfDay(ev.start)
            const end = startOfDay(ev.end)
            for (let t = start.getTime(); t <= end.getTime(); t += ONE_DAY_MS) {
                const d = new Date(t)
                if (d.getFullYear() !== year) {
                    continue
                }
                const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
                const arr = map.get(key)
                if (arr) {
                    arr.push(ev)
                } else {
                    map.set(key, [ev])
                }
            }
        }
        return map
    }, [events, year])

    const today = startOfDay(new Date())

    // Localized month names. Use 'long' so the headers read "January",
    // "Февраль", etc. in the user's chosen Boards locale.
    const monthFmt = useMemo(
        () => new Intl.DateTimeFormat(intl.locale, {month: 'long'}),
        [intl.locale],
    )
    const weekdayFmt = useMemo(
        () => new Intl.DateTimeFormat(intl.locale, {weekday: 'narrow'}),
        [intl.locale],
    )

    // Weekday labels in Mon..Sun order. Use a known Monday (2024-01-01)
    // as the seed — the formatter ignores the year/month, just the
    // day-of-week, so this is locale-stable.
    const weekdayLabels = useMemo(() => {
        const seed = new Date(2024, 0, 1) // Mon 2024-01-01
        const out: string[] = []
        for (let i = 0; i < 7; i++) {
            const d = new Date(seed.getTime() + i * ONE_DAY_MS)
            out.push(weekdayFmt.format(d))
        }
        return out
    }, [weekdayFmt])

    return (
        <div className='YearView'>
            <div className='YearView__header'>
                <button
                    type='button'
                    className='YearView__nav'
                    onClick={() => onYearChange(year - 1)}
                    aria-label={intl.formatMessage({id: 'YearView.prev', defaultMessage: 'Previous year'})}
                >
                    {'‹'}
                </button>
                <div className='YearView__title'>{year}</div>
                <button
                    type='button'
                    className='YearView__nav'
                    onClick={() => onYearChange(year + 1)}
                    aria-label={intl.formatMessage({id: 'YearView.next', defaultMessage: 'Next year'})}
                >
                    {'›'}
                </button>
            </div>
            <div className='YearView__months'>
                {Array.from({length: 12}, (_, monthIdx) => (
                    <YearMonth
                        key={monthIdx}
                        year={year}
                        month={monthIdx}
                        monthName={monthFmt.format(new Date(year, monthIdx, 1))}
                        weekdayLabels={weekdayLabels}
                        eventsByDay={eventsByDay}
                        today={today}
                        onDayClick={onDayClick}
                    />
                ))}
            </div>
        </div>
    )
}

type YearMonthProps = {
    year: number
    month: number  // 0..11
    monthName: string
    weekdayLabels: string[]
    eventsByDay: Map<string, YearEvent[]>
    today: Date
    onDayClick: (date: Date) => void
}

const YearMonth = (props: YearMonthProps): JSX.Element => {
    const {year, month, monthName, weekdayLabels, eventsByDay, today, onDayClick} = props

    // Compute the leading offset (how many empty cells before the first
    // day of the month) given a Monday-first week. JS getDay() returns
    // 0=Sun..6=Sat — shift to 0=Mon..6=Sun then take the offset directly.
    const firstOfMonth = new Date(year, month, 1)
    const jsDow = firstOfMonth.getDay()
    const monStartDow = (jsDow + 6) % 7 // Sun=0 → 6, Mon=1 → 0, etc.
    const daysInMonth = new Date(year, month + 1, 0).getDate()

    const cells: Array<{day: number, date: Date} | null> = []
    for (let i = 0; i < monStartDow; i++) {
        cells.push(null)
    }
    for (let d = 1; d <= daysInMonth; d++) {
        cells.push({day: d, date: new Date(year, month, d)})
    }
    // Pad to a multiple of 7 so the grid renders rectangular.
    while (cells.length % 7 !== 0) {
        cells.push(null)
    }

    return (
        <div className='YearView__month'>
            <div className='YearView__monthName'>{monthName}</div>
            <div className='YearView__weekdays'>
                {weekdayLabels.map((label, idx) => (
                    <div
                        key={idx}
                        className='YearView__weekday'
                    >
                        {label}
                    </div>
                ))}
            </div>
            <div className='YearView__days'>
                {cells.map((cell, idx) => {
                    if (!cell) {
                        return (
                            <div
                                key={idx}
                                className='YearView__day YearView__day--empty'
                            />
                        )
                    }
                    const key = `${year}-${month}-${cell.day}`
                    const dayEvents = eventsByDay.get(key)
                    const hasEvents = !!dayEvents && dayEvents.length > 0
                    const isToday = cell.date.getTime() === today.getTime()

                    // Distinct dot per unique color present that day, so a
                    // user with three different option colors landing on
                    // the same date sees three dots — same affordance as
                    // schedule-x's mobile MonthAgenda dots. Cap at 4 to
                    // keep the row narrower than the cell on small mini-
                    // month tiles. Insertion order is preserved so the
                    // first-seen event color anchors the leftmost dot.
                    const uniqueColors: string[] = []
                    if (hasEvents) {
                        const seen = new Set<string>()
                        for (const ev of dayEvents!) {
                            const c = ev.colorMain || 'rgb(var(--button-bg-rgb))'
                            if (!seen.has(c)) {
                                seen.add(c)
                                uniqueColors.push(c)
                                if (uniqueColors.length >= 4) {
                                    break
                                }
                            }
                        }
                    }

                    const classes = ['YearView__day']
                    if (hasEvents) {
                        classes.push('YearView__day--hasEvents')
                    }
                    if (isToday) {
                        classes.push('YearView__day--today')
                    }
                    return (
                        <button
                            key={idx}
                            type='button'
                            className={classes.join(' ')}
                            onClick={() => onDayClick(cell.date)}
                            title={hasEvents ? `${dayEvents!.length} event${dayEvents!.length === 1 ? '' : 's'}` : undefined}
                        >
                            <span className='YearView__dayNumber'>{cell.day}</span>
                            {uniqueColors.length > 0 && (
                                <span className='YearView__dots'>
                                    {uniqueColors.map((c, di) => (
                                        <span
                                            key={di}
                                            className='YearView__dot'
                                            style={{backgroundColor: c}}
                                        />
                                    ))}
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

export default React.memo(YearView)
