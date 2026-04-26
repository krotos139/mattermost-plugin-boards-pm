// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import octoClient from '../../octoClient'
import {Utils} from '../../utils'
import {useAppSelector} from '../../store/hooks'
import {getBoardUsers} from '../../store/users'
import {IUser} from '../../user'
import {Board, IPropertyTemplate} from '../../blocks/board'
import Tooltip from '../../widgets/tooltip'

import {CardHistoryEvent} from './cardHistory'

import './cardHistoryView.scss'

type Props = {
    board: Board
    cardId: string
}

const renderValueChip = (
    value: string | undefined,
    propType: string | undefined,
    template: IPropertyTemplate | undefined,
    boardUsers: {[id: string]: IUser},
): JSX.Element => {
    if (!value) {
        return <span className='value-chip empty'>—</span>
    }

    // Resolve select option labels to their human-readable names.
    if ((propType === 'select' || propType === 'multiSelect') && template) {
        const opt = template.options.find((o) => o.id === value)
        if (opt) {
            return <span className='value-chip'>{opt.value}</span>
        }
    }

    // Person/multiPerson: value is either a userID string or a JSON array.
    if (propType === 'person' || propType === 'personNotify' ||
        propType === 'multiPerson' || propType === 'multiPersonNotify') {
        let ids: string[] = []
        if (value.startsWith('[')) {
            try {
                const parsed = JSON.parse(value)
                if (Array.isArray(parsed)) {
                    ids = parsed.filter((s) => typeof s === 'string')
                }
            } catch {
                ids = []
            }
        } else {
            ids = [value]
        }
        if (ids.length === 0) {
            return <span className='value-chip empty'>—</span>
        }
        return (
            <span className='value-chip'>
                {ids.map((id) => boardUsers[id]?.username || id).join(', ')}
            </span>
        )
    }

    // Date/deadline: value is millis-string or JSON {from, to}.
    if (propType === 'date' || propType === 'updatedTime' || propType === 'createdTime' || propType === 'deadline') {
        let millis = parseInt(value, 10)
        if (isNaN(millis) && value.startsWith('{')) {
            try {
                const parsed = JSON.parse(value)
                if (parsed && typeof parsed.from === 'number') {
                    millis = parsed.from
                }
            } catch {
                millis = NaN
            }
        }
        if (!isNaN(millis) && millis > 0) {
            return <span className='value-chip'>{new Date(millis).toLocaleString()}</span>
        }
    }

    return <span className='value-chip'>{value}</span>
}

// hasTextBody decides whether to quote the block's body. Only text/checkbox
// content blocks store a meaningful markdown body in `title`; image/divider/
// attachment blocks have no body to quote.
const hasTextBody = (blockType: string | undefined): boolean => {
    return blockType === 'text' || blockType === 'checkbox'
}

const renderQuote = (body: string): JSX.Element => (
    <blockquote className='quote'>{body}</blockquote>
)

const renderQuoteDiff = (before: string | undefined, after: string | undefined): JSX.Element => (
    <>
        {before && (
            <blockquote className='quote quote--before'>{before}</blockquote>
        )}
        {after && (
            <blockquote className='quote quote--after'>{after}</blockquote>
        )}
    </>
)

const renderDescAdded = (event: CardHistoryEvent): JSX.Element => {
    switch (event.blockType) {
    case 'image':
        return (
            <FormattedMessage
                id='CardHistory.desc-added-image'
                defaultMessage='added an image'
            />
        )
    case 'divider':
        return (
            <FormattedMessage
                id='CardHistory.desc-added-divider'
                defaultMessage='added a divider'
            />
        )
    case 'attachment':
        return (
            <FormattedMessage
                id='CardHistory.desc-added-attachment'
                defaultMessage='added an attachment'
            />
        )
    default:
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.desc-added'
                    defaultMessage='added to description'
                />
                {event.after && renderQuote(event.after)}
            </span>
        )
    }
}

