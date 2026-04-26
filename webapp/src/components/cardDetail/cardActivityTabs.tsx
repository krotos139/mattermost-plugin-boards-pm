// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useState} from 'react'
import {FormattedMessage} from 'react-intl'

import {CommentBlock} from '../../blocks/commentBlock'
import {Board} from '../../blocks/board'

import CommentsList from './commentsList'
import CardHistoryView from './cardHistoryView'

type Tab = 'comments' | 'history'

type Props = {
    board: Board
    comments: readonly CommentBlock[]
    boardId: string
    cardId: string
    readonly: boolean
}

const CardActivityTabs = (props: Props): JSX.Element => {
    const [tab, setTab] = useState<Tab>('comments')

    return (
        <div className='CardActivityTabs'>
            <div className='CardActivityTabs__tabs'>
                <button
                    className={`CardActivityTabs__tab ${tab === 'comments' ? 'active' : ''}`}
                    onClick={() => setTab('comments')}
                    type='button'
                >
                    <FormattedMessage
                        id='CardActivityTabs.comments'
                        defaultMessage='Comments'
                    />
                </button>
                <button
                    className={`CardActivityTabs__tab ${tab === 'history' ? 'active' : ''}`}
                    onClick={() => setTab('history')}
                    type='button'
                >
                    <FormattedMessage
                        id='CardActivityTabs.history'
                        defaultMessage='History'
                    />
                </button>
            </div>
            {tab === 'comments' ? (
                <CommentsList
                    comments={props.comments}
                    boardId={props.boardId}
                    cardId={props.cardId}
                    readonly={props.readonly}
                />
            ) : (
                <CardHistoryView
                    board={props.board}
                    cardId={props.cardId}
                />
            )}
        </div>
    )
}

export default React.memo(CardActivityTabs)
