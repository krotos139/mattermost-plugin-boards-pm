// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.


import {useEffect, useCallback} from 'react'
import {useIntl} from 'react-intl'

import {ImageBlock, createImageBlock} from '../../blocks/imageBlock'
import {VideoBlock, createVideoBlock} from '../../blocks/videoBlock'
import {AttachmentBlock, createAttachmentBlock} from '../../blocks/attachmentBlock'
import {sendFlashMessage} from '../flashMessages'
import {Block} from '../../blocks/block'
import octoClient from '../../octoClient'
import mutator from '../../mutator'

// useFilePaste handles drag-drop and clipboard paste of files into the card.
// MIME-based routing:
//   image/* → image block (rendered inline in the card body, in contentOrder)
//   video/* → video block (rendered inline as a player, in contentOrder)
//   *       → attachment block (rendered in the Attachment list, NOT in
//             contentOrder — adding it there fires "ContentElement, unknown
//             content type: attachment" because attachment has no
//             contentRegistry handler).
export default function useFilePaste(boardId: string, cardId: string, contentOrder: Array<string | string[]>): void {
    const intl = useIntl()
    const uploadItems = useCallback(async (items: FileList) => {
        if (!items.length) {
            return
        }

        type Pending = {file: File; kind: 'image' | 'video' | 'attachment'; promise: Promise<string|undefined>}
        const pending: Pending[] = []
        for (const file of items) {
            const t = (file.type || '').toLowerCase()
            let kind: 'image' | 'video' | 'attachment' = 'attachment'
            if (t.indexOf('image/') === 0) {
                kind = 'image'
            } else if (t.indexOf('video/') === 0) {
                kind = 'video'
            }
            pending.push({file, kind, promise: octoClient.uploadFile(boardId, file)})
        }

        const results = await Promise.all(pending.map((p) => p.promise))
        const inlineBlocks: Block[] = []      // image / video → into contentOrder
        const attachmentBlocks: Block[] = []  // generic attachment → no contentOrder
        let someFailed = false
        for (let i = 0; i < pending.length; i++) {
            const fileId = results[i]
            if (!fileId) {
                someFailed = true
                continue
            }
            const p = pending[i]
            if (p.kind === 'image') {
                const b: ImageBlock = createImageBlock()
                b.parentId = cardId
                b.boardId = boardId
                b.fields.fileId = fileId
                b.title = p.file.name
                inlineBlocks.push(b)
            } else if (p.kind === 'video') {
                const b: VideoBlock = createVideoBlock()
                b.parentId = cardId
                b.boardId = boardId
                b.fields.fileId = fileId
                b.title = p.file.name
                inlineBlocks.push(b)
            } else {
                const b: AttachmentBlock = createAttachmentBlock()
                b.parentId = cardId
                b.boardId = boardId
                b.fields.fileId = fileId
                b.title = p.file.name
                attachmentBlocks.push(b)
            }
        }

        if (someFailed) {
            sendFlashMessage({content: intl.formatMessage({id: 'imagePaste.upload-failed', defaultMessage: 'Some files not uploaded. File size limit reached'}), severity: 'normal'})
        }

        // Inline blocks: bulk-insert and patch contentOrder atomically so
        // they show up in the right place in the card body.
        if (inlineBlocks.length > 0) {
            const afterRedo = async (newBlocks: Block[]) => {
                const newContentOrder = JSON.parse(JSON.stringify(contentOrder))
                newContentOrder.push(...newBlocks.map((b: Block) => b.id))
                await octoClient.patchBlock(boardId, cardId, {updatedFields: {contentOrder: newContentOrder}})
            }
            const beforeUndo = async () => {
                const newContentOrder = JSON.parse(JSON.stringify(contentOrder))
                await octoClient.patchBlock(boardId, cardId, {updatedFields: {contentOrder: newContentOrder}})
            }
            await mutator.insertBlocks(boardId, inlineBlocks, 'pasted media', afterRedo, beforeUndo)
        }

        // Attachment blocks: insert one-by-one without touching contentOrder.
        // The AttachmentList component picks them up via the attachments
        // store selector (filters by block.type === 'attachment'), no need
        // for contentOrder participation.
        for (const block of attachmentBlocks) {
            await mutator.insertBlock(boardId, block, 'add attachment')
        }
    }, [cardId, contentOrder, boardId])

    const onDrop = useCallback((event: DragEvent): void => {
        if (event.dataTransfer && event.dataTransfer.files.length > 0) {
            event.preventDefault()
            uploadItems(event.dataTransfer.files)
        }
    }, [uploadItems])

    const onDragOver = useCallback((event: DragEvent): void => {
        // Allow drop by preventing the browser default (which is to navigate to the file).
        if (event.dataTransfer && event.dataTransfer.types && Array.from(event.dataTransfer.types).includes('Files')) {
            event.preventDefault()
        }
    }, [])

    const onPaste = useCallback((event: ClipboardEvent): void => {
        if (event.clipboardData && event.clipboardData.files.length > 0) {
            uploadItems(event.clipboardData.files)
        }
    }, [uploadItems])

    useEffect(() => {
        document.addEventListener('paste', onPaste)
        document.addEventListener('drop', onDrop)
        document.addEventListener('dragover', onDragOver)
        return () => {
            document.removeEventListener('paste', onPaste)
            document.removeEventListener('drop', onDrop)
            document.removeEventListener('dragover', onDragOver)
        }
    }, [uploadItems, onPaste, onDrop, onDragOver])
}
