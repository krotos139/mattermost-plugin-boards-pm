// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Gantt view's per-bar color source. Lists every
// select property on the board so the user can pick which one's chosen
// option color tints the bar. Mirrors "Display by" / "Linked by" /
// "Progress by".

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
    colorPropertyName?: string
}

const ViewHeaderColorByMenu = (props: Props) => {
    const {properties, activeView, colorPropertyName} = props
    const intl = useIntl()

    const selectProperties = properties?.filter((p: IPropertyTemplate) => p.type === 'select') || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.color-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.colorPropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.color-by'
                    defaultMessage='Color by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='colorByLabel'
                            >
                                {colorPropertyName || noneLabel}
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
                        mutator.changeViewColorPropertyId(activeView.boardId, activeView.id, currentId, undefined)
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
                            mutator.changeViewColorPropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {selectProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-select-property'}
                        id={'__no-select-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.color-by-empty',
                            defaultMessage: 'No select properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderColorByMenu)
