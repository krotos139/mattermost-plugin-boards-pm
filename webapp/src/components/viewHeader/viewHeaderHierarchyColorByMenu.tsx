// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Hierarchy view's node-tint property selector.
// Lists every select / multiSelect on the board so the user can pick which
// option-color drives the per-node background. Mirrors ViewHeaderColorByMenu
// (used by Timeline and Resource).

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
    hierarchyColorPropertyName?: string
}

const isSelectFamily = (t: IPropertyTemplate): boolean => (
    t.type === 'select' || t.type === 'multiSelect'
)

const ViewHeaderHierarchyColorByMenu = (props: Props) => {
    const {properties, activeView, hierarchyColorPropertyName} = props
    const intl = useIntl()

    const selectProperties = properties?.filter(isSelectFamily) || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.hierarchy-color-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.hierarchyColorPropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.hierarchy-color-by'
                    defaultMessage='Color by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='hierarchyColorByLabel'
                            >
                                {hierarchyColorPropertyName || noneLabel}
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
                        mutator.changeViewHierarchyColorPropertyId(activeView.boardId, activeView.id, currentId, undefined)
                    }}
                />
                {selectProperties.map((p: IPropertyTemplate) => (
                    <Menu.Text
                        key={p.id}
                        id={p.id}
                        name={p.name}
                        rightIcon={currentId === p.id ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (currentId === id) {
                                return
                            }
                            mutator.changeViewHierarchyColorPropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {selectProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-select-property'}
                        id={'__no-select-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.hierarchy-color-by-empty',
                            defaultMessage: 'No select properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderHierarchyColorByMenu)
