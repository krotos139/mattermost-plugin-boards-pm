// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {ContentBlock} from './contentBlock'
import {Block, createBlock} from './block'

type VideoBlockFields = {
    fileId: string
}

type VideoBlock = ContentBlock & {
    type: 'video'
    fields: VideoBlockFields
}

function createVideoBlock(block?: Block): VideoBlock {
    return {
        ...createBlock(block),
        type: 'video',
        fields: {
            fileId: block?.fields.fileId || block?.fields.attachmentId || '',
        },
    }
}

export {VideoBlock, createVideoBlock}
