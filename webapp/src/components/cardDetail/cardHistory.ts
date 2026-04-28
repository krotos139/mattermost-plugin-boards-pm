// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Mirrors server/model/cardhistory.go. Sent chronologically (oldest first)
// and capped at 100 most-recent events by the backend.
export type HistoryEventKind =
    | 'card-created'
    | 'title'
    | 'icon'
    | 'property'
    | 'desc-added'
    | 'desc-edited'
    | 'desc-removed'
    | 'comment-added'
    | 'comment-edited'
    | 'comment-removed'
    | 'subtask-state'

export type CardHistoryEvent = {
    timestamp: number
    userId: string
    kind: HistoryEventKind
    propertyId?: string
    propertyName?: string
    propertyType?: string
    blockId?: string
    blockType?: string
    before?: string
    after?: string
}
