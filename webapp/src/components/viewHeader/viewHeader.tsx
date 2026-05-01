// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useState, useEffect} from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import ViewMenu from '../../components/viewMenu'
import mutator from '../../mutator'
import {Board, IPropertyTemplate} from '../../blocks/board'
import {BoardView} from '../../blocks/boardView'
import {Card} from '../../blocks/card'
import Button from '../../widgets/buttons/button'
import IconButton from '../../widgets/buttons/iconButton'
import DropdownIcon from '../../widgets/icons/dropdown'
import MenuWrapper from '../../widgets/menuWrapper'
import Editable from '../../widgets/editable'

import ModalWrapper from '../modalWrapper'

import {useAppSelector} from '../../store/hooks'
import {Permission} from '../../constants'
import {useHasCurrentBoardPermissions} from '../../hooks/permissions'
import {
    getOnboardingTourCategory,
    getOnboardingTourStarted,
    getOnboardingTourStep,
} from '../../store/users'
import {
    BoardTourSteps,
    TOUR_BOARD,
    TourCategoriesMapToSteps,
} from '../onboardingTour'
import {OnboardingBoardTitle} from '../cardDetail/cardDetail'
import AddViewTourStep from '../onboardingTour/addView/add_view'
import {getCurrentCard} from '../../store/cards'
import BoardPermissionGate from '../permissions/boardPermissionGate'

import NewCardButton from './newCardButton'
import ViewHeaderPropertiesMenu from './viewHeaderPropertiesMenu'
import ViewHeaderGroupByMenu from './viewHeaderGroupByMenu'
import ViewHeaderDisplayByMenu from './viewHeaderDisplayByMenu'
import ViewHeaderLinkedByMenu from './viewHeaderLinkedByMenu'
import ViewHeaderProgressByMenu from './viewHeaderProgressByMenu'
import ViewHeaderColorByMenu from './viewHeaderColorByMenu'
import ViewHeaderResourceByMenu from './viewHeaderResourceByMenu'
import ViewHeaderHierarchyByMenu from './viewHeaderHierarchyByMenu'
import ViewHeaderHierarchyLayoutMenu from './viewHeaderHierarchyLayoutMenu'
import ViewHeaderHierarchyColorByMenu from './viewHeaderHierarchyColorByMenu'
import ViewHeaderCFDGroupByMenu from './viewHeaderCFDGroupByMenu'
import ViewHeaderCFDDateRangeMenu from './viewHeaderCFDDateRangeMenu'
import ViewHeaderCFDStatesMenu from './viewHeaderCFDStatesMenu'
import ViewHeaderSortMenu from './viewHeaderSortMenu'
import ViewHeaderActionsMenu from './viewHeaderActionsMenu'
import ViewHeaderSearch from './viewHeaderSearch'
import FilterComponent from './filterComponent'

import './viewHeader.scss'

type Props = {
    board: Board
    activeView: BoardView
    views: BoardView[]
    cards: Card[]
    groupByProperty?: IPropertyTemplate
    addCard: () => void
    addCardFromTemplate: (cardTemplateId: string) => void
    addCardTemplate: () => void
    editCardTemplate: (cardTemplateId: string) => void
    readonly: boolean
    dateDisplayProperty?: IPropertyTemplate
}

