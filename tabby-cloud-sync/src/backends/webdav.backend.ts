import { Injectable } from '@angular/core'
import { SyncBackend, ConnectionTestResult } from '../api/backend'
import { RemoteMeta } from '../api/payload'

/**
 * WebDAV 后端配置（从 config.cloudSync.backends.webdav 取）
 */
export interface WebDAVBackendConfig {
    url: string | null
    username: string | null
    password: string | null
    basePath: string
}

/**
 * WebDAV 同步后端实现。
 *
 * 使用 webdav npm 包（在渲染进程通过 webpack external 由 Node.js 提供）。
 * WebDAV 原生支持 ETag 和 Last-Modified，最适合增量同步。
 *
 * 兼容 Nextcloud / ownCloud / 坚果云 / 自建 WebDAV 服务器。
 */
@Injectable()
export class WebDAVBackend extends SyncBackend {
    readonly id = 'webdav'
    readonly displayName = 'WebDAV'
    readonly supportsETag = true
    readonly supportsModifiedTime = true

    private getClient (config: WebDAVBackendConfig): any {
        if (!config.url) {
            throw new Error('WebDAV URL is not configured')
        }
        // 动态 require，避免在 web 平台加载时立即失败
        const createClient = require('webdav').createClient
        return createClient(config.url, {
            username: config.username || undefined,
            password: config.password || undefined,
        })
    }

    private resolvePath (path: string, config: WebDAVBackendConfig): string {
        // basePath 用于隔离命名空间，比如 Nextcloud 的 /remote.php/dav/files/user/
        // 用户填写的 remotePath 是相对路径，最终拼接为 basePath/remotePath
        const base = (config.basePath || '/').replace(/\/+$/, '')
        const relative = path.replace(/^\/+/, '')
        // webdav 包要求路径以 / 开头
        return `${base}/${relative}`
    }

    async testConnection (config: WebDAVBackendConfig): Promise<ConnectionTestResult> {
        try {
            const client = this.getClient(config)
            // 尝试列根目录
            await client.getDirectoryContents('/')
            return { ok: true }
        } catch (e: any) {
            return { ok: false, message: e?.message || String(e) }
        }
    }

    async upload (path: string, data: Buffer, config: WebDAVBackendConfig): Promise<RemoteMeta> {
        const client = this.getClient(config)
        const fullPath = this.resolvePath(path, config)
        // 确保父目录存在
        await this.ensureParentDirs(client, fullPath)
        // 上传（覆盖式）
        await client.putFileContents(fullPath, data, { overwrite: true })
        // 取回元信息
        const stat = await this.statInternal(client, fullPath, config)
        return stat ?? { size: data.length }
    }

    async download (path: string, config: WebDAVBackendConfig): Promise<{ data: Buffer; meta: RemoteMeta } | null> {
        const client = this.getClient(config)
        const fullPath = this.resolvePath(path, config)
        const meta = await this.statInternal(client, fullPath, config)
        if (!meta) {
            return null
        }
        const data: Buffer = await client.getFileContents(fullPath, { format: 'binary' })
        return { data: Buffer.from(data), meta }
    }

    async stat (path: string, config: WebDAVBackendConfig): Promise<RemoteMeta | null> {
        const client = this.getClient(config)
        const fullPath = this.resolvePath(path, config)
        return this.statInternal(client, fullPath, config)
    }

    async delete (path: string, config: WebDAVBackendConfig): Promise<void> {
        const client = this.getClient(config)
        const fullPath = this.resolvePath(path, config)
        try {
            await client.deleteFile(fullPath)
        } catch (e: any) {
            // 文件不存在视为已删除
            if (!/404|not found/i.test(e?.message || '')) {
                throw e
            }
        }
    }

    private async statInternal (client: any, fullPath: string, _config: WebDAVBackendConfig): Promise<RemoteMeta | null> {
        try {
            const stat = await client.stat(fullPath, { details: true })
            // webdav 包返回 { data: { etag, lastModified, size, ... } } 或直接 { etag, ... }
            const data = stat.data ?? stat
            return {
                etag: data.etag ? String(data.etag).replace(/"/g, '') : undefined,
                modifiedAt: data.lastModified ? new Date(data.lastModified) : undefined,
                size: typeof data.size === 'number' ? data.size : undefined,
            }
        } catch (e: any) {
            if (/404|not found/i.test(e?.message || '')) {
                return null
            }
            throw e
        }
    }

    /**
     * 递归创建父目录
     */
    private async ensureParentDirs (client: any, fullPath: string): Promise<void> {
        const parts = fullPath.split('/').filter(Boolean)
        // 最后一项是文件名
        parts.pop()
        let current = ''
        for (const part of parts) {
            current = `${current}/${part}`
            try {
                await client.createDirectory(current, { recursive: false })
            } catch {
                // 目录已存在则忽略
            }
        }
    }
}
