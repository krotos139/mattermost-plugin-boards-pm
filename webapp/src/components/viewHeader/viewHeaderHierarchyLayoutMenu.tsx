// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the Hierarchy view's layout-direction selector. Wraps
// dagre's `rankdir` option (TB / LR / BT / RL). Default is TB which mirrors
// the PERT examples in the design doc.

import React from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import {BoardView, HierarchyLayout} from '../../blocks/boardView'
import mutator from '../../mutator'
import Button from '../../widgets/buttons/button'
import Menu from '../../widgets/menu'
import MenuWrapper from '../../widgets/menuWrapper'
import CheckIcon from '../../widgets/icons/check'

type Props = {
    activeView: BoardView
}

const layouts: {id: HierarchyLayout; messageId: string; defaultMessage: string}[] = [
    {id: 'TB', messageId: 'ViewHeader.hierarchy-layout-tb', defaultMessage: 'Top to bottom'},
    {id: 'LR', messageId: 'ViewHeader.hierarchy-layout-lr', defaultMessage: 'Left to right'},
    {id: 'BT', messageId: 'ViewHeader.hierarchy-layout-bt', defaultMessage: 'Bottom to top'},
    {id: 'RL', messageId: 'ViewHeader.hierarchy-layout-rl', defaultMessage: 'Right to left'},
]

const ViewHeaderHierarchyLayoutMenu = (props: Props) => {
    const {activeView} = props
    const intl = useIntl()
    const current: HierarchyLayout = activeView.fields.hierarchyLayout || 'TB'
    const currentEntry = layouts.find((l) => l.id === current) || layouts[0]
    const currentLabel = intl.formatMessage({id: currentEntry.messageId, defaultMessage: currentEntry.defaultMessage})

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.hierarchy-layout'
                    defaultMessage='Layout: {layout}'
                    values={{
                        layout: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='hierarchyLayoutLabel'
                            >
                                {currentLabel}
                            </span>
                        ),
                    }}
                />
            </Button>
            <Menu>
                {layouts.map((l) => (
                    <Menu.Text
                        key={l.id}
                        id={l.id}
                        name={intl.formatMessage({id: l.messageId, defaultMessage: l.defaultMessage})}
                        rightIcon={current === l.id ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (current === id) {
                                return
                            }
                            mutator.changeViewHierarchyLayout(activeView.boardId, activeView.id, current, id as HierarchyLayout)
                        }}
                    />
                ))}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderHierarchyLayoutMenu)
