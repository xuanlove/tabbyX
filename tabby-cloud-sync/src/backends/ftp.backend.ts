import { Injectable } from '@angular/core'
import { SyncBackend, ConnectionTestResult } from '../api/backend'
import { RemoteMeta } from '../api/payload'

/**
 * FTP/FTPS 后端配置
 */
export interface FTPBackendConfig {
    host: string | null
    port: number
    username: string | null
    password: string | null
    /** false=明文 FTP, true=FTPS（显式 TLS） */
    secure: boolean
    secureOptions: any
}

/**
 * FTP / FTPS 同步后端实现。
 *
 * 使用 basic-ftp npm 包。secure=true 时启用 FTPS（显式 TLS）。
 *
 * 注意：FTP 协议本身不支持真正的 ETag，因此用 size + modifiedAt 组合模拟。
 * 因数据已端到端加密，FTP 明文传输不影响数据机密性。
 */
@Injectable()
export class FTPBackend extends SyncBackend {
    readonly id = 'ftp'
    readonly displayName = 'FTP / FTPS'
    readonly supportsETag = false
    readonly supportsModifiedTime = true

    private async withClient<T> (
        config: FTPBackendConfig,
        fn: (client: any) => Promise<T>,
    ): Promise<T> {
        const ftp = require('basic-ftp')
        const client = new ftp.Client(30000)
        try {
            await client.access({
                host: config.host || undefined,
                port: config.port || 21,
                user: config.username || undefined,
                password: config.password || undefined,
                secure: !!config.secure,
                secureOptions: config.secureOptions || undefined,
            })
            return await fn(client)
        } finally {
            client.close()
        }
    }

    async testConnection (config: FTPBackendConfig): Promise<ConnectionTestResult> {
        try {
            await this.withClient(config, async () => {
                // 仅访问即可
            })
            return { ok: true }
        } catch (e: any) {
            return { ok: false, message: e?.message || String(e) }
        }
    }

    async upload (path: string, data: Buffer, config: FTPBackendConfig): Promise<RemoteMeta> {
        const ftp = require('basic-ftp')
        // 上传到 .tmp 再 rename，FTP 不支持原子 rename 时直接覆盖
        const tmpPath = `${path}.tmp`
        await this.withClient(config, async client => {
            await this.ensureParentDirs(client, path)
            // basic-ftp 的 uploadFrom 接收流
            const { Readable } = require('stream')
            const stream = Readable.from(data)
            await client.uploadFrom(stream, tmpPath)
        })
        // rename 覆盖（部分服务器不支持则回退直接上传）
        try {
            await this.withClient(config, async client => {
                try { await client.remove(path) } catch { /* 旧文件不存在 */ }
                await client.rename(tmpPath, path)
            })
        } catch {
            // rename 失败，直接覆盖上传
            await this.withClient(config, async client => {
                const { Readable } = require('stream')
                const stream = Readable.from(data)
                await client.uploadFrom(stream, path)
                try { await client.remove(tmpPath) } catch { /* 忽略 */ }
            })
        }
        const meta = await this.stat(path, config)
        return meta ?? { size: data.length }
    }

    async download (path: string, config: FTPBackendConfig): Promise<{ data: Buffer; meta: RemoteMeta } | null> {
        const meta = await this.stat(path, config)
        if (!meta) {
            return null
        }
        const chunks: Buffer[] = []
        await this.withClient(config, async client => {
            const { Writable } = require('stream')
            const sink = new Writable({
                write (chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk))
                    callback()
                },
            })
            await client.downloadTo(sink, path)
        })
        return { data: Buffer.concat(chunks), meta }
    }

    async stat (path: string, config: FTPBackendConfig): Promise<RemoteMeta | null> {
        try {
            return await this.withClient(config, async client => {
                const list = await client.list(path)
                if (!list || list.length === 0) {
                    return null
                }
                // 取文件名匹配项
                const filename = path.split('/').pop()
                const entry = list.find((e: any) => e.name === filename) ?? list[0]
                if (!entry || entry.isDirectory) {
                    return null
                }
                // FTP 无 ETag，用 size+modifiedAt 模拟
                const fakeEtag = `${entry.size}-${entry.modifiedAt?.getTime() ?? 0}`
                return {
                    etag: fakeEtag,
                    modifiedAt: entry.modifiedAt ? new Date(entry.modifiedAt) : undefined,
                    size: entry.size,
                }
            })
        } catch (e: any) {
            if (/550|no such file|not found/i.test(e?.message || '')) {
                return null
            }
            throw e
        }
    }

    async delete (path: string, config: FTPBackendConfig): Promise<void> {
        try {
            await this.withClient(config, async client => {
                await client.remove(path)
            })
        } catch (e: any) {
            if (!/550|no such file|not found/i.test(e?.message || '')) {
                throw e
            }
        }
    }

    private async ensureParentDirs (client: any, path: string): Promise<void> {
        const parts = path.split('/').filter(Boolean)
        parts.pop() // 文件名
        let current = ''
        for (const part of parts) {
            current = current ? `${current}/${part}` : part
            try {
                await client.ensureDir(current)
            } catch {
                // 已存在则忽略
            }
        }
    }
}
