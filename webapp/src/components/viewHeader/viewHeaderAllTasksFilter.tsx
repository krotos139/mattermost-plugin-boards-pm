// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the "All Tasks" system dashboard. Restricts the
// dashboard card list to cards whose Person / Multi person / Person
// (notify) / Multi person (notify) properties contain the selected user.
// The filter is persisted on the dashboard board's `properties` map
// (key: `dashboardAllTasksFilterUserIDs`) and read by the server's
// `getAllTasksCards`. Single-user picker on purpose: it covers the
// "what's on my plate" / "what is X working on" use cases and keeps the
// query bounded.
//
// Default behaviour:
//   * Property never set → both server and UI default to the calling
//     user (server: the receive-side fallback in getAllTasksCards;
//     client: the effectiveIDs memo). Nothing is written through, so
//     the persisted state stays "unset" until the user picks something.
//   * User clears the picker → write through `[]`. Server treats an
//     explicit empty array as "show nothing" and the UI surfaces a
//     warning. Refreshing the page keeps it cleared.
//   * User picks someone → write through `[id]`.

import React, {useCallback, useMemo, useState} from 'react'
import {FormattedMessage, useIntl} from 'react-intl'
import {ActionMeta, SingleValue} from 'react-select'

import {Board} from '../../blocks/board'
import {IUser} from '../../user'
import {Utils} from '../../utils'
import octoClient from '../../octoClient'
import {useAppDispatch, useAppSelector} from '../../store/hooks'
import {getBoardUsers, getMe} from '../../store/users'
import {getClientConfig} from '../../store/clientConfig'
import {ClientConfig} from '../../config/clientConfig'
import {updateBoards} from '../../store/boards'
import {loadBoardData} from '../../store/initialLoad'
import Button from '../../widgets/buttons/button'
import Modal from '../modal'
import ModalWrapper from '../modalWrapper'
import PersonSelector from '../personSelector'

import './viewHeaderAllTasksFilter.scss'

// Same numeric cap as the server's `allTasksMaxCards`. When the returned
// card count hits this value the result was almost certainly truncated,
// so we surface a banner asking the user to narrow the filter.
export const ALL_TASKS_CAP = 1000

const ALL_TASKS_FILTER_KEY = 'dashboardAllTasksFilterUserIDs'

// `undefined`  → never persisted (server falls back to current user).
// `[]`         → user explicitly cleared (server returns nothing).
// `[id]`       → filter active.
const readPersistedIDs = (board: Board): string[] | undefined => {
    const raw = (board.properties as Record<string, unknown> | undefined)?.[ALL_TASKS_FILTER_KEY]
    if (!Array.isArray(raw)) {
        return undefined
    }
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

type Props = {
    board: Board
    cardCount: number
}

const ViewHeaderAllTasksFilter = (props: Props): JSX.Element => {
    const {board, cardCount} = props
    const intl = useIntl()
    const dispatch = useAppDispatch()
    const me = useAppSelector(getMe)
    const boardUsersById = useAppSelector(getBoardUsers)
    const clientConfig = useAppSelector<ClientConfig>(getClientConfig)

    const persistedIDs = useMemo(() => readPersistedIDs(board), [board])

    // Display-only fallback when the user has never set a filter: pretend
    // the picker holds the current user. We deliberately do NOT write this
    // value through — otherwise a fresh "remove" by the user would race
    // with the auto-write and the chip would snap back. The server applies
    // the same fallback (see app/dashboard.go: getAllTasksCards) so the
    // visible cards match what the picker shows.
    const effectiveIDs = useMemo(() => {
        if (persistedIDs) {
            return persistedIDs
        }
        return me?.id ? [me.id] : []
    }, [persistedIDs, me?.id])

    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)

    const persist = useCallback(async (next: string[]) => {
        setBusy(true)
        try {
            const response = await octoClient.patchBoard(board.id, {
                updatedProperties: {[ALL_TASKS_FILTER_KEY]: next},
            })
            if (response.status === 200) {
                const updated = await response.json() as Board
                dispatch(updateBoards([updated]))
            }
            await dispatch(loadBoardData(board.id))
        } finally {
            setBusy(false)
        }
    }, [board.id, dispatch])

    const onChange = useCallback((item: SingleValue<IUser>, action: ActionMeta<IUser>) => {
        if (action.action === 'clear') {
            void persist([])
            return
        }
        if (action.action === 'select-option' && item && (item as IUser).id) {
            void persist([(item as IUser).id])
        }
    }, [persist])

    const buttonLabel = useMemo(() => {
        if (effectiveIDs.length === 0) {
            return intl.formatMessage({id: 'AllTasks.filter-none', defaultMessage: 'No assignee'})
        }
        const u = boardUsersById[effectiveIDs[0]]
        const name = u ? Utils.getUserDisplayName(u, clientConfig.teammateNameDisplay) : '…'
        return intl.formatMessage(
            {id: 'AllTasks.filter-one', defaultMessage: 'Assigned: {user}'},
            {user: name},
        )
    }, [effectiveIDs, boardUsersById, clientConfig.teammateNameDisplay, intl])

    const truncated = effectiveIDs.length > 0 && cardCount >= ALL_TASKS_CAP

    return (
        <ModalWrapper>
            <Button
                active={open || effectiveIDs.length > 0}
                onClick={() => setOpen(!open)}
            >
                {buttonLabel}
                {truncated && (
                    <span
                        className='AllTasksFilter__cap-badge'
                        title={intl.formatMessage(
                            {id: 'AllTasks.filter-truncated', defaultMessage: 'Showing the first {cap, number} matches. Narrow the filter to see fewer, more relevant tasks.'},
                            {cap: ALL_TASKS_CAP},
                        )}
                    >
                        {`${ALL_TASKS_CAP}+`}
                    </span>
                )}
            </Button>
            {open && (
                <Modal onClose={() => setOpen(false)}>
                    <div className='AllTasksFilter'>
                        <div className='AllTasksFilter__title'>
                            <FormattedMessage
                                id='AllTasks.filter-label'
                                defaultMessage='Show tasks assigned to'
                            />
                        </div>
                        <div className='AllTasksFilter__picker'>
                            <PersonSelector
                                userIDs={effectiveIDs}
                                allowAddUsers={false}
                                isMulti={false}
                                readOnly={busy}
                                showMe={true}
                                emptyDisplayValue={intl.formatMessage({id: 'AllTasks.filter-placeholder', defaultMessage: 'Pick a user…'})}
                                onChange={onChange as unknown as (items: any, action: ActionMeta<IUser>) => void}
                            />
                        </div>
                        {effectiveIDs.length === 0 ? (
                            <div className='AllTasksFilter__warning'>
                                <FormattedMessage
                                    id='AllTasks.filter-empty-warning'
                                    defaultMessage='No tasks shown — pick a user to filter by.'
                                />
                            </div>
                        ) : null}
                        {truncated && (
                            <div className='AllTasksFilter__warning'>
                                <FormattedMessage
                                    id='AllTasks.filter-truncated'
                                    defaultMessage='Showing the first {cap, number} matches. Narrow the filter to see fewer, more relevant tasks.'
                                    values={{cap: ALL_TASKS_CAP}}
                                />
                            </div>
                        )}
                    </div>
                </Modal>
            )}
        </ModalWrapper>
    )
}

export default React.memo(ViewHeaderAllTasksFilter)
