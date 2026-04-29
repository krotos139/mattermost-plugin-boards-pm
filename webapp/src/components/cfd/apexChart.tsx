// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Thin React wrapper around the MIT-licensed `apexcharts` core. We
// deliberately do NOT depend on `react-apexcharts` — that package
// recently switched to a dual Community/OEM license that's incompatible
// with redistributing the plugin to organizations over $2M revenue and
// with users running custom-configured interactive charts. The core
// `apexcharts` library remains MIT, so we wrap it ourselves in ~30
// lines of effect-driven lifecycle and keep the whole plugin MIT-clean.

import React, {useEffect, useRef} from 'react'
import ApexCharts from 'apexcharts'
import type {ApexOptions} from 'apexcharts'

type Props = {
    options: ApexOptions
    series: ApexAxisChartSeries | ApexNonAxisChartSeries
    type?: 'area' | 'line' | 'bar' | 'pie' | 'radar' | 'scatter' | 'donut' | 'heatmap' | 'radialBar' | 'rangeBar' | 'rangeArea' | 'treemap' | 'boxPlot' | 'candlestick' | 'polarArea'
    height?: string | number
    width?: string | number
    className?: string
}

const ApexChart = ({options, series, type = 'area', height = '100%', width = '100%', className}: Props): JSX.Element => {
    const containerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<ApexCharts | null>(null)

    // First mount: instantiate the chart. We pass options + series + the
    // chart-level type/height/width via merged options so the library
    // sees one coherent config rather than the React-style prop split.
    useEffect(() => {
        if (!containerRef.current) {
            return undefined
        }
        const merged: ApexOptions = {
            ...options,
            series,
            chart: {
                ...(options.chart || {}),
                type,
                height,
                width,
            },
        }
        const chart = new ApexCharts(containerRef.current, merged)
        chartRef.current = chart
        chart.render()
        return () => {
            chart.destroy()
            chartRef.current = null
        }
        // We deliberately re-init only on type change. Options/series
        // updates flow through the dedicated effects below — calling
        // updateOptions / updateSeries is far cheaper than a full
        // teardown + render and preserves user pan/zoom state. The
        // exhaustive-deps lint rule is unavailable in this project's
        // eslint config (see apexChart.tsx peer files), so we can't
        // disable it inline; the missing-dep is intentional.
    }, [type])

    // Push live option / series changes into the existing chart instance.
    // ApexCharts' updateOptions accepts a partial config and merges
    // intelligently, so we can safely hand it the full options object on
    // every render — internal diffing keeps the cost low.
    useEffect(() => {
        if (chartRef.current) {
            chartRef.current.updateOptions(options, false, false, true)
        }
    }, [options])

    useEffect(() => {
        if (chartRef.current) {
            chartRef.current.updateSeries(series, false)
        }
    }, [series])

    return (
        <div
            className={className}
            ref={containerRef}
        />
    )
}

export default ApexChart
