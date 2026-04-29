// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Shared minimap for the Timeline (Gantt) and Resource views. Renders a
// scaled-down silhouette of the chart's bars plus a viewport rectangle
// reflecting the current scroll position; click or drag inside the
// minimap to pan the chart.
//
// Design: bar positions are read straight from the rendered SVG (the
// `.bar-wrapper` / `.bar` elements frappe-gantt produces) rather than
// recomputed from card dates. That avoids duplicating frappe's date
// math and keeps the minimap visually identical to whatever the user
// sees in the chart, including conflict / progress overlays.
//
// Re-poll triggers:
//   - `version` prop bump (parent recomputed bars / structure)
//   - ResizeObserver on the chart's scroll container
//   - native `scroll` event for the viewport rect (cheap path)

import React, {RefObject, useCallback, useEffect, useRef, useState} from 'react'

import './ganttMiniMap.scss'

const MINIMAP_WIDTH = 220
const MINIMAP_HEIGHT = 100

type Bar = {
    x: number
    y: number
    w: number
    h: number
    color: string
}

type Dims = {
    totalWidth: number
    totalHeight: number
    viewWidth: number
    viewHeight: number
    scrollLeft: number
    scrollTop: number
}

type Props = {
    // Pass the chart wrapper (the div whose child is `.gantt-container`).
    // The minimap walks down to the inner scrollable container to read
    // bar positions and to drive scrollLeft / scrollTop.
    containerRef: RefObject<HTMLDivElement>

    // Bumps whenever the parent rebuilds the chart so the minimap re-polls
    // bar positions. Pass any value that changes on rebuild — e.g. the
    // structural signature both gantt + resource views maintain.
    version: number | string
}

const findScrollerFor = (wrapper: HTMLDivElement | null): HTMLElement | null => {
    if (!wrapper) {
        return null
    }
    return wrapper.querySelector('.gantt-container') as HTMLElement | null
}

