// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Wire types for the CFD endpoint. The shape mirrors server/model/cfd.go;
// keep them in lockstep when changing field names.

export type CFDSeries = {
    key: string
    label: string
    color: string
}

export type CFDResult = {
    from: number
    to: number
    bucket: 'day'
    propertyId: string
    propertyType: string
    series: CFDSeries[]
    dates: number[]
    values: number[][]
}
