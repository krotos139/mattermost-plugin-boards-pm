// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Gantt view's dependency property selector. Lists
// every task / multiTask property on the board so the user can choose
// which one frappe-gantt should draw arrows along, mirroring the UX of
// "Display by" for the date property.

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
    linkedByPropertyName?: string
}

const isTaskRefProperty = (t: IPropertyTemplate): boolean => (
    t.type === 'task' || t.type === 'multiTask'
)

const ViewHeaderLinkedByMenu = (props: Props) => {
    const {properties, activeView, linkedByPropertyName} = props
    const intl = useIntl()

    const taskProperties = properties?.filter(isTaskRefProperty) || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.linked-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.linkedByPropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.linked-by'
                    defaultMessage='Linked by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='linkedByLabel'
                            >
                                {linkedByPropertyName || noneLabel}
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
                        mutator.changeViewLinkedByPropertyId(activeView.boardId, activeView.id, currentId, undefined)
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
                            mutator.changeViewLinkedByPropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {taskProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-task-property'}
                        id={'__no-task-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.linked-by-empty',
                            defaultMessage: 'No task properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderLinkedByMenu)