export default function GanttMiniMap({containerRef, version}: Props) {
    const [bars, setBars] = useState<Bar[]>([])
    const [dims, setDims] = useState<Dims>({
        totalWidth: 0,
        totalHeight: 0,
        viewWidth: 0,
        viewHeight: 0,
        scrollLeft: 0,
        scrollTop: 0,
    })

    const refreshAll = useCallback(() => {
        const scroller = findScrollerFor(containerRef.current)
        if (!scroller) {
            return
        }
        const list: Bar[] = []
        scroller.querySelectorAll('.bar-wrapper').forEach((bw) => {
            const rect = bw.querySelector('rect.bar') as SVGRectElement | null
            if (!rect) {
                return
            }
            const x = parseFloat(rect.getAttribute('x') || '0')
            const y = parseFloat(rect.getAttribute('y') || '0')
            const w = parseFloat(rect.getAttribute('width') || '0')
            const h = parseFloat(rect.getAttribute('height') || '0')
            // Computed fill captures CSS rules (bar tint by select option),
            // not just the inline `fill` attribute frappe sets to '#a3a3ff'.
            const color = (window.getComputedStyle(rect).fill || '#a3a3ff').trim()
            list.push({x, y, w, h, color})
        })
        setBars(list)
        setDims({
            totalWidth: scroller.scrollWidth,
            totalHeight: scroller.scrollHeight,
            viewWidth: scroller.clientWidth,
            viewHeight: scroller.clientHeight,
            scrollLeft: scroller.scrollLeft,
            scrollTop: scroller.scrollTop,
        })
    }, [containerRef])

    // Wire up bar polling, scroll listener, and resize observer. The
    // scroller (`.gantt-container`) is created by frappe-gantt *after*
    // React's effect phase on first mount, so we can't rely on it being
    // present synchronously — poll briefly until it appears, then attach
    // listeners. Re-runs on `version` bumps so a parent rebuild that
    // re-creates the scroller gets fresh listeners.
    useEffect(() => {
        let scroller: HTMLElement | null = null
        let onScroll: (() => void) | null = null
        let ro: ResizeObserver | null = null
        let attempts = 0
        let retryTimer: number | undefined
        let initialRefreshTimer: number | undefined

        const attach = () => {
            scroller = findScrollerFor(containerRef.current)
            if (!scroller) {
                if (attempts++ < 30) {
                    retryTimer = window.setTimeout(attach, 50)
                }
                return
            }
            const target = scroller
            onScroll = () => {
                setDims((d) => ({
                    ...d,
                    scrollLeft: target.scrollLeft,
                    scrollTop: target.scrollTop,
                }))
            }
            scroller.addEventListener('scroll', onScroll, {passive: true})
            ro = new ResizeObserver(() => refreshAll())
            ro.observe(scroller)
            // Read bars / dims once now that the scroller is attached.
            // Wait one tick so frappe-gantt has flushed its DOM after
            // `gantt.refresh` / `new Gantt()`.
            initialRefreshTimer = window.setTimeout(refreshAll, 50)
        }

        attach()

        return () => {
            if (retryTimer !== undefined) {
                clearTimeout(retryTimer)
            }
            if (initialRefreshTimer !== undefined) {
                clearTimeout(initialRefreshTimer)
            }
            if (scroller && onScroll) {
                scroller.removeEventListener('scroll', onScroll)
            }
            if (ro) {
                ro.disconnect()
            }
        }
    }, [containerRef, refreshAll, version])

    // Drag-to-pan. pointerdown on the minimap captures the gesture; we
    // listen on `window` for move/up so the user can drag past the
    // minimap edges without losing track of the cursor.
    const draggingRef = useRef(false)
    const minimapRef = useRef<SVGSVGElement | null>(null)

    const panTo = useCallback((clientX: number, clientY: number) => {
        const minimap = minimapRef.current
        const scroller = findScrollerFor(containerRef.current)
        if (!minimap || !scroller) {
            return
        }
        const rect = minimap.getBoundingClientRect()
        const sx = (clientX - rect.left) / rect.width
        const sy = (clientY - rect.top) / rect.height
        // Center the viewport on the click point so the user's intent
        // ("show me what's around here") matches the result.
        const targetLeft = (sx * scroller.scrollWidth) - (scroller.clientWidth / 2)
        const targetTop = (sy * scroller.scrollHeight) - (scroller.clientHeight / 2)
        scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, targetLeft))
        scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, targetTop))
    }, [containerRef])

    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            if (!draggingRef.current) {
                return
            }
            panTo(e.clientX, e.clientY)
        }
        const onUp = () => {
            draggingRef.current = false
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
        }
    }, [panTo])

    if (dims.totalWidth === 0 || dims.totalHeight === 0) {
        return null
    }
    if (dims.viewWidth >= dims.totalWidth && dims.viewHeight >= dims.totalHeight) {
        // Nothing to navigate — the chart fits entirely in the viewport.
        return null
    }

    const scaleX = MINIMAP_WIDTH / dims.totalWidth
    const scaleY = MINIMAP_HEIGHT / dims.totalHeight

    return (
        <svg
            ref={minimapRef}
            className='GanttMiniMap'
            width={MINIMAP_WIDTH}
            height={MINIMAP_HEIGHT}
            onPointerDown={(e) => {
                draggingRef.current = true
                panTo(e.clientX, e.clientY)
                e.preventDefault()
            }}
        >
            <rect
                className='GanttMiniMap__bg'
                x={0}
                y={0}
                width={MINIMAP_WIDTH}
                height={MINIMAP_HEIGHT}
            />
            {bars.map((b, i) => (
                <rect
                    key={i}
                    x={b.x * scaleX}
                    y={b.y * scaleY}
                    width={Math.max(2, b.w * scaleX)}
                    height={Math.max(1, b.h * scaleY)}
                    fill={b.color}
                    opacity={0.85}
                />
            ))}
            <rect
                className='GanttMiniMap__viewport'
                x={dims.scrollLeft * scaleX}
                y={dims.scrollTop * scaleY}
                width={Math.min(MINIMAP_WIDTH, dims.viewWidth * scaleX)}
                height={Math.min(MINIMAP_HEIGHT, dims.viewHeight * scaleY)}
            />
        </svg>
    )
}
