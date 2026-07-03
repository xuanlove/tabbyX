import { ConfigProvider } from 'tabby-core'

/**
 * cloudSync 配置默认值。
 *
 * 与现有 tabby-settings 的 configSync 命名空间完全独立，互不干扰。
 * - passwordHash / passwordSalt 仅用于校验用户输入的同步密码是否正确
 * - 真正的加密密钥由「用户输入的密码 + salt」实时派生，用完即丢，不落盘
 * - 后端访问凭据（FTP/S3 密码）建议存入 Vault，这里仅作为兜底默认值结构
 */
export class CloudSyncConfigProvider extends ConfigProvider {
    defaults = {
        cloudSync: {
            enabled: false,
            /** 'webdav' | 'ftp' | 'ftps' | 's3' */
            backend: null as string | null,
            auto: true,
            /** 自动同步轮询间隔（秒） */
            autoSyncInterval: 300,
            /** 远端文件路径/key */
            remotePath: 'tabby/sync.bin',
            /** 同步内容开关 */
            syncParts: {
                profiles: true,
                knownHosts: true,
                vaultSecrets: false,
                sshConfigImports: false,
            },
            /** 冲突策略：'prompt'（默认推荐）| 'newest' | 'manual' */
            conflictStrategy: 'prompt',
            /** 多设备并发时强制弹窗（即使策略为 newest 也强制 prompt） */
            forcePromptOnMultiDevice: true,
            /** 本设备身份，首次启用时生成 */
            deviceId: null as string | null,
            /** 本设备友好名 */
            deviceName: null as string | null,
            /** 同步密码校验信息（不存密码本身） */
            passwordHash: null as string | null,
            passwordSalt: null as string | null,
            passwordIterations: 200000,
            /** 后端连接参数 */
            backends: {
                webdav: {
                    url: null as string | null,
                    username: null as string | null,
                    password: null as string | null,
                    basePath: '/dav/',
                },
                ftp: {
                    host: null as string | null,
                    port: 21,
                    username: null as string | null,
                    password: null as string | null,
                    /** false=FTP, true=FTPS */
                    secure: false,
                    secureOptions: null as any,
                },
                s3: {
                    endpoint: null as string | null,
                    region: 'us-east-1',
                    bucket: null as string | null,
                    accessKeyId: null as string | null,
                    secretAccessKey: null as string | null,
                    forcePathStyle: false,
                    useSSL: true,
                },
            },
            /** 上次同步状态 */
            lastSync: {
                remoteETag: null as string | null,
                remoteModified: null as string | null,
                localModified: null as string | null,
                localFingerprint: null as string | null,
                remoteDeviceId: null as string | null,
                remoteDeviceName: null as string | null,
            },
        },
    }
}
