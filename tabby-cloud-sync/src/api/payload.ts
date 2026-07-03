import { EncryptedBlob } from './crypto'

/**
 * 同步数据格式定义。
 *
 * 整个 SyncPayload 序列化为 JSON 后作为单个文件（默认 sync.bin）上传到远端。
 * 头部字段（version/createdAt/sourceDevice/fingerprint/crypto）为明文，便于
 * 在下载后、解密前就能看到远端信息用于冲突判断；data 字段为 base64 密文。
 *
 * 远端只见密文 + 元数据，无法获知同步的 profiles 内容。
 */

export const PAYLOAD_VERSION = 1

export type CompressionAlgo = 'gzip'
export type CipherAlgo = 'aes-256-gcm'
export type KdfAlgo = 'pbkdf2-sha256'

/**
 * 同步数据负载（整体 JSON 序列化后上传）
 */
export interface SyncPayload {
    /** 格式版本号，未来升级用 */
    version: number
    /** 本次上传创建时间（ISO 字符串） */
    createdAt: string
    /** 上传此版本的设备 ID */
    sourceDevice: string
    /** 上传此设备的友好名（如 "MY-LAPTOP"） */
    sourceDeviceName: string
    /** 上传时的 Tabby 版本 */
    tabbyVersion: string
    /** 明文数据的 SHA-256 指纹（hex），用于冲突检测 */
    fingerprint: string
    /** 加密参数 */
    crypto: {
        algo: CipherAlgo
        kdf: KdfAlgo
        iterations: number
        /** base64 盐 */
        salt: string
        /** base64 IV */
        iv: string
        /** base64 GCM 认证标签 */
        tag: string
    }
    /** 压缩算法 */
    compression: CompressionAlgo
    /** base64( gzip( aes_gcm_encrypt( yaml(profiles...) ) ) ) */
    data: string
}

/**
 * 远端文件元信息（不下载内容，仅 stat 得到）
 */
export interface RemoteMeta {
    /** 远端 ETag（若后端支持） */
    etag?: string
    /** 远端最后修改时间 */
    modifiedAt?: Date
    /** 文件大小（字节） */
    size?: number
}

/**
 * 从加密 blob + 元信息构造完整 SyncPayload
 */
export function buildPayload (params: {
    encrypted: EncryptedBlob
    salt: string
    iterations: number
    fingerprint: string
    deviceId: string
    deviceName: string
    tabbyVersion: string
}): SyncPayload {
    return {
        version: PAYLOAD_VERSION,
        createdAt: new Date().toISOString(),
        sourceDevice: params.deviceId,
        sourceDeviceName: params.deviceName,
        tabbyVersion: params.tabbyVersion,
        fingerprint: params.fingerprint,
        crypto: {
            algo: 'aes-256-gcm',
            kdf: 'pbkdf2-sha256',
            iterations: params.iterations,
            salt: params.salt,
            iv: params.encrypted.iv,
            tag: params.encrypted.tag,
        },
        compression: 'gzip',
        data: params.encrypted.ciphertext,
    }
}

/**
 * 序列化为上传用的 JSON 字符串
 */
export function serializePayload (payload: SyncPayload): Buffer {
    return Buffer.from(JSON.stringify(payload), 'utf8')
}

/**
 * 从远端下载的 Buffer 解析为 SyncPayload
 */
export function parsePayload (data: Buffer): SyncPayload {
    const json = JSON.parse(data.toString('utf8'))
    if (!json || typeof json.version !== 'number') {
        throw new Error('Invalid sync payload: missing version')
    }
    if (json.version > PAYLOAD_VERSION) {
        throw new Error(`Unsupported payload version ${json.version} (this client supports up to ${PAYLOAD_VERSION})`)
    }
    return json as SyncPayload
}

/**
 * 从 SyncPayload 中提取 EncryptedBlob（用于解密）
 */
export function extractEncryptedBlob (payload: SyncPayload): EncryptedBlob {
    return {
        ciphertext: payload.data,
        iv: payload.crypto.iv,
        tag: payload.crypto.tag,
    }
}
