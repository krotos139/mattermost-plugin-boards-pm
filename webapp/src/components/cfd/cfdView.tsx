// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Cumulative Flow Diagram view — stacked area chart of card counts per
// state (or per assignee, for person properties) over time. The server
// reconstructs daily snapshots from blocks_history; this component just
// hands the matrix to ApexCharts which renders, sizes and provides
// zoom/pan/tooltip on its own. We deliberately delegate all chart-side
// logic (sizing, hover crosshairs, zoom toolbar, axis ticks) to the
// library — a previous d3 + raw-SVG version had to reimplement all of
// that and consistently shipped sizing bugs against flex layouts.

import React, {useEffect, useMemo, useState} from 'react'
import {useIntl} from 'react-intl'
import {useSelector} from 'react-redux'
import type {ApexOptions} from 'apexcharts'

import {Board} from '../../blocks/board'
import {BoardView, CFDDateRange} from '../../blocks/boardView'
import octoClient from '../../octoClient'
import {getBoardUsers} from '../../store/users'
import {IUser} from '../../user'

import ApexChart from './apexChart'
import {CFDResult, CFDSeries} from './cfdTypes'
import {resolveBandColor} from './cfdColors'

import './cfdView.scss'

type Props = {
    board: Board
    activeView: BoardView
    readonly: boolean
}

const DEFAULT_RANGE: CFDDateRange = 'last30'
const DAY_MS = 24 * 60 * 60 * 1000

// Translate the user's CFDDateRange selection into the (from, to) ms-epoch
// pair the API expects. "all" passes from=0 so the server defaults to the
// earliest history row; "custom" reads explicit from/to from the view.
function dateRangeToMillis(range: CFDDateRange, from?: number, to?: number, now: number = Date.now()): {from: number; to: number} {
    const endOfToday = Math.floor(now / DAY_MS) * DAY_MS + (DAY_MS - 1)
    switch (range) {
    case 'last7':
        return {from: endOfToday - 7 * DAY_MS, to: endOfToday}
    case 'last30':
        return {from: endOfToday - 30 * DAY_MS, to: endOfToday}
    case 'last90':
        return {from: endOfToday - 90 * DAY_MS, to: endOfToday}
    case 'last365':
        return {from: endOfToday - 365 * DAY_MS, to: endOfToday}
    case 'all':
        return {from: 0, to: endOfToday}
    case 'custom':
        return {from: from || 0, to: to || endOfToday}
    default:
        return {from: endOfToday - 30 * DAY_MS, to: endOfToday}
    }
}

// Resolve the label rendered in the legend / tooltip for a band. Select
// bands carry a server-side label; person bands carry the user id and we
// resolve to a display name via the redux store; "former member" is the
// stand-in for users who left the team since their card history was
// recorded (the id lives in history but no longer matches a real user).
function bandLabel(seriesEntry: CFDSeries, isPerson: boolean, users: {[id: string]: IUser}): string {
    if (seriesEntry.key === '__none') {
        return seriesEntry.label || 'No value'
    }
    if (!isPerson) {
        return seriesEntry.label
    }
    const u = users[seriesEntry.key]
    if (u) {
        return u.username
    }
    return '(former member)'
}

