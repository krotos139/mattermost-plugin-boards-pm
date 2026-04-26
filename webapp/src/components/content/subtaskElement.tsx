// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useRef, useState} from 'react'
import {useIntl} from 'react-intl'

import {createSubtaskBlock} from '../../blocks/subtaskBlock'
import {ContentBlock} from '../../blocks/contentBlock'
import {IPropertyOption} from '../../blocks/board'
import CheckIcon from '../../widgets/icons/check'
import Label from '../../widgets/label'
import Menu from '../../widgets/menu'
import MenuWrapper from '../../widgets/menuWrapper'
import mutator from '../../mutator'
import Editable, {Focusable} from '../../widgets/editable'
import {useAppSelector} from '../../store/hooks'
import {getCurrentBoard} from '../../store/boards'
import {useCardDetailContext} from '../cardDetail/cardDetailContext'

import './subtaskElement.scss'

import {contentRegistry} from './contentRegistry'

type Props = {
    block: ContentBlock
    readonly: boolean
    onAddElement?: () => void
    onDeleteElement?: () => void
}

const SubtaskElement = (props: Props) => {
    const {block, readonly} = props
    const intl = useIntl()
    const titleRef = useRef<Focusable>(null)
    const cardDetail = useCardDetailContext()
    const [addedBlockId, setAddedBlockId] = useState(cardDetail.lastAddedBlock.id)
    const [title, setTitle] = useState(block.title)
    const board = useAppSelector(getCurrentBoard)

    useEffect(() => {
        if (block.id === addedBlockId) {
            titleRef.current?.focus()
            setAddedBlockId('')
        }
    }, [block, addedBlockId, titleRef])

    // Resolve the board-level select-property whose options drive subtask
    // states. If unset / missing / not a select, the block falls back to a
    // placeholder telling the user to configure it via board settings.
    const propId = (board?.properties as Record<string, string|undefined> | undefined)?.subtaskStatesPropertyId
    const statesProperty = propId ? board?.cardProperties.find((p) => p.id === propId) : undefined
    const isConfigured = Boolean(statesProperty && statesProperty.type === 'select')
    const options: IPropertyOption[] = isConfigured ? (statesProperty?.options || []) : []

    const optionId = (block.fields?.optionId as string|undefined) || ''
    const selectedOption = optionId ? options.find((o) => o.id === optionId) : undefined

    const placeholderUnconfigured = intl.formatMessage({id: 'Subtask.unconfigured', defaultMessage: 'Configure subtasks property in board settings'})
    const placeholderEmpty = intl.formatMessage({id: 'Subtask.selectState', defaultMessage: 'Select state'})
    const unknownLabel = intl.formatMessage({id: 'Subtask.unknownOption', defaultMessage: 'Unknown'})

    const onPickOption = (newOptionId: string) => {
        if (newOptionId === optionId) {
            return
        }
        const newBlock = createSubtaskBlock(block)
        newBlock.fields.optionId = newOptionId
        newBlock.title = title
        mutator.updateBlock(block.boardId, newBlock, block, intl.formatMessage({id: 'ContentBlock.editCardSubtaskState', defaultMessage: 'changed subtask state'}))
    }

    let stateChip: JSX.Element
    if (!isConfigured) {
        stateChip = (
            <Label color={'empty'}>
                <span className='Label-text'>{placeholderUnconfigured}</span>
            </Label>
        )
    } else if (selectedOption) {
        stateChip = (
            <Label color={selectedOption.color}>
                <span className='Label-text'>{selectedOption.value}</span>
            </Label>
        )
    } else if (optionId) {
        stateChip = (
            <Label color={'empty'}>
                <span className='Label-text'>{unknownLabel}</span>
            </Label>
        )
    } else {
        stateChip = (
            <Label color={'empty'}>
                <span className='Label-text'>{placeholderEmpty}</span>
            </Label>
        )
    }

    const stateNode = isConfigured && !readonly ? (
        <MenuWrapper>
            <div className='SubtaskElement__state'>{stateChip}</div>
            <Menu position='bottom'>
                <Menu.Text
                    key={'__none'}
                    id={'__none'}
                    name={intl.formatMessage({id: 'Subtask.clearState', defaultMessage: 'Clear'})}
                    rightIcon={!optionId ? <CheckIcon/> : undefined}
                    onClick={() => onPickOption('')}
                />
                {options.length > 0 && <Menu.Separator/>}
                {options.map((opt) => (
                    <Menu.Text
                        key={opt.id}
                        id={opt.id}
                        name={opt.value}
                        rightIcon={optionId === opt.id ? <CheckIcon/> : undefined}
                        onClick={(id) => onPickOption(id)}
                    />
                ))}
                {options.length === 0 && (
                    <Menu.Text
                        key={'__no-options'}
                        id={'__no-options'}
                        name={intl.formatMessage({id: 'Subtask.noOptions', defaultMessage: 'No states defined on the property'})}
                        onClick={() => {}}
                    />
                )}
            </Menu>
        </MenuWrapper>
    ) : (
        <div className='SubtaskElement__state SubtaskElement__state--readonly'>{stateChip}</div>
    )

    return (
        <div className='SubtaskElement'>
            {stateNode}
            <Editable
                ref={titleRef}
                value={title}
                placeholderText={intl.formatMessage({id: 'ContentBlock.editText', defaultMessage: 'Edit text...'})}
                onChange={setTitle}
                saveOnEsc={true}
                onSave={async (saveType) => {
                    const {lastAddedBlock} = cardDetail
                    if (title === '' && block.id === lastAddedBlock.id && lastAddedBlock.autoAdded && props.onDeleteElement) {
                        props.onDeleteElement()
                        return
                    }

                    if (block.title !== title) {
                        await mutator.changeBlockTitle(block.boardId, block.id, block.title, title, intl.formatMessage({id: 'ContentBlock.editCardSubtaskText', defaultMessage: 'edit subtask text'}))
                        if (saveType === 'onEnter' && title !== '' && props.onAddElement) {
                            setTimeout(props.onAddElement, 100)
                        }
                        return
                    }

                    if (saveType === 'onEnter' && title !== '' && props.onAddElement) {
                        props.onAddElement()
                    }
                }}
                readonly={readonly}
                spellCheck={true}
            />
        </div>
    )
}

contentRegistry.registerContentType({
    type: 'subtask',
    getDisplayText: (intl) => intl.formatMessage({id: 'ContentBlock.subtask', defaultMessage: 'subtask'}),
    getIcon: () => <CheckIcon/>,
    createBlock: async () => {
        return createSubtaskBlock()
    },
    createComponent: (block, readonly, onAddElement, onDeleteElement) => {
        return (
            <SubtaskElement
                block={block}
                readonly={readonly}
                onAddElement={onAddElement}
                onDeleteElement={onDeleteElement}
            />
        )
    },
})

export default React.memo(SubtaskElement)
