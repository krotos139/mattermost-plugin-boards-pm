// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useCallback, useEffect, useState} from 'react'

// AdminKeyRow mirrors the JSON returned by GET /api/v2/mcp/admin/keys.
// The hash is the row identifier (revoke target); the plaintext is never
// stored, so the user-facing description column is the only label.
type AdminKeyRow = {
    hash: string
    user_id: string
    username: string
    description: string
    created_at: number
}

const baseURL = '/plugins/focalboard/api/v2/mcp/admin/keys'

const fmtDate = (ms: number) => {
    if (!ms) {
        return '-'
    }
    try {
        return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    } catch {
        return String(ms)
    }
}

// safeJSON tolerates non-JSON bodies (HTML 404 from a fall-through router).
async function safeJSON<T>(resp: Response): Promise<T> {
    const text = await resp.text()
    if (!text) {
        return [] as unknown as T
    }
    try {
        return JSON.parse(text) as T
    } catch {
        throw new Error(text.slice(0, 200))
    }
}

const McpKeysTable: React.FC = () => {
    const [rows, setRows] = useState<AdminKeyRow[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string>('')

    const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
            const resp = await fetch(baseURL, {
                method: 'GET',
                credentials: 'same-origin',
                headers: {'X-Requested-With': 'XMLHttpRequest'},
            })
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`)
            }
            const data = await safeJSON<AdminKeyRow[]>(resp)
            setRows(Array.isArray(data) ? data : [])
        } catch (e: any) {
            setError((e && e.message) || 'Failed to load keys')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        load()
    }, [load])

    const revoke = useCallback(async (hash: string) => {
        if (!window.confirm('Revoke this key?')) {
            return
        }
        try {
            const resp = await fetch(`${baseURL}/${encodeURIComponent(hash)}/revoke`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {'X-Requested-With': 'XMLHttpRequest'},
            })
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`)
            }
            await load()
        } catch (e: any) {
            window.alert('Revoke failed: ' + ((e && e.message) || 'unknown'))
        }
    }, [load])

    const wrapStyle: React.CSSProperties = {
        margin: '8px 0',
        padding: 12,
        border: '1px solid #ddd',
        borderRadius: 4,
        background: '#fff',
        maxWidth: 1100,
    }
    const headerStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    }
    const tableStyle: React.CSSProperties = {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 13,
    }
    const cellStyle: React.CSSProperties = {
        padding: '6px 8px',
        borderBottom: '1px solid #eee',
        verticalAlign: 'top',
    }
    const headStyle: React.CSSProperties = {
        ...cellStyle,
        background: '#f6f6f6',
        textAlign: 'left',
        fontWeight: 600,
    }
    const buttonStyle: React.CSSProperties = {
        padding: '4px 10px',
        cursor: 'pointer',
    }

    return (
        <div style={wrapStyle}>
            <div style={headerStyle}>
                <strong>{'Issued MCP API keys'}</strong>
                <button
                    type='button'
                    style={buttonStyle}
                    onClick={load}
                    disabled={loading}
                >
                    {loading ? 'Loading…' : 'Refresh'}
                </button>
            </div>
            {error && (
                <div style={{color: '#c00', marginBottom: 8}}>{error}</div>
            )}
            {!loading && !error && rows.length === 0 && (
                <div style={{color: '#666'}}>
                    {'No keys issued yet. Users mint keys with `/boards getapi <description>`.'}
                </div>
            )}
            {rows.length > 0 && (
                <table style={tableStyle}>
                    <thead>
                        <tr>
                            <th style={headStyle}>{'Prefix'}</th>
                            <th style={headStyle}>{'User'}</th>
                            <th style={headStyle}>{'Description'}</th>
                            <th style={headStyle}>{'Issued (UTC)'}</th>
                            <th style={headStyle}>{''}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.hash || `${r.user_id}-${r.created_at}`}>
                                <td style={cellStyle}>
                                    <code>{r.hash ? r.hash.slice(0, 8) + '…' : '—'}</code>
                                </td>
                                <td style={cellStyle}>{r.username || r.user_id}</td>
                                <td style={cellStyle}>{r.description || <em style={{color: '#888'}}>{'(none)'}</em>}</td>
                                <td style={cellStyle}>{fmtDate(r.created_at)}</td>
                                <td style={cellStyle}>
                                    <button
                                        type='button'
                                        style={{...buttonStyle, color: '#c00'}}
                                        onClick={() => revoke(r.hash)}
                                        disabled={!r.hash}
                                        title={r.hash ? '' : 'No hash on this record — orphan from an earlier schema. Delete via plugin KV cleanup.'}
                                    >
                                        {'Revoke'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

export default McpKeysTable
