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
import {Board} from '../../blocks/board'
import {BoardView, IViewType} from '../../blocks/boardView'
import BoardIcon from '../../widgets/icons/board'
import TableIcon from '../../widgets/icons/table'
import GalleryIcon from '../../widgets/icons/gallery'
import CalendarIcon from '../../widgets/icons/calendar'
import GanttIcon from '../../widgets/icons/gantt'

// Reuse existing sidebar-item styles so the entry looks like a regular board.
import './sidebarBoardItem.scss'
import './sidebarDashboardSection.scss'

const iconForViewType = (viewType: IViewType): JSX.Element => {
    switch (viewType) {
    case 'board': return <BoardIcon/>
    case 'table': return <TableIcon/>
    case 'gallery': return <GalleryIcon/>
    case 'calendar': return <CalendarIcon/>
    case 'gantt': return <GanttIcon/>
    default: return <div/>
    }
}

type DashboardItem = {
    kind: string
    icon: string
    titleId: string
    titleDefault: string
    refreshTitle: string
}

const dashboardItems: DashboardItem[] = [
    {
        kind: 'deadlines',
        icon: '\u{1F3C1}',
        titleId: 'Sidebar.dashboard-deadlines',
        titleDefault: 'My Deadlines',
        refreshTitle: 'Refresh deadlines',
    },
    {
        kind: 'allTasks',
        icon: '\u{1F4CB}',
        titleId: 'Sidebar.dashboard-all-tasks',
        titleDefault: 'All Tasks',
        refreshTitle: 'Refresh tasks',
    },
]

const findDashboard = (boards: Board[], kind: string): Board | undefined =>
    boards.find((b) => (b.properties as Record<string, unknown> | undefined)?.dashboardKind === kind)

type Props = {
    activeBoardID?: string
    hideSidebar?: () => void
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

    const hideSidebarOnMobile = props.hideSidebar
    // Dashboard views (kanban/gallery/gantt) sometimes mount before their flex
    // parent has its final dimensions, which leaves them rendered into a tiny
    // top-left rectangle. A resize event after navigation forces ResizeObserver
    // and window.resize listeners to recompute, which restores full size.
    const nudgeLayout = () => {
        const fire = () => window.dispatchEvent(new Event('resize'))
        requestAnimationFrame(fire)
        setTimeout(fire, 200)
    }

    const showView = useCallback((viewId: string, boardId: string) => {
        const params = {...match.params, boardId: boardId || '', viewId: viewId || ''}
        if (boardId !== match.params.boardId && viewId !== match.params.viewId) {
            params.cardId = undefined
        }
        const newPath = generatePath(Utils.getBoardPagePath(match.path), params)
        history.push(newPath)
        hideSidebarOnMobile?.()
        nudgeLayout()
    }, [match, history, hideSidebarOnMobile])

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
            // Load board data (views, cards) before navigating so the route
            // doesn't render a partial/empty state while content streams in.
            await dispatch(loadBoardData(board.id))
            Utils.showBoard(board.id, match, history)
            hideSidebarOnMobile?.()
            nudgeLayout()
        } finally {
            setOpeningKind(null)
        }
    }, [teamID, dispatch, history, match, hideSidebarOnMobile])

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
            {dashboardItems.map((item) => {
                const board = findDashboard(dashboards, item.kind)
                const isActive = Boolean(board && board.id === props.activeBoardID)
                return (
                    <React.Fragment key={item.kind}>
                        <div
                            className={`SidebarBoardItem subitem dashboard-item ${isActive ? 'active' : ''}`}
                            onClick={() => openOrCreate(item.kind)}
                            role='button'
                        >
                            <div className='octo-sidebar-icon'>{item.icon}</div>
                            <div
                                className='octo-sidebar-title'
                                title={item.titleDefault}
                            >
                                <FormattedMessage
                                    id={item.titleId}
                                    defaultMessage={item.titleDefault}
                                />
                            </div>
                            {board &&
                                <button
                                    className='dashboard-refresh'
                                    title={item.refreshTitle}
                                    aria-label={item.refreshTitle}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        dispatch(loadBoardData(board.id))
                                    }}
                                >
                                    {'\u21bb'}
                                </button>}
                            {openingKind === item.kind && <div className='spinner'/>}
                        </div>
                        {isActive && board && boardViews.map((view: BoardView) => (
                            <div
                                key={view.id}
                                className={`SidebarBoardItem sidebar-view-item ${view.id === currentViewId ? 'active' : ''}`}
                                onClick={() => showView(view.id, board.id)}
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
                    </React.Fragment>
                )
            })}
        </div>
    )
}

export default SidebarDashboardSection
