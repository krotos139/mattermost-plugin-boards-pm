// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useMemo} from 'react'
import {useIntl} from 'react-intl'

import {ContentBlock} from '../../blocks/contentBlock'
import {IPropertyOption} from '../../blocks/board'
import {RootState} from '../../store/index'
import {useAppSelector} from '../../store/hooks'
import {PropertyProps} from '../types'

import './subtasksDistribution.scss'

const ORPHAN_BUCKET = '__orphan'

// Reads the card's content blocks of type 'subtask' from the contents
// store and groups them by optionId. Buckets with count 0 are omitted; an
// "orphan" bucket is added if any subtask references a now-deleted option.
const SubtasksDistribution = (props: PropertyProps): JSX.Element => {
    const {board, card} = props
    const intl = useIntl()

    const contents = useAppSelector(
        (state: RootState) => state.contents?.contentsByCard?.[card.id] as ContentBlock[] | undefined,
    )

    const propId = (board?.properties as Record<string, string|undefined> | undefined)?.subtaskStatesPropertyId
    const statesProperty = propId ? board?.cardProperties.find((p) => p.id === propId) : undefined
    const options: IPropertyOption[] = statesProperty?.type === 'select' ? (statesProperty.options || []) : []

    const counts = useMemo(() => {
        const map: Record<string, number> = {}
        if (!contents) {
            return map
        }
        for (const blk of contents) {
            if (blk.type !== 'subtask') {
                continue
            }
            const optId = (blk.fields?.optionId as string|undefined) || ''
            if (!optId) {
                continue
            }
            const known = options.some((o) => o.id === optId)
            const key = known ? optId : ORPHAN_BUCKET
            map[key] = (map[key] || 0) + 1
        }
        return map
    }, [contents, options])

    const cells: JSX.Element[] = []
    for (const opt of options) {
        const c = counts[opt.id]
        if (!c) {
            continue
        }
        cells.push(
            <span
                key={opt.id}
                className={`SubtasksDistribution__chip ${opt.color || ''}`}
                title={opt.value}
            >
                {c}
            </span>,
        )
    }
    const orphan = counts[ORPHAN_BUCKET] || 0
    if (orphan > 0) {
        cells.push(
            <span
                key={ORPHAN_BUCKET}
                className={'SubtasksDistribution__chip empty'}
                title={intl.formatMessage({id: 'Subtask.unknownOption', defaultMessage: 'Unknown'})}
            >
                {orphan}
            </span>,
        )
    }

    return (
        <div className={`SubtasksDistribution ${props.property.valueClassName(true)}`}>
            {cells}
        </div>
    )
}

export default SubtasksDistribution