const ViewHeader = (props: Props) => {
    const [showFilter, setShowFilter] = useState(false)
    const [lockFilterOnClose, setLockFilterOnClose] = useState(false)
    const intl = useIntl()
    const canEditBoardProperties = useHasCurrentBoardPermissions([Permission.ManageBoardProperties])

    const {board, activeView, views, groupByProperty, cards, dateDisplayProperty} = props

    // System dashboards (e.g. My Deadlines) aggregate virtual cards from other
    // boards — creating new cards here makes no sense.
    const isDashboard = Boolean((board.properties as Record<string, unknown> | undefined)?.dashboardKind)

    const withGroupBy = activeView.fields.viewType === 'board' || activeView.fields.viewType === 'table'
    const withDisplayBy = activeView.fields.viewType === 'calendar' || activeView.fields.viewType === 'gantt' || activeView.fields.viewType === 'resource' || activeView.fields.viewType === 'scheduler'
    const withLinkedBy = activeView.fields.viewType === 'gantt'
    // Progress / color are reused on both Timeline (Gantt) and Resource
    // views — both render bars and benefit from the same per-bar fill /
    // progress overlay configuration.
    const withProgressAndColor = activeView.fields.viewType === 'gantt' || activeView.fields.viewType === 'resource'
    // Scheduler picks the per-event color from a Select property too, but
    // doesn't have a "progress" concept — separate predicate keeps the two
    // controls grouped only where they're both meaningful.
    const withColorBy = withProgressAndColor || activeView.fields.viewType === 'scheduler'
    const withResourceBy = activeView.fields.viewType === 'resource'
    // Hierarchy view exposes its own trio of header menus (parent property,
    // layout direction, node tint) and skips Sort entirely — node order is
    // determined by the dagre layout.
    const withHierarchyControls = activeView.fields.viewType === 'hierarchy'
    // CFD has its own pair of header menus (group-by property, date range)
    // and skips Sort + Group + Properties — its data axis is time, not a
    // card list, so the standard controls don't apply.
    const withCFDControls = activeView.fields.viewType === 'cfd'
    const withSortBy = activeView.fields.viewType !== 'calendar' && activeView.fields.viewType !== 'gantt' && activeView.fields.viewType !== 'resource' && activeView.fields.viewType !== 'hierarchy' && activeView.fields.viewType !== 'cfd' && activeView.fields.viewType !== 'scheduler'

    // Gantt's "Linked by" lookup needs the resolved property template, not
    // just the id, so the button can show a human label and the menu can
    // render the current pick with a checkmark.
    const linkedByProperty = withLinkedBy && activeView.fields.linkedByPropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.linkedByPropertyId) :
        undefined

    // Same as linkedByProperty above — resolve here so the button label can
    // show the property's human name.
    const progressProperty = withProgressAndColor && activeView.fields.progressPropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.progressPropertyId) :
        undefined

    const colorProperty = withColorBy && activeView.fields.colorPropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.colorPropertyId) :
        undefined

    const resourceProperty = withResourceBy && activeView.fields.resourcePropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.resourcePropertyId) :
        undefined

    const hierarchyProperty = withHierarchyControls && activeView.fields.hierarchyPropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.hierarchyPropertyId) :
        undefined

    const hierarchyColorProperty = withHierarchyControls && activeView.fields.hierarchyColorPropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.hierarchyColorPropertyId) :
        undefined

    const cfdProperty = withCFDControls && activeView.fields.cfdPropertyId ?
        board.cardProperties.find((p) => p.id === activeView.fields.cfdPropertyId) :
        undefined

    const [viewTitle, setViewTitle] = useState(activeView.title)

    useEffect(() => {
        setViewTitle(activeView.title)
    }, [activeView.title])

    const hasFilter = activeView.fields.filter && activeView.fields.filter.filters?.length > 0

    const isOnboardingBoard = props.board.title === OnboardingBoardTitle
    const onboardingTourStarted = useAppSelector(getOnboardingTourStarted)
    const onboardingTourCategory = useAppSelector(getOnboardingTourCategory)
    const onboardingTourStep = useAppSelector(getOnboardingTourStep)

    const currentCard = useAppSelector(getCurrentCard)
    const noCardOpen = !currentCard

    const showTourBaseCondition = isOnboardingBoard &&
        onboardingTourStarted &&
        noCardOpen &&
        onboardingTourCategory === TOUR_BOARD &&
        onboardingTourStep === BoardTourSteps.ADD_VIEW.toString()

    const [delayComplete, setDelayComplete] = useState(false)

    useEffect(() => {
        if (showTourBaseCondition) {
            setTimeout(() => {
                setDelayComplete(true)
            }, 800)
        }
    }, [showTourBaseCondition])

    useEffect(() => {
        if (!BoardTourSteps.SHARE_BOARD) {
            BoardTourSteps.SHARE_BOARD = 2
        }

        TourCategoriesMapToSteps[TOUR_BOARD] = BoardTourSteps
    }, [])

    const showAddViewTourStep = showTourBaseCondition && delayComplete

    return (
        <div className='ViewHeader'>
            <div className='viewSelector'>
                <Editable
                    value={viewTitle}
                    placeholderText='Untitled View'
                    onSave={(): void => {
                        mutator.changeBlockTitle(activeView.boardId, activeView.id, activeView.title, viewTitle)
                    }}
                    onCancel={(): void => {
                        setViewTitle(activeView.title)
                    }}
                    onChange={setViewTitle}
                    saveOnEsc={true}
                    readonly={props.readonly || !canEditBoardProperties}
                    spellCheck={true}
                    autoExpand={false}
                />
                {!props.readonly && (<div>
                    <MenuWrapper label={intl.formatMessage({id: 'ViewHeader.view-menu', defaultMessage: 'View menu'})}>
                        <IconButton icon={<DropdownIcon/>}/>
                        <ViewMenu
                            board={board}
                            activeView={activeView}
                            views={views}
                            readonly={props.readonly || !canEditBoardProperties}
                        />
                    </MenuWrapper>
                    {showAddViewTourStep && <AddViewTourStep/>}
                </div>)}

            </div>

            <div className='octo-spacer'/>

            {!props.readonly && canEditBoardProperties &&
            <>
                {/* Card properties — hidden on CFD because the chart's
                    bands are driven by the cfdPropertyId, not by the
                    visible-property list, and exposing the Properties
                    menu suggested a setting the user could change but
                    that did nothing on this view. */}

                {!withCFDControls && (
                    <ViewHeaderPropertiesMenu
                        properties={board.cardProperties}
                        activeView={activeView}
                    />
                )}

                {/* Group by */}

                {withGroupBy &&
                <ViewHeaderGroupByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    groupByProperty={groupByProperty}
                />}

                {/* Display by */}

                {withDisplayBy &&
                <ViewHeaderDisplayByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    dateDisplayPropertyName={dateDisplayProperty?.name}
                />}

                {withLinkedBy &&
                <ViewHeaderLinkedByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    linkedByPropertyName={linkedByProperty?.name}
                />}

                {withResourceBy &&
                <ViewHeaderResourceByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    resourcePropertyName={resourceProperty?.name}
                />}

                {withProgressAndColor &&
                <ViewHeaderProgressByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    progressPropertyName={progressProperty?.name}
                />}

                {withColorBy &&
                <ViewHeaderColorByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    colorPropertyName={colorProperty?.name}
                />}

                {withHierarchyControls &&
                <ViewHeaderHierarchyByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    hierarchyPropertyName={hierarchyProperty?.name}
                />}

                {withHierarchyControls &&
                <ViewHeaderHierarchyLayoutMenu
                    activeView={activeView}
                />}

                {withHierarchyControls &&
                <ViewHeaderHierarchyColorByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    hierarchyColorPropertyName={hierarchyColorProperty?.name}
                />}

                {withCFDControls &&
                <ViewHeaderCFDGroupByMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    cfdPropertyName={cfdProperty?.name}
                />}

                {withCFDControls &&
                <ViewHeaderCFDDateRangeMenu
                    activeView={activeView}
                />}

                {withCFDControls &&
                <ViewHeaderCFDStatesMenu
                    activeView={activeView}
                    cfdProperty={cfdProperty}
                />}

                {/* Filter */}

                <ModalWrapper>
                    <Button
                        active={hasFilter}
                        onClick={() => setShowFilter(!showFilter)}
                        onMouseOver={() => setLockFilterOnClose(true)}
                        onMouseLeave={() => setLockFilterOnClose(false)}
                    >
                        <FormattedMessage
                            id='ViewHeader.filter'
                            defaultMessage='Filter'
                        />
                    </Button>
                    {showFilter &&
                    <FilterComponent
                        board={board}
                        activeView={activeView}
                        onClose={() => {
                            if (!lockFilterOnClose) {
                                setShowFilter(false)
                            }
                        }}
                    />}
                </ModalWrapper>

                {/* Sort */}

                {withSortBy &&
                <ViewHeaderSortMenu
                    properties={board.cardProperties}
                    activeView={activeView}
                    orderedCards={cards}
                />
                }
            </>
            }

            {/* Search */}

            <ViewHeaderSearch/>

            {/* Options menu */}

            {!props.readonly &&
            <>
                <ViewHeaderActionsMenu
                    board={board}
                    activeView={activeView}
                    cards={cards}
                />

                {/* New card button */}

                {!isDashboard &&
                    <BoardPermissionGate permissions={[Permission.ManageBoardCards]}>
                        <NewCardButton
                            addCard={props.addCard}
                            addCardFromTemplate={props.addCardFromTemplate}
                            addCardTemplate={props.addCardTemplate}
                            editCardTemplate={props.editCardTemplate}
                        />
                    </BoardPermissionGate>
                }
            </>}
        </div>
    )
}

export default React.memo(ViewHeader)
