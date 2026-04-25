// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react'
import {useIntl, IntlShape} from 'react-intl'

import Menu from '../widgets/menu'
import propsRegistry from '../properties'
import {PropertyType} from '../properties/types'
import './propertyMenu.scss'

type Props = {
    propertyId: string
    propertyName: string
    propertyType: PropertyType
    notifyOffsetMinutes?: number
    onTypeAndNameChanged: (newType: PropertyType, newName: string) => void
    onNotifyOffsetChanged?: (minutes: number) => void
    onDelete: (id: string) => void
}

// Notify-before presets used for deadline properties. Values are in minutes.
const notifyOffsetPresets: {minutes: number; labelId: string; defaultLabel: string}[] = [
    {minutes: 60, labelId: 'PropertyMenu.notifyOffset.1h', defaultLabel: '1 hour before'},
    {minutes: 360, labelId: 'PropertyMenu.notifyOffset.6h', defaultLabel: '6 hours before'},
    {minutes: 1440, labelId: 'PropertyMenu.notifyOffset.1d', defaultLabel: '1 day before'},
    {minutes: 2880, labelId: 'PropertyMenu.notifyOffset.2d', defaultLabel: '2 days before'},
    {minutes: 10080, labelId: 'PropertyMenu.notifyOffset.1w', defaultLabel: '1 week before'},
]

// Default offset when a deadline property has none set yet.
export const defaultNotifyOffsetMinutes = 1440

function notifyOffsetMenuTitle(intl: IntlShape, minutes: number | undefined): string {
    const effective = minutes ?? defaultNotifyOffsetMinutes
    const preset = notifyOffsetPresets.find((p) => p.minutes === effective)
    const label = preset
        ? intl.formatMessage({id: preset.labelId, defaultMessage: preset.defaultLabel})
        : intl.formatMessage({id: 'PropertyMenu.notifyOffset.custom', defaultMessage: '{minutes} minutes before'}, {minutes: effective})
    return `${intl.formatMessage({id: 'PropertyMenu.notifyOffsetTitle', defaultMessage: 'Notify'})}: ${label}`
}

function typeMenuTitle(intl: IntlShape, type: PropertyType): string {
    return `${intl.formatMessage({id: 'PropertyMenu.typeTitle', defaultMessage: 'Type'})}: ${type.displayName(intl)}`
}

type TypesProps = {
    label: string
    onTypeSelected: (type: PropertyType) => void
}

export const PropertyTypes = (props: TypesProps): JSX.Element => {
    const intl = useIntl()
    return (
        <>
            <Menu.Label>
                <b>{props.label}</b>
            </Menu.Label>

            <Menu.Separator/>

            {
                propsRegistry.list().map((p) => (
                    <Menu.Text
                        key={p.type}
                        id={p.type}
                        name={p.displayName(intl)}
                        onClick={() => props.onTypeSelected(p)}
                    />
                ))
            }
        </>
    )
}

const PropertyMenu = (props: Props) => {
    const intl = useIntl()
    let currentPropertyName = props.propertyName

    const deleteText = intl.formatMessage({
        id: 'PropertyMenu.Delete',
        defaultMessage: 'Delete',
    })

    return (
        <Menu>
            <Menu.TextInput
                initialValue={props.propertyName}
                onConfirmValue={(n) => {
                    props.onTypeAndNameChanged(props.propertyType, n)
                    currentPropertyName = n
                }}
                onValueChanged={(n) => {
                    currentPropertyName = n
                }}
            />
            <Menu.SubMenu
                id='type'
                name={typeMenuTitle(intl, props.propertyType)}
            >
                <PropertyTypes
                    label={intl.formatMessage({id: 'PropertyMenu.changeType', defaultMessage: 'Change property type'})}
                    onTypeSelected={(type: PropertyType) => props.onTypeAndNameChanged(type, currentPropertyName)}
                />
            </Menu.SubMenu>
            {props.propertyType.type === 'deadline' && props.onNotifyOffsetChanged &&
                <Menu.SubMenu
                    id='notifyOffset'
                    name={notifyOffsetMenuTitle(intl, props.notifyOffsetMinutes)}
                >
                    {notifyOffsetPresets.map((p) => (
                        <Menu.Text
                            key={p.minutes}
                            id={`notifyOffset-${p.minutes}`}
                            name={intl.formatMessage({id: p.labelId, defaultMessage: p.defaultLabel})}
                            onClick={() => props.onNotifyOffsetChanged && props.onNotifyOffsetChanged(p.minutes)}
                        />
                    ))}
                </Menu.SubMenu>
            }
            <Menu.Text
                id='delete'
                name={deleteText}
                onClick={() => props.onDelete(props.propertyId)}
            />
        </Menu>
    )
}

export default React.memo(PropertyMenu)
