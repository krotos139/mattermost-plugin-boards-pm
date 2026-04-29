// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Hierarchy view — a node-graph view that renders cards as boxes connected
// by parent → child edges. The parent relation is defined by a Task or
// Multi task property the user picks via the "Hierarchy by" header menu;
// every value in that property points at the *children* of the current
// card (Subtasks-style modeling).
//
// Layout is delegated to dagre — the user picks the rank direction
// (TB / LR / BT / RL) via the "Layout" header menu, and the node positions
// are recomputed each time the card set or the relation changes.
//
// Per-node tint comes from a separate "Color by" header menu: pick any
// select / multiSelect property and the chosen option's color tints the
// node background. The same `--prop-{color}` CSS variables Timeline uses
// for its bars are reused here so the palette stays consistent across views.
//
// Visible properties picked in the standard "Properties" menu are rendered
// inside each node as readonly `PropertyValueElement`s — same pattern the
// Resource view uses for its side panel cells, so user-configured columns
// are shared across both views.

import React, {useEffect, useMemo, useRef} from 'react'
import {useIntl} from 'react-intl'
import dagre from 'dagre'
import ReactFlow, {
    Background,
    Controls,
    MiniMap,
    Handle,
    Position,
    ReactFlowProvider,
    Node,
    Edge,
    NodeProps,
    useReactFlow,
} from 'reactflow'

import 'reactflow/dist/style.css'

import {Board, IPropertyTemplate} from '../../blocks/board'
import {BoardView, HierarchyLayout} from '../../blocks/boardView'
import {Card} from '../../blocks/card'
import {Constants} from '../../constants'
import PropertyValueElement from '../propertyValueElement'

import './hierarchyView.scss'

// Approximate node dimensions used to seed dagre. The actual rendered
// node may be a touch taller (we add a row per visible property) but
// dagre only needs an estimate to space ranks; reactflow positions the
// real DOM around the dagre coordinates.
const BASE_NODE_WIDTH = 240
const BASE_NODE_HEIGHT = 64
const PROPERTY_ROW_HEIGHT = 22

// Map a propColor* name to the CSS variable used for the live node
// background (HTML element — var() works here, picks up theme overrides).
const COLOR_VAR_BY_NAME: Record<string, string> = {
    propColorDefault: 'var(--prop-default)',
    propColorGray: 'var(--prop-gray)',
    propColorBrown: 'var(--prop-brown)',
    propColorOrange: 'var(--prop-orange)',
    propColorYellow: 'var(--prop-yellow)',
    propColorGreen: 'var(--prop-green)',
    propColorBlue: 'var(--prop-blue)',
    propColorPurple: 'var(--prop-purple)',
    propColorPink: 'var(--prop-pink)',
    propColorRed: 'var(--prop-red)',
}

// Pre-resolved hex equivalents matching focalboard-variables.scss. Used by
// the minimap because reactflow renders nodes as SVG `<rect fill={...}>`
// presentation attributes, which don't resolve `var(--…)` references.
const COLOR_HEX_BY_NAME: Record<string, string> = {
    propColorDefault: '#ffffff',
    propColorGray: '#ededed',
    propColorBrown: '#f7ddc3',
    propColorOrange: '#ffd3c1',
    propColorYellow: '#f7f0b6',
    propColorGreen: '#c7eac3',
    propColorBlue: '#b1d1f6',
    propColorPurple: '#e6d0ff',
    propColorPink: '#ffd6e9',
    propColorRed: '#ffa9a9',
}

// Edge stroke colors — same hue as the node tints but darker (≈ color-mix
// with black 35%) so a 2px line stays legible on the chart's pale grid.
// This matches the `bar-progress` fill convention used in the Timeline
// and Resource views, so the palette feels consistent across views.
const COLOR_EDGE_BY_NAME: Record<string, string> = {
    propColorDefault: '#a6a6a6',
    propColorGray: '#9a9a9a',
    propColorBrown: '#a08c79',
    propColorOrange: '#a6877a',
    propColorYellow: '#a09b76',
    propColorGreen: '#809778',
    propColorBlue: '#73869c',
    propColorPurple: '#9486a6',
    propColorPink: '#a68996',
    propColorRed: '#a66c6c',
}

