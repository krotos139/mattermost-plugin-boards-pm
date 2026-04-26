// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useCallback} from 'react'
import {useIntl} from 'react-intl'
import {ActionMeta, MultiValue, SingleValue} from 'react-select'

import {Card} from '../../blocks/card'
import mutator from '../../mutator'
import {PropertyProps} from '../types'
import TaskSelector from '../../components/taskSelector'

const ConfirmTask = (props: PropertyProps): JSX.Element => {
    const {card, board, propertyTemplate, propertyValue, property, readOnly} = props
    const intl = useIntl()

    const isMulti = propertyTemplate.type === 'multiTask'
    const changePropertyValue = useCallback(
        (newValue: string | string[]) => mutator.changePropertyValue(board.id, card, propertyTemplate.id, newValue),
        [board.id, card, propertyTemplate.id],
    )

    let cardIDs: string[] = []
    if (typeof propertyValue === 'string' && propertyValue !== '') {
        cardIDs = [propertyValue]
    } else if (Array.isArray(propertyValue) && propertyValue.length > 0) {
        cardIDs = propertyValue
    }

    const onChange = (items: SingleValue<Card> | MultiValue<Card>, action: ActionMeta<Card>) => {
        if (Array.isArray(items)) {
            if (action.action === 'select-option') {
                changePropertyValue(items.map((c) => c.id))
            } else if (action.action === 'clear') {
                changePropertyValue([])
            } else if (action.action === 'remove-value') {
                const removedId = action.removedValue?.id
                changePropertyValue(items.filter((c) => c.id !== removedId).map((c) => c.id))
            }
        } else {
            const single = items as Card | null
            if (action.action === 'select-option') {
                changePropertyValue(single?.id || '')
            } else if (action.action === 'clear') {
                changePropertyValue('')
            }
        }
    }

    const emptyDisplayValue = props.showEmptyPlaceholder ?
        intl.formatMessage({id: 'ConfirmTask.empty', defaultMessage: 'Empty'}) :
        ''

    return (
        <TaskSelector
            cardIDs={cardIDs}
            isMulti={isMulti}
            readOnly={readOnly}
            emptyDisplayValue={emptyDisplayValue}
            excludeCardId={card.id}
            property={property}
            onChange={onChange}
        />
    )
}

export default ConfirmTask
