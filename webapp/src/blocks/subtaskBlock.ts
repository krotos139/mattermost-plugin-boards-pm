// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {ContentBlock} from './contentBlock'
import {Block, createBlock} from './block'

// SubtaskBlock — text + state. The state is the option id of the
// board-level select-property pointed to by board.fields.subtaskStatesPropertyId.
// The optionId can be empty (no state selected yet) or "orphaned" if the
// referenced option was deleted from the property — both cases are handled
// in the UI as "Unknown".
type SubtaskBlock = ContentBlock & {
    type: 'subtask'
    fields: {
        optionId?: string
    }
}

function createSubtaskBlock(block?: Block): SubtaskBlock {
    return {
        ...createBlock(block),
        type: 'subtask',
        fields: {
            optionId: block?.fields?.optionId || '',
        },
    }
}

export {SubtaskBlock, createSubtaskBlock}