type NodeColors = {
    background?: string  // CSS string for the live node (may be a var())
    minimap?: string     // hex for the minimap (SVG-safe)
    edge?: string        // darker hex for edge strokes (legible on light bg)
    paletteName?: string // raw propColor* name, used to compare same-vs-diff
}

function resolveNodeColors(card: Card, colorProp?: IPropertyTemplate): NodeColors {
    if (!colorProp) {
        return {}
    }
    if (colorProp.type !== 'select' && colorProp.type !== 'multiSelect') {
        return {}
    }
    const raw = card.fields.properties[colorProp.id]
    if (!raw) {
        return {}
    }
    // Multi-select: take the first option's color so the tint stays
    // single-hued; users wanting multi-color hints can use a single-select.
    const id = Array.isArray(raw) ? (raw[0] as string | undefined) : (raw as string)
    if (!id) {
        return {}
    }
    const options = colorProp.options || []
    const opt = options.find((o) => o.id === id)
    if (!opt || !opt.color) {
        return {}
    }
    return {
        background: COLOR_VAR_BY_NAME[opt.color],
        minimap: COLOR_HEX_BY_NAME[opt.color],
        edge: COLOR_EDGE_BY_NAME[opt.color],
        paletteName: opt.color,
    }
}

// Each value in the hierarchy property is a card-id pointing at a child.
// The property may be either Task (string) or Multi task (string[]).
function readChildIds(card: Card, prop?: IPropertyTemplate): string[] {
    if (!prop) {
        return []
    }
    const v = card.fields.properties[prop.id]
    if (typeof v === 'string') {
        return v ? [v] : []
    }
    if (Array.isArray(v)) {
        return v.filter((x: unknown): x is string => typeof x === 'string')
    }
    return []
}

type HierarchyNodeData = {
    card: Card
    board: Board
    title: string
    visibleTemplates: IPropertyTemplate[]
    backgroundColor?: string
    minimapColor?: string
    layout: HierarchyLayout
    onOpen: (cardId: string) => void
}

const handleStyle = {opacity: 0}

