import type { RemoteMeta } from './payload'

/**
 * 同步后端抽象接口。
 *
 * 每种存储协议（WebDAV/FTP/FTPS/S3）实现此接口，通过 Angular DI multi-provider
 * 注册到 BackendRegistryService。第三方插件可扩展新协议（如 OneDrive、Google Drive）。
 *
 * 所有方法均接收完整的后端配置对象（从 config.cloudSync.backends[backendId] 取），
 * 不持有状态，便于多实例并行使用。
 */
export abstract class SyncBackend {
    /** 后端唯一标识，如 'webdav'/'ftp'/'ftps'/'s3' */
    abstract readonly id: string
    /** 用户可见名称 */
    abstract readonly displayName: string
    /** 是否支持 ETag（用于增量检测） */
    abstract readonly supportsETag: boolean
    /** 是否支持修改时间 */
    abstract readonly supportsModifiedTime: boolean

    /**
     * 测试连接是否可用
     * @returns 成功返回 { ok: true }，失败返回 { ok: false, message }
     */
    abstract testConnection (config: any): Promise<{ ok: boolean; message?: string }>

    /**
     * 上传文件（覆盖式）
     * @param path 远端路径/key
     * @param data 文件内容
     * @param config 后端配置
     * @returns 远端元信息
     */
    abstract upload (path: string, data: Buffer, config: any): Promise<RemoteMeta>

    /**
     * 下载文件
     * @param path 远端路径/key
     * @param config 后端配置
     * @returns 内容 + 元信息；文件不存在返回 null
     */
    abstract download (path: string, config: any): Promise<{ data: Buffer; meta: RemoteMeta } | null>

    /**
     * 仅取远端元信息（不下载内容），用于增量检测
     * @param path 远端路径/key
     * @param config 后端配置
     * @returns 元信息；文件不存在返回 null
     */
    abstract stat (path: string, config: any): Promise<RemoteMeta | null>

    /**
     * 删除远端文件
     */
    abstract delete (path: string, config: any): Promise<void>

    /**
     * 返回此后端专属的配置表单组件类型（可选）
     * 第三方后端可注入自定义 Angular 组件用于编辑其配置
     */
    getConfigComponentType? (): any
}

/**
 * 后端连接测试结果
 */
export interface ConnectionTestResult {
    ok: boolean
    message?: string
}
