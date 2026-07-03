import { Injectable } from '@angular/core'
import { SyncBackend, ConnectionTestResult } from '../api/backend'
import { RemoteMeta } from '../api/payload'

/**
 * S3 后端配置
 */
export interface S3BackendConfig {
    endpoint: string | null
    region: string
    bucket: string | null
    accessKeyId: string | null
    secretAccessKey: string | null
    /** true=路径风格（自建 MinIO 等需要） */
    forcePathStyle: boolean
    useSSL: boolean
}

/**
 * S3 同步后端实现。
 *
 * 使用 @aws-sdk/client-s3。兼容 AWS S3、MinIO、阿里云 OSS、腾讯云 COS、
 * Backblaze B2 等所有兼容 S3 协议的服务。
 *
 * S3 原生支持 ETag（用于 PUT 上传的对象）和 Last-Modified，最适合增量同步。
 */
@Injectable()
export class S3Backend extends SyncBackend {
    readonly id = 's3'
    readonly displayName = 'S3'
    readonly supportsETag = true
    readonly supportsModifiedTime = true

    private getClient (config: S3BackendConfig): any {
        if (!config.bucket) {
            throw new Error('S3 bucket is not configured')
        }
        const { S3Client } = require('@aws-sdk/client-s3')
        const clientConfig: any = {
            region: config.region || 'us-east-1',
            credentials: {
                accessKeyId: config.accessKeyId || '',
                secretAccessKey: config.secretAccessKey || '',
            },
            forcePathStyle: !!config.forcePathStyle,
        }
        if (config.endpoint) {
            // 自定义 endpoint（MinIO 等）
            const protocol = config.useSSL === false ? 'http://' : 'https://'
            clientConfig.endpoint = config.endpoint.startsWith('http')
                ? config.endpoint
                : `${protocol}${config.endpoint}`
        }
        return new S3Client(clientConfig)
    }

    async testConnection (config: S3BackendConfig): Promise<ConnectionTestResult> {
        try {
            const { HeadBucketCommand } = require('@aws-sdk/client-s3')
            const client = this.getClient(config)
            await client.send(new HeadBucketCommand({ Bucket: config.bucket! }))
            return { ok: true }
        } catch (e: any) {
            return { ok: false, message: e?.message || String(e) }
        }
    }

    async upload (path: string, data: Buffer, config: S3BackendConfig): Promise<RemoteMeta> {
        const { PutObjectCommand } = require('@aws-sdk/client-s3')
        const client = this.getClient(config)
        await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: path,
            Body: data,
            ContentType: 'application/octet-stream',
        }))
        const meta = await this.stat(path, config)
        return meta ?? { size: data.length }
    }

    async download (path: string, config: S3BackendConfig): Promise<{ data: Buffer; meta: RemoteMeta } | null> {
        const { GetObjectCommand } = require('@aws-sdk/client-s3')
        const client = this.getClient(config)
        let response: any
        try {
            response = await client.send(new GetObjectCommand({
                Bucket: config.bucket,
                Key: path,
            }))
        } catch (e: any) {
            if (/NoSuchKey|404|Not Found/i.test(e?.message || '') || e?.$metadata?.httpStatusCode === 404) {
                return null
            }
            throw e
        }
        // Body 是 Readable 流
        const data = await this.streamToBuffer(response.Body)
        return {
            data,
            meta: {
                etag: response.ETag ? String(response.ETag).replace(/"/g, '') : undefined,
                modifiedAt: response.LastModified ? new Date(response.LastModified) : undefined,
                size: response.ContentLength ?? data.length,
            },
        }
    }

    async stat (path: string, config: S3BackendConfig): Promise<RemoteMeta | null> {
        const { HeadObjectCommand } = require('@aws-sdk/client-s3')
        const client = this.getClient(config)
        try {
            const head = await client.send(new HeadObjectCommand({
                Bucket: config.bucket,
                Key: path,
            }))
            return {
                etag: head.ETag ? String(head.ETag).replace(/"/g, '') : undefined,
                modifiedAt: head.LastModified ? new Date(head.LastModified) : undefined,
                size: head.ContentLength,
            }
        } catch (e: any) {
            if (/NoSuchKey|404|Not Found/i.test(e?.message || '') || e?.$metadata?.httpStatusCode === 404) {
                return null
            }
            throw e
        }
    }

    async delete (path: string, config: S3BackendConfig): Promise<void> {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3')
        const client = this.getClient(config)
        try {
            await client.send(new DeleteObjectCommand({
                Bucket: config.bucket,
                Key: path,
            }))
        } catch {
            // 删除失败通常是因为对象不存在，忽略
        }
    }

    private async streamToBuffer (stream: any): Promise<Buffer> {
        if (Buffer.isBuffer(stream)) {
            return stream
        }
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
    }
}