// Custom reactflow node — title + per-property rows. Handles are placed
// according to the layout direction so edges enter at the side opposite
// the rank flow (e.g. TB → top targets, bottom sources).
const HierarchyNode = (props: NodeProps<HierarchyNodeData>) => {
    const {data} = props
    const {card, board, title, visibleTemplates, backgroundColor, layout, onOpen} = data

    const sourcePosition = layout === 'TB' ? Position.Bottom :
        layout === 'BT' ? Position.Top :
            layout === 'RL' ? Position.Left :
                Position.Right
    const targetPosition = layout === 'TB' ? Position.Top :
        layout === 'BT' ? Position.Bottom :
            layout === 'RL' ? Position.Right :
                Position.Left

    return (
        <div
            className='HierarchyNode'
            style={backgroundColor ? {background: backgroundColor} : undefined}
            onDoubleClick={(e) => {
                // Stop the event before reactflow's pane handler runs so the
                // canvas doesn't also fire its own dblclick (which would trigger
                // a zoom-to-cursor in addition to the card open).
                e.stopPropagation()
                onOpen(card.id)
            }}
        >
            <Handle
                type='target'
                position={targetPosition}
                style={handleStyle}
                isConnectable={false}
            />
            <div className='HierarchyNode__title'>
                {card.fields?.icon && (
                    <span className='HierarchyNode__icon'>{card.fields.icon}</span>
                )}
                <span className='HierarchyNode__title-text'>{title}</span>
            </div>
            {visibleTemplates.length > 0 && (
                <div className='HierarchyNode__props'>
                    {visibleTemplates.map((p) => (
                        <div
                            key={p.id}
                            className='HierarchyNode__prop'
                        >
                            <span className='HierarchyNode__prop-label'>{p.name}</span>
                            <span className='HierarchyNode__prop-value'>
                                <PropertyValueElement
                                    board={board}
                                    card={card}
                                    propertyTemplate={p}
                                    readOnly={true}
                                    showEmptyPlaceholder={false}
                                />
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <Handle
                type='source'
                position={sourcePosition}
                style={handleStyle}
                isConnectable={false}
            />
        </div>
    )
}

const nodeTypes = {hierarchyCard: HierarchyNode}

type Props = {
    board: Board
    cards: Card[]
    activeView: BoardView
    readonly: boolean
    showCard: (cardId: string) => void
}

// Run dagre over the unpositioned nodes / edges and attach absolute (x,y)
// to each node. Returns a fresh array; reactflow re-renders only when
// node identity changes so we keep the same `id`s.
function layoutNodes(
    nodes: Node<HierarchyNodeData>[],
    edges: Edge[],
    direction: HierarchyLayout,
): Node<HierarchyNodeData>[] {
    if (nodes.length === 0) {
        return nodes
    }
    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({
        rankdir: direction,
        nodesep: 40,
        ranksep: 60,
        marginx: 20,
        marginy: 20,
    })

    for (const n of nodes) {
        const visibleCount = n.data.visibleTemplates.length
        const w = BASE_NODE_WIDTH
        const h = BASE_NODE_HEIGHT + (visibleCount * PROPERTY_ROW_HEIGHT)
        g.setNode(n.id, {width: w, height: h})
    }
    for (const e of edges) {
        g.setEdge(e.source, e.target)
    }

    dagre.layout(g)

    return nodes.map((n) => {
        const pos = g.node(n.id)
        const visibleCount = n.data.visibleTemplates.length
        const h = BASE_NODE_HEIGHT + (visibleCount * PROPERTY_ROW_HEIGHT)
        // dagre returns the *center* of each node; reactflow wants the
        // top-left corner, so subtract half the dimensions.
        return {
            ...n,
            position: {
                x: pos.x - (BASE_NODE_WIDTH / 2),
                y: pos.y - (h / 2),
            },
        }
    })
}

const HierarchyViewInner = (props: Props) => {
    const {board, cards, activeView, showCard} = props
    const intl = useIntl()
    const {fitView} = useReactFlow()

    const layout: HierarchyLayout = activeView.fields.hierarchyLayout || 'TB'

    const hierarchyProperty = useMemo(() => {
        const id = activeView.fields.hierarchyPropertyId
        if (!id) {
            return undefined
        }
        return board.cardProperties.find((p) => p.id === id)
    }, [board.cardProperties, activeView.fields.hierarchyPropertyId])

    const colorProperty = useMemo(() => {
        const id = activeView.fields.hierarchyColorPropertyId
        if (!id) {
            return undefined
        }
        return board.cardProperties.find((p) => p.id === id)
    }, [board.cardProperties, activeView.fields.hierarchyColorPropertyId])

    // Visible properties as configured by the standard "Properties" menu;
    // the synthetic `__title` id is excluded since the title is already
    // shown in the node header.
    const visibleTemplates = useMemo<IPropertyTemplate[]>(() => {
        const ids = activeView.fields.visiblePropertyIds || []
        return ids
            .filter((id) => id && id !== Constants.titleColumnId)
            .map((id) => board.cardProperties.find((p) => p.id === id))
            .filter((p): p is IPropertyTemplate => Boolean(p))
    }, [board.cardProperties, activeView.fields.visiblePropertyIds])

    const cardsById = useMemo<Map<string, Card>>(() => {
        const m = new Map<string, Card>()
        for (const c of cards) {
            m.set(c.id, c)
        }
        return m
    }, [cards])

    // Build the unpositioned nodes / edges from the cards + the hierarchy
    // relation. Edges only connect cards that exist in the current `cards`
    // list (filtered cards drop out of both ends naturally).
    const {rawNodes, rawEdges} = useMemo(() => {
        // Pre-resolve color metadata per card so edges can compare source
        // vs target tint without re-walking property options for each
        // endpoint. Keyed by card id; entries are undefined when the card
        // has no resolved color (no Color-by chosen, or the chosen option
        // has no color set).
        const colorById = new Map<string, NodeColors>()
        const nodes: Node<HierarchyNodeData>[] = cards.map((card) => {
            const colors = resolveNodeColors(card, colorProperty)
            colorById.set(card.id, colors)
            return {
                id: card.id,
                type: 'hierarchyCard',
                position: {x: 0, y: 0},
                data: {
                    card,
                    board,
                    title: card.title || intl.formatMessage({id: 'HierarchyView.untitled', defaultMessage: '(Untitled)'}),
                    visibleTemplates,
                    backgroundColor: colors.background,
                    minimapColor: colors.minimap,
                    layout,
                    onOpen: showCard,
                },
            }
        })

        const edges: Edge[] = []
        if (hierarchyProperty) {
            for (const card of cards) {
                const childIds = readChildIds(card, hierarchyProperty)
                for (const childId of childIds) {
                    if (!cardsById.has(childId)) {
                        continue
                    }
                    const src = colorById.get(card.id)
                    const tgt = colorById.get(childId)
                    // Color rules:
                    //   - both endpoints share a palette color → solid line in
                    //     that color (the source side, since both match)
                    //   - colors differ, or one side is uncolored → animated
                    //     line in the *source*'s color (where the edge flows
                    //     from). If the source has no color either, the
                    //     edge falls back to the reactflow default stroke and
                    //     stays animated to mark the cross-color hop.
                    const sameColor = Boolean(src?.paletteName && tgt?.paletteName && src.paletteName === tgt.paletteName)
                    edges.push({
                        id: `${card.id}->${childId}`,
                        source: card.id,
                        target: childId,
                        type: 'smoothstep',
                        animated: !sameColor,
                        style: src?.edge ? {stroke: src.edge, strokeWidth: 2} : undefined,
                    })
                }
            }
        }
        return {rawNodes: nodes, rawEdges: edges}
    }, [cards, board, intl, visibleTemplates, colorProperty, layout, showCard, hierarchyProperty, cardsById])

    // Position via dagre. Recomputed whenever the input changes.
    const nodes = useMemo(
        () => layoutNodes(rawNodes, rawEdges, layout),
        [rawNodes, rawEdges, layout],
    )

    // Re-fit the viewport when layout direction or the node set changes
    // structurally. Without this, switching from TB to LR would leave the
    // graph offset to one corner.
    const lastFitKeyRef = useRef<string>('')
    useEffect(() => {
        const key = `${layout}|${nodes.length}|${rawEdges.length}`
        if (key === lastFitKeyRef.current) {
            return
        }
        lastFitKeyRef.current = key
        // Wait one tick for reactflow to mount the new node DOM before
        // fitting; otherwise getBoundingClientRect returns zero.
        const t = setTimeout(() => {
            fitView({padding: 0.2, duration: 200})
        }, 0)
        return () => clearTimeout(t)
    }, [layout, nodes, rawEdges, fitView])

    if (!hierarchyProperty) {
        return (
            <div className='HierarchyContainer HierarchyContainer--empty'>
                {intl.formatMessage({
                    id: 'HierarchyView.no-property',
                    defaultMessage: 'Pick a Task / Multi task property in "Hierarchy by" to draw the tree.',
                })}
            </div>
        )
    }
    if (cards.length === 0) {
        return (
            <div className='HierarchyContainer HierarchyContainer--empty'>
                {intl.formatMessage({
                    id: 'HierarchyView.empty',
                    defaultMessage: 'No cards to display.',
                })}
            </div>
        )
    }

    return (
        <div className='HierarchyContainer'>
            <ReactFlow
                nodes={nodes}
                edges={rawEdges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={true}
                // Reactflow defaults zoom-on-dblclick to true on the pane;
                // we want the canvas not to swallow the gesture so the
                // node's own onDoubleClick handler runs unobstructed.
                zoomOnDoubleClick={false}
                onNodeDoubleClick={(_, n) => showCard(n.id)}
                fitView={true}
                fitViewOptions={{padding: 0.2}}
                minZoom={0.2}
                maxZoom={2}
                proOptions={{hideAttribution: true}}
            >
                <Background gap={16}/>
                <MiniMap
                    pannable={true}
                    zoomable={true}
                    // Tint each minimap rect with the node's resolved
                    // background color so the minimap mirrors the chart's
                    // "Color by" property. Falls back to a neutral chip
                    // when the node has no color (no Color-by chosen, or
                    // the option lacks a color).
                    nodeColor={(n) => (n.data as HierarchyNodeData | undefined)?.minimapColor ||
                        'rgba(160, 160, 180, 0.6)'}
                    nodeStrokeColor='rgba(0, 0, 0, 0.25)'
                    nodeStrokeWidth={1}
                    nodeBorderRadius={2}
                />
                <Controls showInteractive={false}/>
            </ReactFlow>
        </div>
    )
}

const HierarchyView = (props: Props) => (
    <ReactFlowProvider>
        <HierarchyViewInner {...props}/>
    </ReactFlowProvider>
)

export default React.memo(HierarchyView)
