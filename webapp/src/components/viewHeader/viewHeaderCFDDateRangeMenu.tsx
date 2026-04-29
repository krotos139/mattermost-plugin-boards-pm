// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the CFD view's date-range selector. Picks the
// rolling window the chart computes counts over. "All" defers to the
// earliest history row; "Custom" is a placeholder slot for the date-
// pickers we'd add later — for now the user can land on it but it
// effectively behaves like "All" without explicit from/to fields wired
// to a calendar UI.

import React from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import {BoardView, CFDDateRange} from '../../blocks/boardView'
import mutator from '../../mutator'
import Button from '../../widgets/buttons/button'
import Menu from '../../widgets/menu'
import MenuWrapper from '../../widgets/menuWrapper'
import CheckIcon from '../../widgets/icons/check'

type Props = {
    activeView: BoardView
}

const RANGES: {key: CFDDateRange; messageId: string; defaultLabel: string}[] = [
    {key: 'last7', messageId: 'ViewHeader.cfd-range-last7', defaultLabel: 'Last 7 days'},
    {key: 'last30', messageId: 'ViewHeader.cfd-range-last30', defaultLabel: 'Last 30 days'},
    {key: 'last90', messageId: 'ViewHeader.cfd-range-last90', defaultLabel: 'Last 90 days'},
    {key: 'last365', messageId: 'ViewHeader.cfd-range-last365', defaultLabel: 'Last 365 days'},
    {key: 'all', messageId: 'ViewHeader.cfd-range-all', defaultLabel: 'All time'},
]

const ViewHeaderCFDDateRangeMenu = (props: Props) => {
    const {activeView} = props
    const intl = useIntl()

    const current = activeView.fields.cfdDateRange || 'last30'
    const currentLabel = RANGES.find((r) => r.key === current)?.defaultLabel || 'Last 30 days'

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.cfd-range'
                    defaultMessage='Date range: {range}'
                    values={{
                        range: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='cfdRangeLabel'
                            >
                                {intl.formatMessage({
                                    id: `ViewHeader.cfd-range-${current}`,
                                    defaultMessage: currentLabel,
                                })}
                            </span>
                        ),
                    }}
                />
            </Button>
            <Menu>
                {RANGES.map((r) => (
                    <Menu.Text
                        key={r.key}
                        id={r.key}
                        name={intl.formatMessage({id: r.messageId, defaultMessage: r.defaultLabel})}
                        rightIcon={current === r.key ? <CheckIcon/> : undefined}
                        onClick={(id) => {
                            if (current === id) {
                                return
                            }
                            mutator.changeViewCFDDateRange(activeView.boardId, activeView.id, current, id)
                        }}
                    />
                ))}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderCFDDateRangeMenu)
