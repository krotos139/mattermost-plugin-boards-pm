// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Hierarchy view's parent-link property selector.
// Lists every Task / Multi task property on the board so the user can pick
// which relation drives the tree (parent → child edges in the DAG).

import React from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import {IPropertyTemplate} from '../../blocks/board'
import {BoardView} from '../../blocks/boardView'
import mutator from '../../mutator'
import Button from '../../widgets/buttons/button'
import Menu from '../../widgets/menu'
import MenuWrapper from '../../widgets/menuWrapper'
import CheckIcon from '../../widgets/icons/check'

type Props = {
    properties: readonly IPropertyTemplate[]
    activeView: BoardView
    hierarchyPropertyName?: string
}

const isTaskRefProperty = (t: IPropertyTemplate): boolean => (
    t.type === 'task' || t.type === 'multiTask'
)

const ViewHeaderHierarchyByMenu = (props: Props) => {
    const {properties, activeView, hierarchyPropertyName} = props
    const intl = useIntl()

    const taskProperties = properties?.filter(isTaskRefProperty) || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.hierarchy-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.hierarchyPropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.hierarchy-by'
                    defaultMessage='Hierarchy by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='hierarchyByLabel'
                            >
                                {hierarchyPropertyName || noneLabel}
                            </span>
                        ),
                    }}
                />
            </Button>
            <Menu>
                <Menu.Text
                    key={'__none'}
                    id={'__none'}
                    name={noneLabel}
                    rightIcon={!currentId ? <CheckIcon/> : undefined}
                    onClick={() => {
                        if (!currentId) {
                            return
                        }
                        mutator.changeViewHierarchyPropertyId(activeView.boardId, activeView.id, currentId, undefined)
                    }}
                />
                {taskProperties.map((p: IPropertyTemplate) => (
                    <Menu.Text
                        key={p.id}
                        id={p.id}
                        name={p.name}
                        rightIcon={currentId === p.id ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (currentId === id) {
                                return
                            }
                            mutator.changeViewHierarchyPropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {taskProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-task-property'}
                        id={'__no-task-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.hierarchy-by-empty',
                            defaultMessage: 'No Task / Multi task properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderHierarchyByMenu)
