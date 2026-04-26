// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Gantt view's per-bar progress source. Lists every
// number property on the board so the user can pick which one frappe-gantt
// fills the bars from. Mirrors the pattern of "Display by" / "Linked by".

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
    progressPropertyName?: string
}

const ViewHeaderProgressByMenu = (props: Props) => {
    const {properties, activeView, progressPropertyName} = props
    const intl = useIntl()

    const numberProperties = properties?.filter((p: IPropertyTemplate) => p.type === 'number') || []
    const noneLabel = intl.formatMessage({id: 'ViewHeader.progress-by-none', defaultMessage: 'None'})
    const currentId = activeView.fields.progressPropertyId

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.progress-by'
                    defaultMessage='Progress by: {property}'
                    values={{
                        property: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='progressByLabel'
                            >
                                {progressPropertyName || noneLabel}
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
                        mutator.changeViewProgressPropertyId(activeView.boardId, activeView.id, currentId, undefined)
                    }}
                />
                {numberProperties.map((p: IPropertyTemplate) => (
                    <Menu.Text
                        key={p.id}
                        id={p.id}
                        name={p.name}
                        rightIcon={currentId === p.id ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (currentId === id) {
                                return
                            }
                            mutator.changeViewProgressPropertyId(activeView.boardId, activeView.id, currentId, id)
                        }}
                    />
                ))}
                {numberProperties.length === 0 && (
                    <Menu.Text
                        key={'__no-number-property'}
                        id={'__no-number-property'}
                        name={intl.formatMessage({
                            id: 'ViewHeader.progress-by-empty',
                            defaultMessage: 'No number properties on this board',
                        })}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderProgressByMenu)