const renderEvent = (
    event: CardHistoryEvent,
    board: Board,
    boardUsers: {[id: string]: IUser},
): JSX.Element => {
    switch (event.kind) {
    case 'card-created':
        return (
            <FormattedMessage
                id='CardHistory.created'
                defaultMessage='created this card'
            />
        )
    case 'title':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.title'
                    defaultMessage='renamed card'
                />
                {' '}
                {renderValueChip(event.before, 'text', undefined, boardUsers)}
                {' → '}
                {renderValueChip(event.after, 'text', undefined, boardUsers)}
            </span>
        )
    case 'icon':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.icon'
                    defaultMessage='changed icon'
                />
                {' '}
                {event.before && <span className='value-chip'>{event.before}</span>}
                {event.before && ' → '}
                {event.after && <span className='value-chip'>{event.after}</span>}
            </span>
        )
    case 'property': {
        const template = board.cardProperties.find((p) => p.id === event.propertyId)
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.property'
                    defaultMessage='changed {name}'
                    values={{name: <strong>{event.propertyName}</strong>}}
                />
                {' '}
                {renderValueChip(event.before, event.propertyType, template, boardUsers)}
                {' → '}
                {renderValueChip(event.after, event.propertyType, template, boardUsers)}
            </span>
        )
    }
    case 'desc-added':
        return renderDescAdded(event)
    case 'desc-edited':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.desc-edited'
                    defaultMessage='edited description'
                />
                {hasTextBody(event.blockType) && renderQuoteDiff(event.before, event.after)}
            </span>
        )
    case 'desc-removed':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.desc-removed'
                    defaultMessage='removed from description'
                />
                {hasTextBody(event.blockType) && event.before && renderQuote(event.before)}
            </span>
        )
    case 'comment-added':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.comment-added'
                    defaultMessage='added a comment'
                />
                {event.after && renderQuote(event.after)}
            </span>
        )
    case 'comment-edited':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.comment-edited'
                    defaultMessage='edited a comment'
                />
                {renderQuoteDiff(event.before, event.after)}
            </span>
        )
    case 'comment-removed':
        return (
            <span>
                <FormattedMessage
                    id='CardHistory.comment-removed'
                    defaultMessage='deleted a comment'
                />
                {event.before && renderQuote(event.before)}
            </span>
        )
    default:
        return <span/>
    }
}

const CardHistoryView = (props: Props): JSX.Element => {
    const {board, cardId} = props
    const intl = useIntl()
    const boardUsers = useAppSelector<{[id: string]: IUser}>(getBoardUsers)

    const [events, setEvents] = useState<CardHistoryEvent[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setEvents(null)
        setError(null)
        octoClient.getCardHistory(cardId).then((result) => {
            if (!cancelled) {
                setEvents(result)
            }
        }).catch((e) => {
            if (!cancelled) {
                setError(String(e))
            }
        })
        return () => {
            cancelled = true
        }
    }, [cardId])

    if (error) {
        return (
            <div className='CardHistoryView'>
                <div className='CardHistoryView__error'>
                    <FormattedMessage
                        id='CardHistory.load-error'
                        defaultMessage='Could not load history.'
                    />
                </div>
            </div>
        )
    }

    if (events === null) {
        return (
            <div className='CardHistoryView'>
                <div className='CardHistoryView__loading'>
                    <FormattedMessage
                        id='CardHistory.loading'
                        defaultMessage='Loading…'
                    />
                </div>
            </div>
        )
    }

    if (events.length === 0) {
        return (
            <div className='CardHistoryView'>
                <div className='CardHistoryView__empty'>
                    <FormattedMessage
                        id='CardHistory.empty'
                        defaultMessage='No activity recorded yet.'
                    />
                </div>
            </div>
        )
    }

    // Newest first, oldest at the bottom — opposite of the chronological
    // order the backend returns.
    const ordered = events.slice().reverse()

    return (
        <div className='CardHistoryView'>
            {ordered.map((event, idx) => {
                const user = boardUsers[event.userId]
                const name = user?.username || event.userId || intl.formatMessage({id: 'CardHistory.unknown-user', defaultMessage: 'Unknown user'})
                const date = new Date(event.timestamp)
                return (
                    <div
                        key={`${event.timestamp}-${event.kind}-${event.propertyId || event.blockId || ''}-${idx}`}
                        className='CardHistoryView__entry'
                    >
                        <img
                            className='avatar'
                            src={Utils.getProfilePicture(event.userId)}
                            alt=''
                        />
                        <div className='body'>
                            <span className='actor'>{name}</span>
                            {' '}
                            <span className='action'>{renderEvent(event, board, boardUsers)}</span>
                            <Tooltip title={Utils.displayDateTime(date, intl)}>
                                <span className='date'>{Utils.relativeDisplayDateTime(date, intl)}</span>
                            </Tooltip>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

export default React.memo(CardHistoryView)
