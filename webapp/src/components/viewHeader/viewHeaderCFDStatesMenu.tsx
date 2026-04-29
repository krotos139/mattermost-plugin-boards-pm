// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Header control for the CFD view's per-state visibility filter. Lists
// the options of the currently-grouped property as a checkable menu —
// the user toggles which states should appear as bands in the chart.
// Most common use: hide the "Done" / "Completed" state so the chart
// focuses on active work instead of the (typically) ever-growing pile
// of finished cards at the top of the stack.
//
// Person / multiPerson properties have no static option list (the band
// keys are user ids drawn from card history), so the menu only offers
// the "(no value)" toggle in those cases. Per-user hide is still
// reachable through the chart's legend (clicking a legend item toggles
// that band).

import React from 'react'
import {FormattedMessage, useIntl} from 'react-intl'

import {IPropertyTemplate, IPropertyOption} from '../../blocks/board'
import {BoardView} from '../../blocks/boardView'
import mutator from '../../mutator'
import Button from '../../widgets/buttons/button'
import Menu from '../../widgets/menu'
import MenuWrapper from '../../widgets/menuWrapper'
import CheckIcon from '../../widgets/icons/check'

type Props = {
    activeView: BoardView
    cfdProperty?: IPropertyTemplate
}

// Synthetic key used by the server for cards without a value for the
// chosen property — keep in sync with `noneSeriesKey` on the server.
const NO_VALUE_KEY = '__none'

const ViewHeaderCFDStatesMenu = (props: Props) => {
    const {activeView, cfdProperty} = props
    const intl = useIntl()

    const hidden = activeView.fields.cfdHiddenSeriesKeys || []

    // Disable the menu when there's no CFD property selected; without
    // one the chart shows the "pick a property" placeholder anyway.
    if (!cfdProperty) {
        return null
    }

    const isSelectLike = cfdProperty.type === 'select' || cfdProperty.type === 'multiSelect'
    const options: IPropertyOption[] = isSelectLike ? (cfdProperty.options || []) : []
    const totalKnown = options.length + 1 // options + "(no value)"
    const visibleCount = totalKnown - hidden.length
    const noneLabel = intl.formatMessage({id: 'ViewHeader.cfd-states-no-value', defaultMessage: '(no value)'})

    const toggle = (key: string) => {
        const isHidden = hidden.includes(key)
        const next = isHidden ? hidden.filter((k) => k !== key) : [...hidden, key]
        mutator.changeViewCFDHiddenSeriesKeys(activeView.boardId, activeView.id, hidden, next)
    }

    const showAll = () => {
        if (hidden.length === 0) {
            return
        }
        mutator.changeViewCFDHiddenSeriesKeys(activeView.boardId, activeView.id, hidden, undefined)
    }

    return (
        <MenuWrapper>
            <Button>
                <FormattedMessage
                    id='ViewHeader.cfd-states'
                    defaultMessage='States: {visible}'
                    values={{
                        visible: (
                            <span
                                style={{color: 'rgb(var(--center-channel-color-rgb))'}}
                                id='cfdStatesLabel'
                            >
                                {isSelectLike ? `${visibleCount}/${totalKnown}` : (hidden.includes(NO_VALUE_KEY) ? '(no value hidden)' : 'all')}
                            </span>
                        ),
                    }}
                />
            </Button>
            <Menu>
                {isSelectLike && options.map((opt) => {
                    const isVisible = !hidden.includes(opt.id)
                    return (
                        <Menu.Text
                            key={opt.id}
                            id={opt.id}
                            name={opt.value}
                            rightIcon={isVisible ? <CheckIcon/> : undefined}
                            onClick={() => toggle(opt.id)}
                        />
                    )
                })}
                <Menu.Text
                    key={NO_VALUE_KEY}
                    id={NO_VALUE_KEY}
                    name={noneLabel}
                    rightIcon={!hidden.includes(NO_VALUE_KEY) ? <CheckIcon/> : undefined}
                    onClick={() => toggle(NO_VALUE_KEY)}
                />
                {hidden.length > 0 && (
                    <>
                        <Menu.Separator/>
                        <Menu.Text
                            key={'__show_all'}
                            id={'__show_all'}
                            name={intl.formatMessage({id: 'ViewHeader.cfd-states-show-all', defaultMessage: 'Show all'})}
                            onClick={showAll}
                        />
                    </>
                )}
            </Menu>
        </MenuWrapper>
    )
}

export default React.memo(ViewHeaderCFDStatesMenu)
