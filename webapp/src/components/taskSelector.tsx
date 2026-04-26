// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Renders the Person/MultiPerson-style chip + dropdown for the `task` and
// `multiTask` property types. Picks options from the current board's cards
// (excluding the card the property lives on, to keep self-references out
// of the UI). Filtering is handled by react-select's async loadOptions.

import React, {useCallback, useMemo} from 'react'
import {useIntl} from 'react-intl'
import Select from 'react-select/async'
import {ActionMeta, MultiValue, SingleValue} from 'react-select'
import {CSSObject} from '@emotion/serialize'

import {getSelectBaseStyle} from '../theme'
import {Card} from '../blocks/card'
import {useAppSelector} from '../store/hooks'
import {getCurrentBoardCards} from '../store/cards'
import {PropertyType} from '../properties/types'

import './taskSelector.scss'

type Props = {
    readOnly: boolean
    cardIDs: string[]
    isMulti: boolean
    emptyDisplayValue: string
    closeMenuOnSelect?: boolean
    excludeCardId?: string
    property?: PropertyType
    onChange: (items: SingleValue<Card> | MultiValue<Card>, action: ActionMeta<Card>) => void
}

const selectStyles = {
    ...getSelectBaseStyle(),
    option: (provided: CSSObject, state: {isFocused: boolean}): CSSObject => ({
        ...provided,
        background: state.isFocused ? 'rgba(var(--center-channel-color-rgb), 0.1)' : 'rgb(var(--center-channel-bg-rgb))',
        color: 'rgb(var(--center-channel-color-rgb))',
        padding: '8px',
    }),
    control: (): CSSObject => ({
        border: 0,
        width: '100%',
        margin: '0',
    }),
    valueContainer: (provided: CSSObject): CSSObject => ({
        ...provided,
        padding: 'unset',
        overflow: 'unset',
    }),
    singleValue: (provided: CSSObject): CSSObject => ({
        ...provided,
        position: 'static',
        top: 'unset',
        transform: 'unset',
        color: 'rgb(var(--center-channel-color-rgb))',
    }),
    menu: (provided: CSSObject): CSSObject => ({
        ...provided,
        width: 'unset',
        background: 'rgb(var(--center-channel-bg-rgb))',
        minWidth: '260px',
    }),
}

const TaskSelector = (props: Props): JSX.Element => {
    const {readOnly, cardIDs, isMulti, emptyDisplayValue, excludeCardId, closeMenuOnSelect = true, onChange} = props
    const intl = useIntl()

    const boardCards = useAppSelector<Card[]>(getCurrentBoardCards)
    const cardsByID = useMemo(() => {
        const map: {[id: string]: Card} = {}
        for (const c of boardCards) {
            map[c.id] = c
        }
        return map
    }, [boardCards])

    // Resolve the selected IDs into Card objects. Unknown IDs (deleted cards
    // or cards not in the redux store) are still rendered so the user sees
    // "something is here" and can remove it.
    const selectedCards: Card[] = useMemo(() => (
        cardIDs.map((id) => cardsByID[id] || ({
            id,
            title: intl.formatMessage({id: 'TaskSelector.unknown', defaultMessage: '(deleted task)'}),
        } as Card))
    ), [cardIDs, cardsByID, intl])

    const formatOptionLabel = (card: Card): JSX.Element => {
        if (!card) {
            return <div/>
        }
        const icon = card.fields?.icon
        return (
            <div
                key={card.id}
                className={isMulti ? 'MultiTask-item' : 'Task-item'}
            >
                {icon && <span className='Task-item__icon'>{icon}</span>}
                <span className='Task-item__title'>
                    {card.title || intl.formatMessage({id: 'KanbanCard.untitled', defaultMessage: 'Untitled'})}
                </span>
            </div>
        )
    }

    const loadOptions = useCallback(async (value: string): Promise<Card[]> => {
        const filtered = boardCards.filter((c) => {
            if (excludeCardId && c.id === excludeCardId) {
                return false
            }
            if (!value) {
                return true
            }
            return (c.title || '').toLowerCase().includes(value.toLowerCase())
        })
        return filtered
    }, [boardCards, excludeCardId])

    let primaryClass = 'Task'
    if (isMulti) {
        primaryClass = 'MultiTask'
    }
    let secondaryClass = ''
    if (props.property) {
        secondaryClass = ` ${props.property.valueClassName(readOnly)}`
    }

    if (readOnly) {
        return (
            <div className={`${primaryClass}${secondaryClass}`}>
                {selectedCards.map((card) => formatOptionLabel(card))}
            </div>
        )
    }

    return (
        <Select
            loadOptions={loadOptions}
            isMulti={isMulti}
            defaultOptions={true}
            isSearchable={true}
            isClearable={true}
            backspaceRemovesValue={true}
            closeMenuOnSelect={closeMenuOnSelect}
            className={`${primaryClass}${secondaryClass}`}
            classNamePrefix={'react-select'}
            formatOptionLabel={formatOptionLabel}
            styles={selectStyles}
            placeholder={emptyDisplayValue}
            getOptionLabel={(c: Card) => c.title || ''}
            getOptionValue={(c: Card) => c.id}
            value={selectedCards}
            onChange={onChange}
        />
    )
}

export default TaskSelector
