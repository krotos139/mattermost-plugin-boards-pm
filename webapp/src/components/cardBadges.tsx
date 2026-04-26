// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useMemo} from 'react'
import {useIntl} from 'react-intl'

import {Card} from '../blocks/card'
import {useAppSelector} from '../store/hooks'
import {getCardContents} from '../store/contents'
import {getCardComments} from '../store/comments'
import {getCurrentBoard} from '../store/boards'
import {ContentBlock} from '../blocks/contentBlock'
import {CommentBlock} from '../blocks/commentBlock'
import {IPropertyOption} from '../blocks/board'
import TextIcon from '../widgets/icons/text'
import MessageIcon from '../widgets/icons/message'
import CheckIcon from '../widgets/icons/check'
import {Utils} from '../utils'

import './cardBadges.scss'

const ORPHAN_BUCKET = '__orphan'

type Props = {
    card: Card
    className?: string
}

type Checkboxes = {
    total: number
    checked: number
}

type Badges = {
    description: boolean
    comments: number
    checkboxes: Checkboxes
    subtaskCounts: Record<string, number>
    subtasksTotal: number
}

const hasBadges = (badges: Badges): boolean => {
    return badges.description || badges.comments > 0 || badges.checkboxes.total > 0 || badges.subtasksTotal > 0
}

type ContentsType = Array<ContentBlock | ContentBlock[]>

const calculateBadges = (contents: ContentsType, comments: CommentBlock[], stateOptions: IPropertyOption[]): Badges => {
    let text = 0
    let total = 0
    let checked = 0
    const subtaskCounts: Record<string, number> = {}
    let subtasksTotal = 0

    const updateCounters = (block: ContentBlock) => {
        if (block.type === 'text') {
            text++
            const checkboxes = Utils.countCheckboxesInMarkdown(block.title)
            total += checkboxes.total
            checked += checkboxes.checked
        } else if (block.type === 'checkbox') {
            total++
            if (block.fields.value) {
                checked++
            }
        } else if (block.type === 'subtask') {
            subtasksTotal++
            const optId = (block.fields?.optionId as string|undefined) || ''
            const known = optId && stateOptions.some((o) => o.id === optId)
            const key = known ? optId : ORPHAN_BUCKET
            subtaskCounts[key] = (subtaskCounts[key] || 0) + 1
        }
    }

    for (const content of contents) {
        if (Array.isArray(content)) {
            content.forEach(updateCounters)
        } else {
            updateCounters(content)
        }
    }
    return {
        description: text > 0,
        comments: comments.length,
        checkboxes: {
            total,
            checked,
        },
        subtaskCounts,
        subtasksTotal,
    }
}

const CardBadges = (props: Props) => {
    const {card, className} = props
    const contents = useAppSelector(getCardContents(card.id))
    const comments = useAppSelector(getCardComments(card.id))
    const board = useAppSelector(getCurrentBoard)

    const stateOptions: IPropertyOption[] = useMemo(() => {
        const propId = (board?.properties as Record<string, string|undefined> | undefined)?.subtaskStatesPropertyId
        if (!propId) {
            return []
        }
        const prop = board?.cardProperties.find((p) => p.id === propId)
        return prop?.type === 'select' ? (prop.options || []) : []
    }, [board])

    const badges = useMemo(() => calculateBadges(contents, comments, stateOptions), [contents, comments, stateOptions])
    if (!hasBadges(badges)) {
        return null
    }
    const intl = useIntl()
    const {checkboxes, subtaskCounts, subtasksTotal} = badges
    const subtaskTitle = intl.formatMessage({id: 'CardBadges.title-subtasks', defaultMessage: 'Subtasks'})
    const orphanCount = subtaskCounts[ORPHAN_BUCKET] || 0
    return (
        <div className={`CardBadges ${className || ''}`}>
            {badges.description &&
                <span title={intl.formatMessage({id: 'CardBadges.title-description', defaultMessage: 'This card has a description'})}>
                    <TextIcon/>
                </span>}
            {badges.comments > 0 &&
                <span title={intl.formatMessage({id: 'CardBadges.title-comments', defaultMessage: 'Comments'})}>
                    <MessageIcon/>
                    {badges.comments}
                </span>}
            {checkboxes.total > 0 &&
                <span title={intl.formatMessage({id: 'CardBadges.title-checkboxes', defaultMessage: 'Checkboxes'})}>
                    <CheckIcon/>
                    {`${checkboxes.checked}/${checkboxes.total}`}
                </span>}
            {subtasksTotal > 0 && stateOptions.length === 0 &&
                <span title={subtaskTitle}>
                    <CheckIcon/>
                    {subtasksTotal}
                </span>}
            {subtasksTotal > 0 && stateOptions.length > 0 &&
                <span
                    className='CardBadges__subtasks'
                    title={subtaskTitle}
                >
                    {stateOptions.map((opt) => {
                        const c = subtaskCounts[opt.id]
                        if (!c) {
                            return null
                        }
                        return (
                            <span
                                key={opt.id}
                                className={`CardBadges__subtaskChip ${opt.color || ''}`}
                                title={opt.value}
                            >
                                {c}
                            </span>
                        )
                    })}
                    {orphanCount > 0 &&
                        <span
                            key={ORPHAN_BUCKET}
                            className='CardBadges__subtaskChip empty'
                            title={intl.formatMessage({id: 'Subtask.unknownOption', defaultMessage: 'Unknown'})}
                        >
                            {orphanCount}
                        </span>}
                </span>}
        </div>
    )
}

export default React.memo(CardBadges)
