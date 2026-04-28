// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Resource view's row-grouping property selector.
// Lists every person / multiPerson (and the personNotify variants we use as
// alias types) on the board so the user can pick which property's values
// drive the swim-lane rows. Mirrors the UX of "Linked by" / "Display by"
// for consistency.

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
    resourcePropertyName?: string
}

// Keep this list in sync with the resource-extraction logic in
// resourceView.tsx — every type whose value can be used as a swim-lane
// key must appear here. Person-flavoured properties give user ids;
// select / multiSelect give option ids (useful for non-human resources
// like equipment / stations / rooms — anything you want to plan time
// against). createdBy / updatedBy are listed as read-only sources:
// the view groups by them, but drag-to-reassign is suppressed.
const isResourceProperty = (t: IPropertyTemplate): boolean => (
    t.type === 'person' ||
    t.type === 'multiPerson' ||
    t.type === 'personNotify' ||
    t.type === 'multiPersonNotify' ||
    t.type === 'createdBy' ||
    t.type === 'updatedBy' ||
    t.type === 'select' ||
    t.type === 'multiSelect'
)

const ViewHeaderResourceByMenu = (props: Props) => {
    const {properties, activeView, resourcePropertyName} = props
    const intl = useIntl()

    const resourceProperties = properties?.filter(isResourceProperty) || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.resource-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.resourcePropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.resource-by'
                    defaultMessage='Resources by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='resourceByLabel'
                            >
                                {resourcePropertyName || noneLabel}
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
                        mutator.changeViewResourcePropertyId(activeView.boardId, activeView.id, currentId, undefined)
                    }}
                />
                {resourceProperties.map((p: IPropertyTemplate) => (
                    <Menu.Text
                        key={p.id}
                        id={p.id}
                        name={p.name}
                        rightIcon={currentId === p.id ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (currentId === id) {
                                return
                            }
                            mutator.changeViewResourcePropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {resourceProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-resource-property'}
                        id={'__no-resource-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.resource-by-empty',
                            defaultMessage: 'No person or select properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderResourceByMenu)
