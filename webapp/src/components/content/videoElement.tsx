// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState, useCallback} from 'react'
import {IntlShape, useIntl} from 'react-intl'

import {ContentBlock} from '../../blocks/contentBlock'
import {VideoBlock, createVideoBlock} from '../../blocks/videoBlock'
import octoClient from '../../octoClient'
import {Utils} from '../../utils'
import {sendFlashMessage} from '../../components/flashMessages'

import {FileInfo} from '../../blocks/block'

import {contentRegistry} from './contentRegistry'
import ArchivedFile from './archivedFile/archivedFile'
import CompassIcon from '../../widgets/icons/compassIcon'

import './videoElement.scss'

type Props = {
    block: ContentBlock
}

const VideoElement = (props: Props): JSX.Element|null => {
    const [videoUrl, setVideoUrl] = useState<string|null>(null)
    const [fileInfo, setFileInfo] = useState<FileInfo>({})
    const intl = useIntl()
    const {block} = props

    useEffect(() => {
        if (videoUrl) {
            return
        }
        const load = async () => {
            const fileURL = await octoClient.getFileAsDataUrl(block.boardId, props.block.fields.fileId)
            setVideoUrl(fileURL.url || '')
            setFileInfo(fileURL)
        }
        load()
    }, [])

    const downloadVideo = useCallback((e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation()
        }
        if (!videoUrl) {
            return
        }
        const a = document.createElement('a')
        a.href = videoUrl
        a.download = fileInfo.name || block.title || 'video'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
    }, [videoUrl, fileInfo.name, block.title])

    if (fileInfo.archived) {
        return <ArchivedFile fileInfo={fileInfo}/>
    }
    if (!videoUrl) {
        return null
    }

    const downloadLabel = intl.formatMessage({id: 'VideoElement.download', defaultMessage: 'Download'})

    return (
        <div className='VideoElement-wrap'>
            <video
                className='VideoElement'
                src={videoUrl}
                controls={true}
                preload='metadata'
            />
            <div className='VideoElement-overlayActions'>
                <button
                    type='button'
                    className='VideoElement-overlayBtn'
                    onClick={downloadVideo}
                    title={downloadLabel}
                    aria-label={downloadLabel}
                >
                    <CompassIcon icon='download-outline'/>
                </button>
            </div>
        </div>
    )
}

contentRegistry.registerContentType({
    type: 'video',
    getDisplayText: (intl: IntlShape) => intl.formatMessage({id: 'ContentBlock.video', defaultMessage: 'video'}),
    getIcon: () => <CompassIcon icon='play-circle-outline'/>,
    createBlock: async (boardId: string, intl: IntlShape) => {
        return new Promise<VideoBlock>((resolve) => {
            Utils.selectLocalFile(async (file) => {
                const fileId = await octoClient.uploadFile(boardId, file)
                if (fileId) {
                    const block = createVideoBlock()
                    block.fields.fileId = fileId
                    block.title = file.name
                    resolve(block)
                } else {
                    sendFlashMessage({content: intl.formatMessage({id: 'createVideoBlock.failed', defaultMessage: 'Unable to upload the file. File size limit reached.'}), severity: 'normal'})
                }
            },
            'video/*')
        })
    },
    createComponent: (block) => <VideoElement block={block}/>,
})

export default React.memo(VideoElement)
