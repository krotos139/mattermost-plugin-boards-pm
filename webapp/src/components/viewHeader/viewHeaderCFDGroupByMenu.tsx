// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the CFD view's grouping property. Lists every
// select / multiSelect / person* property on the board so the user can
// pick what the chart bands represent.

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
    cfdPropertyName?: string
}

const isCFDProperty = (t: IPropertyTemplate): boolean => (
    t.type === 'select' ||
    t.type === 'multiSelect' ||
    t.type === 'person' ||
    t.type === 'multiPerson' ||
    t.type === 'personNotify' ||
    t.type === 'multiPersonNotify'
)

const ViewHeaderCFDGroupByMenu = (props: Props) => {
    const {properties, activeView, cfdPropertyName} = props
    const intl = useIntl()

    const cfdProperties = properties?.filter(isCFDProperty) || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.cfd-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.cfdPropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.cfd-by'
                    defaultMessage='Group by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='cfdByLabel'
                            >
                                {cfdPropertyName || noneLabel}
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
                        mutator.changeViewCFDPropertyId(activeView.boardId, activeView.id, currentId, undefined)
                    }}
                />
                {cfdProperties.map((p: IPropertyTemplate) => (
                    <Menu.Text
                        key={p.id}
                        id={p.id}
                        name={p.name}
                        rightIcon={currentId === p.id ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (currentId === id) {
                                return
                            }
                            mutator.changeViewCFDPropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {cfdProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-property'}
                        id={'__no-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.cfd-by-empty',
                            defaultMessage: 'No Select / Multi select / Person properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderCFDGroupByMenu)