const CFDView = (props: Props): JSX.Element => {
    const {board, activeView} = props
    const intl = useIntl()
    const users = useSelector(getBoardUsers)

    const propertyId = activeView.fields.cfdPropertyId
    const dateRange = activeView.fields.cfdDateRange || DEFAULT_RANGE

    // Resolve the chosen property template — used to validate the
    // selection and decide whether bands are person-typed (legend then
    // resolves user ids to names instead of using the raw id as label).
    const property = useMemo(() => board.cardProperties?.find((p) => p.id === propertyId), [board.cardProperties, propertyId])
    const isPerson = property?.type === 'person' || property?.type === 'multiPerson' || property?.type === 'personNotify' || property?.type === 'multiPersonNotify'

    const [data, setData] = useState<CFDResult | undefined>(undefined)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!propertyId) {
            setData(undefined)
            return
        }
        let cancelled = false
        setLoading(true)
        const {from, to} = dateRangeToMillis(dateRange, activeView.fields.cfdDateFrom, activeView.fields.cfdDateTo)
        octoClient.getCFD(board.id, propertyId, from, to).then((r) => {
            if (!cancelled) {
                setData(r)
                setLoading(false)
            }
        }).catch(() => {
            if (!cancelled) {
                setLoading(false)
            }
        })
        return () => {
            cancelled = true
        }
    }, [board.id, propertyId, dateRange, activeView.fields.cfdDateFrom, activeView.fields.cfdDateTo])

    // Build the series bundle for ApexCharts. Stacked-area chart of
    // actual historical counts — no trend lines, no projection. Area
    // beats bars on perf because the entire timeline of one band is a
    // single SVG <path>; bars would emit one <rect> per day per band
    // (~1800 nodes at 365d × 5 bands), and ApexCharts has to update
    // every one of them on each pan/zoom step. Areas keep node count
    // constant at N paths regardless of date range, so 365d works
    // smoothly even on mobile.
    //
    // Bands listed in `cfdHiddenSeriesKeys` are filtered out before
    // rendering; this is the user's explicit "hide these states" setting
    // (most often: hide Done so the chart focuses on active work).
    const chart = useMemo(() => {
        if (!data || data.dates.length === 0) {
            return undefined
        }
        const hiddenSet = new Set(activeView.fields.cfdHiddenSeriesKeys || [])
        const visibleIdx: number[] = []
        data.series.forEach((s, i) => {
            if (!hiddenSet.has(s.key)) {
                visibleIdx.push(i)
            }
        })

        // Pad the x-axis ~30% beyond the data span on each side so the
        // user can drag the chart left/right past the data into empty
        // "past" / "future" gutters. Floor at one week so a single-day
        // chart still pans usefully.
        //
        // Why null boundary points instead of just xaxis.min/max:
        // apex's pan/zoom bounds are derived from the actual data x
        // range (gl.minX/gl.maxX from seriesX), not from xaxis.min/max
        // — those only set the initial viewport. Once the user grabs
        // the chart with the mouse, apex clamps to the data extent and
        // the padding disappears. Inserting [paddedMin, null] /
        // [paddedMax, null] datapoints widens the data extent itself,
        // and area/line charts treat null y as a gap (no fill, no
        // line) so the gutter renders empty as desired.
        const first = data.dates[0]
        const last = data.dates[data.dates.length - 1]
        const span = Math.max(last - first, DAY_MS)
        const pad = Math.max(span * 0.3, 7 * DAY_MS)
        const xMin = first - pad
        const xMax = last + pad

        const series = visibleIdx.map((i) => ({
            name: bandLabel(data.series[i], isPerson, users),
            type: 'area' as const,
            data: [
                [xMin, null] as [number, number | null],
                ...data.dates.map((dt, j) => [dt, data.values[i][j]] as [number, number | null]),
                [xMax, null] as [number, number | null],
            ],
        }))
        const colors = visibleIdx.map((i) => resolveBandColor(data.series[i].key, data.series[i].color))

        return {series, colors, xMin, xMax}
    }, [data, isPerson, users, activeView.fields.cfdHiddenSeriesKeys])

    // ApexCharts options. Plain stacked-area chart. Toolbar exposes
    // drag-to-select-zoom, a pan toggle, +/- buttons and reset; pan is
    // preselected so the user can drag the chart left/right immediately.
    // Animations off entirely — ApexCharts dispatches a chart
    // updateOptions on every accumulated mouse delta during pan, and
    // dynamicAnimation tweens chain on top of each other and read as
    // "ступенчатость".
    const options: ApexOptions = useMemo(() => ({
        chart: {
            type: 'area',
            stacked: true,
            height: '100%',
            background: 'transparent',
            zoom: {
                enabled: true,
                type: 'x',
                // autoScaleYaxis off speeds up pan/zoom redraws — apex
                // doesn't have to recompute the y-axis tick set on
                // every step. The y-axis stays fixed to the full-data
                // max which is what users want for CFD anyway.
                autoScaleYaxis: false,
            },
            toolbar: {
                show: true,
                tools: {
                    download: true,
                    selection: true,
                    zoom: true,
                    zoomin: true,
                    zoomout: true,
                    pan: true,
                    reset: true,
                },
                autoSelected: 'pan',
            },
            animations: {
                enabled: false,
            },
            fontFamily: 'inherit',
        },
        colors: chart?.colors || [],
        dataLabels: {enabled: false},
        // straight curve makes day-to-day transitions sharp (so the
        // user can read "the count jumped here"); the default smooth
        // curve hides exact data points behind splines and softens the
        // moments of state change.
        stroke: {
            curve: 'straight',
            width: 1,
        },
        fill: {
            type: 'solid',
            opacity: 0.85,
        },
        xaxis: {
            type: 'datetime',
            min: chart?.xMin,
            max: chart?.xMax,
            labels: {
                datetimeUTC: false,
                style: {
                    fontSize: '11px',
                },
            },
            axisBorder: {show: true},
            axisTicks: {show: true},
            // Thin vertical line follows the cursor — for area charts
            // there's no "bar width" anchor, so a 1px stroke is the
            // classic CFD hover indicator.
            crosshairs: {
                width: 1,
                stroke: {
                    color: 'rgba(var(--center-channel-color-rgb), 0.4)',
                    width: 1,
                    dashArray: 4,
                },
            },
        },
        yaxis: {
            labels: {
                formatter: (val: number) => Math.round(val).toString(),
                style: {
                    fontSize: '11px',
                },
            },
            min: 0,
            forceNiceScale: true,
        },
        legend: {
            position: 'bottom',
            horizontalAlign: 'left',
            fontSize: '12px',
        },
        tooltip: {
            // Shared tooltip — hovering anywhere over a day shows the
            // counts in every visible state for that day, plus the
            // total. Bands are listed in stacking order (bottom-to-top
            // visually = first-to-last in series) so the column matches
            // the chart.
            shared: true,
            custom: ({dataPointIndex, w}: any) => {
                if (dataPointIndex < 0) {
                    return ''
                }
                const x = w.globals.seriesX?.[0]?.[dataPointIndex]
                if (!x) {
                    return ''
                }
                const dateLabel = new Date(x).toLocaleDateString(undefined, {day: '2-digit', month: 'short', year: 'numeric'})
                const colors: string[] = w.globals.colors
                const seriesNames: string[] = w.globals.seriesNames
                const seriesData: Array<Array<number | null>> = w.globals.series

                let total = 0
                const rows: string[] = []
                // Render top-to-bottom in visual order (last series sits
                // on top of the stack), so the tooltip column reads the
                // same direction as the chart from top to bottom.
                for (let i = seriesData.length - 1; i >= 0; i--) {
                    const v = seriesData[i]?.[dataPointIndex]
                    if (v == null) {
                        continue
                    }
                    total += v
                    rows.push(`<div class="CFDTooltip__row"><span class="CFDTooltip__swatch" style="background:${colors[i]}"></span>${seriesNames[i]}<span class="CFDTooltip__count">${Math.round(v)}</span></div>`)
                }
                if (rows.length === 0) {
                    return ''
                }
                return `<div class="CFDTooltip"><div class="CFDTooltip__date">${dateLabel}</div>${rows.join('')}<div class="CFDTooltip__row CFDTooltip__total"><span class="CFDTooltip__swatch CFDTooltip__swatch--empty"></span>Total<span class="CFDTooltip__count">${Math.round(total)}</span></div></div>`
            },
        },
        // No "now" annotation — earlier versions drew a vertical line at
        // `Date.now()` to mark the present, but server data is bucketed
        // by UTC-day and the live `Date.now()` doesn't sit on a bucket
        // boundary. For users east/west of UTC the line ended up
        // visually offset from where the last bar/area actually
        // rendered, which the user read as "today's data is missing".
        // The X-axis labels carry enough date context on their own.
        annotations: {},
        grid: {
            borderColor: 'rgba(0, 0, 0, 0.08)',
            strokeDashArray: 2,
        },
    }), [chart, intl])

    // ---- Empty / not-configured states ----
    if (!propertyId || !property) {
        return (
            <div className='CFDContainer'>
                <div className='CFDContainer__empty'>
                    {intl.formatMessage({
                        id: 'CFDView.no-property',
                        defaultMessage: 'Pick a property in the "Group by" menu — choose a Select / Multi select or Person property to build the cumulative flow chart.',
                    })}
                </div>
            </div>
        )
    }
    const supported = ['select', 'multiSelect', 'person', 'multiPerson', 'personNotify', 'multiPersonNotify']
    if (!supported.includes(property.type)) {
        return (
            <div className='CFDContainer'>
                <div className='CFDContainer__empty'>
                    {intl.formatMessage({
                        id: 'CFDView.unsupported-type',
                        defaultMessage: 'CFD only supports Select, Multi select, Person and Multi person properties.',
                    })}
                </div>
            </div>
        )
    }
    if (loading || !data || !chart) {
        return (
            <div className='CFDContainer'>
                <div className='CFDContainer__empty'>
                    {intl.formatMessage({id: 'CFDView.loading', defaultMessage: 'Loading…'})}
                </div>
            </div>
        )
    }
    if (data.series.length === 0) {
        return (
            <div className='CFDContainer'>
                <div className='CFDContainer__empty'>
                    {intl.formatMessage({
                        id: 'CFDView.no-data',
                        defaultMessage: 'No history yet for this property — once cards start changing state, the chart fills in.',
                    })}
                </div>
            </div>
        )
    }
    if (chart.series.length === 0) {
        return (
            <div className='CFDContainer'>
                <div className='CFDContainer__empty'>
                    {intl.formatMessage({
                        id: 'CFDView.all-hidden',
                        defaultMessage: 'All states are hidden — open the States menu to show some.',
                    })}
                </div>
            </div>
        )
    }

    return (
        <div className='CFDContainer'>
            <div className='CFDContainer__chart'>
                <ApexChart
                    options={options}
                    series={chart.series}
                    type='area'
                    height='100%'
                    width='100%'
                />
            </div>
        </div>
    )
}

export default React.memo(CFDView)
