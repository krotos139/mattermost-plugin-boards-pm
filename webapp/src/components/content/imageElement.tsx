// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState, useCallback} from 'react'
import {createPortal} from 'react-dom'
import {IntlShape, useIntl} from 'react-intl'

import {ContentBlock} from '../../blocks/contentBlock'
import {ImageBlock, createImageBlock} from '../../blocks/imageBlock'
import octoClient from '../../octoClient'
import mutator from '../../mutator'
import {Block, FileInfo} from '../../blocks/block'
import {Utils} from '../../utils'
import ImageIcon from '../../widgets/icons/image'
import CompassIcon from '../../widgets/icons/compassIcon'
import {sendFlashMessage} from '../../components/flashMessages'

import {contentRegistry} from './contentRegistry'
import ArchivedFile from './archivedFile/archivedFile'

import './imageElement.scss'

type Props = {
    block: ContentBlock
}

const ImageElement = (props: Props): JSX.Element|null => {
    const [imageDataUrl, setImageDataUrl] = useState<string|null>(null)
    const [fileInfo, setFileInfo] = useState<FileInfo>({})
    const [lightboxOpen, setLightboxOpen] = useState(false)
    const intl = useIntl()

    const {block} = props

    useEffect(() => {
        if (!imageDataUrl) {
            const loadImage = async () => {
                const fileURL = await octoClient.getFileAsDataUrl(block.boardId, props.block.fields.fileId)
                setImageDataUrl(fileURL.url || '')
                setFileInfo(fileURL)
            }
            loadImage()
        }
    }, [])

    const closeLightbox = useCallback(() => setLightboxOpen(false), [])

    useEffect(() => {
        if (!lightboxOpen) {
            return
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeLightbox()
            }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [lightboxOpen, closeLightbox])

    const downloadImage = useCallback(async (e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation()
        }
        if (!imageDataUrl) {
            return
        }
        const a = document.createElement('a')
        a.href = imageDataUrl
        a.download = fileInfo.name || block.title || 'image'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
    }, [imageDataUrl, fileInfo.name, block.title])

    if (fileInfo.archived) {
        return (
            <ArchivedFile fileInfo={fileInfo}/>
        )
    }

    if (!imageDataUrl) {
        return null
    }

    const downloadLabel = intl.formatMessage({id: 'ImageElement.download', defaultMessage: 'Download'})
    const closeLabel = intl.formatMessage({id: 'ImageElement.close', defaultMessage: 'Close'})

    return (
        <>
            <div className='ImageElement-thumbWrap'>
                <img
                    className='ImageElement'
                    src={imageDataUrl}
                    alt={block.title}
                    draggable={false}
                    onClick={() => setLightboxOpen(true)}
                />
                <div className='ImageElement-overlayActions'>
                    <button
                        type='button'
                        className='ImageElement-overlayBtn'
                        onClick={downloadImage}
                        title={downloadLabel}
                        aria-label={downloadLabel}
                    >
                        <CompassIcon icon='download-outline'/>
                    </button>
                </div>
            </div>
            {lightboxOpen && createPortal(
                // Rendered via portal to <body> so position: fixed works
                // relative to the viewport. The card's .ContentBlock has
                // `transform: translate3d(0, 0, 0)` (Chrome DnD workaround)
                // which would otherwise turn this into the lightbox's
                // containing block — collapsing it to thumbnail size.
                <div
                    className='ImageElement-lightbox'
                    onClick={closeLightbox}
                    role='dialog'
                    aria-modal='true'
                >
                    <div className='ImageElement-lightboxToolbar'>
                        <button
                            type='button'
                            className='ImageElement-lightboxBtn'
                            onClick={downloadImage}
                            title={downloadLabel}
                            aria-label={downloadLabel}
                        >
                            <CompassIcon icon='download-outline'/>
                        </button>
                        <button
                            type='button'
                            className='ImageElement-lightboxBtn'
                            onClick={(e) => { e.stopPropagation(); closeLightbox() }}
                            title={closeLabel}
                            aria-label={closeLabel}
                        >
                            <CompassIcon icon='close'/>
                        </button>
                    </div>
                    <img
                        className='ImageElement-lightboxImg'
                        src={imageDataUrl}
                        alt={block.title}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>,
                document.body,
            )}
        </>
    )
}

const uploadImageFiles = async (boardId: string, cardId: string, contentOrder: Array<string | string[]>, files: File[], intl: IntlShape) => {
    if (!files.length) {
        return
    }
    const uploads = files.map((f) => octoClient.uploadFile(boardId, f))
    const uploaded = await Promise.all(uploads)
    const blocksToInsert: ImageBlock[] = []
    let someFailed = false
    for (const fileId of uploaded) {
        if (!fileId) {
            someFailed = true
            continue
        }
        const b = createImageBlock()
        b.parentId = cardId
        b.boardId = boardId
        b.fields.fileId = fileId
        blocksToInsert.push(b)
    }
    if (someFailed) {
        sendFlashMessage({content: intl.formatMessage({id: 'createImageBlock.failed', defaultMessage: 'Unable to upload the file. File size limit reached.'}), severity: 'normal'})
    }
    if (blocksToInsert.length === 0) {
        return
    }
    const afterRedo = async (newBlocks: Block[]) => {
        const newContentOrder = JSON.parse(JSON.stringify(contentOrder))
        newContentOrder.push(...newBlocks.map((b: Block) => b.id))
        await octoClient.patchBlock(boardId, cardId, {updatedFields: {contentOrder: newContentOrder}})
    }
    const beforeUndo = async () => {
        const newContentOrder = JSON.parse(JSON.stringify(contentOrder))
        await octoClient.patchBlock(boardId, cardId, {updatedFields: {contentOrder: newContentOrder}})
    }
    await mutator.insertBlocks(boardId, blocksToInsert, 'add images', afterRedo, beforeUndo)
}

contentRegistry.registerContentType({
    type: 'image',
    getDisplayText: (intl: IntlShape) => intl.formatMessage({id: 'ContentBlock.image', defaultMessage: 'image'}),
    getIcon: () => <ImageIcon/>,
    createBlock: async (boardId: string, intl: IntlShape) => {
        return new Promise<ImageBlock>(
            (resolve) => {
                Utils.selectLocalFile(async (file) => {
                    const fileId = await octoClient.uploadFile(boardId, file)

                    if (fileId) {
                        const block = createImageBlock()
                        block.fields.fileId = fileId || ''
                        resolve(block)
                    } else {
                        sendFlashMessage({content: intl.formatMessage({id: 'createImageBlock.failed', defaultMessage: 'Unable to upload the file. File size limit reached.'}), severity: 'normal'})
                    }
                },
                '.jpg,.jpeg,.png,.gif')
            },
        )

        // return new ImageBlock()
    },
    createComponent: (block) => <ImageElement block={block}/>,
})

export {uploadImageFiles}
export default React.memo(ImageElement)
