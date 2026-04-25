// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useCallback, useState} from 'react'
import {FormattedMessage, useIntl} from 'react-intl'
import {generatePath, useHistory, useRouteMatch} from 'react-router-dom'

import octoClient from '../../octoClient'
import {Utils} from '../../utils'
import {useAppDispatch, useAppSelector} from '../../store/hooks'
import {getCurrentTeamId} from '../../store/teams'
import {getMyDashboardBoards, updateBoards} from '../../store/boards'
import {getCurrentBoardViews, getCurrentViewId} from '../../store/views'
import {loadBoardData, loadMyBoardsMemberships} from '../../store/initialLoad'
import {BoardView, IViewType} from '../../blocks/boardView'
import BoardIcon from '../../widgets/icons/board'
import TableIcon from '../../widgets/icons/table'
import GalleryIcon from '../../widgets/icons/gallery'
import CalendarIcon from '../../widgets/icons/calendar'

// Reuse existing sidebar-item styles so the entry looks like a regular board.
import './sidebarBoardItem.scss'
import './sidebarDashboardSection.scss'

const iconForViewType = (viewType: IViewType): JSX.Element => {
    switch (viewType) {
    case 'board': return <BoardIcon/>
    case 'table': return <TableIcon/>
    case 'gallery': return <GalleryIcon/>
    case 'calendar': return <CalendarIcon/>
    default: return <div/>
    }
}

type Props = {
    activeBoardID?: string
}

const SidebarDashboardSection = (props: Props): JSX.Element | null => {
    const intl = useIntl()
    const teamID = useAppSelector(getCurrentTeamId)
    const dashboards = useAppSelector(getMyDashboardBoards)
    const boardViews = useAppSelector(getCurrentBoardViews)
    const currentViewId = useAppSelector(getCurrentViewId)
    const dispatch = useAppDispatch()
    const history = useHistory()
    const match = useRouteMatch<{boardId: string, viewId?: string, cardId?: string, teamId?: string}>()

    const [openingKind, setOpeningKind] = useState<string | null>(null)

    const myDeadlines = dashboards.find((b) => (b.properties as Record<string, unknown> | undefined)?.dashboardKind === 'deadlines')
    const isActive = Boolean(myDeadlines && myDeadlines.id === props.activeBoardID)

    const showView = useCallback((viewId: string, boardId: string) => {
        const params = {...match.params, boardId: boardId || '', viewId: viewId || ''}
        if (boardId !== match.params.boardId && viewId !== match.params.viewId) {
            params.cardId = undefined
        }
        const newPath = generatePath(Utils.getBoardPagePath(match.path), params)
        history.push(newPath)
    }, [match, history])

    const openOrCreate = useCallback(async (kind: string) => {
        if (!teamID) {
            return
        }
        setOpeningKind(kind)
        try {
            const board = await octoClient.getDashboardBoard(kind, teamID)
            if (!board) {
                return
            }
            dispatch(updateBoards([board]))
            await dispatch(loadMyBoardsMemberships())
            Utils.showBoard(board.id, match, history)
        } finally {
            setOpeningKind(null)
        }
    }, [teamID, dispatch, history, match])

    if (!teamID) {
        return null
    }

    return (
        <div className='SidebarDashboardSection'>
            <div className='dashboard-heading'>
                <FormattedMessage
                    id='Sidebar.dashboard-section-title'
                    defaultMessage='DASHBOARD'
                />
            </div>
            <div
                className={`SidebarBoardItem subitem dashboard-item ${isActive ? 'active' : ''}`}
                onClick={() => openOrCreate('deadlines')}
                role='button'
            >
                <div className='octo-sidebar-icon'>{'\u{1F3C1}'}</div>
                <div
                    className='octo-sidebar-title'
                    title='My Deadlines'
                >
                    <FormattedMessage
                        id='Sidebar.dashboard-deadlines'
                        defaultMessage='My Deadlines'
                    />
                </div>
                {myDeadlines &&
                    <button
                        className='dashboard-refresh'
                        title='Refresh deadlines'
                        aria-label='Refresh deadlines'
                        onClick={(e) => {
                            e.stopPropagation()
                            dispatch(loadBoardData(myDeadlines.id))
                        }}
                    >
                        {'\u21bb'}
                    </button>}
                {openingKind === 'deadlines' && <div className='spinner'/>}
            </div>
            {isActive && myDeadlines && boardViews.map((view: BoardView) => (
                <div
                    key={view.id}
                    className={`SidebarBoardItem sidebar-view-item ${view.id === currentViewId ? 'active' : ''}`}
                    onClick={() => showView(view.id, myDeadlines.id)}
                >
                    {iconForViewType(view.fields.viewType)}
                    <div
                        className='octo-sidebar-title'
                        title={view.title || intl.formatMessage({id: 'Sidebar.untitled-view', defaultMessage: '(Untitled View)'})}
                    >
                        {view.title || intl.formatMessage({id: 'Sidebar.untitled-view', defaultMessage: '(Untitled View)'})}
                    </div>
                </div>
            ))}
        </div>
    )
}

export default SidebarDashboardSection
