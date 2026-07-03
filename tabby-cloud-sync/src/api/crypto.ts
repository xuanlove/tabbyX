import * as crypto from 'crypto'
import * as zlib from 'zlib'

/**
 * 同步密码派生与数据加解密工具。
 *
 * 流程：明文 YAML → gzip → AES-256-GCM 加密 → base64
 * 解密反向：base64 → AES-256-GCM 解密 → gunzip → 明文 YAML
 *
 * 同步密码本身不落盘明文：
 *  - passwordSalt + passwordHash 仅用于校验用户输入是否正确
 *  - 真正的加密密钥由「用户输入 + passwordSalt」实时派生，用完即丢
 */

const KEY_LENGTH = 32          // AES-256
const IV_LENGTH = 12           // GCM 推荐 12 字节
const SALT_LENGTH = 16
const PBKDF2_DEFAULT_ITERATIONS = 200_000
const PBKDF2_DIGEST = 'sha256'
const CIPHER_ALGO = 'aes-256-gcm'
const AUTH_TAG_LENGTH = 16

export interface DerivedKeyMaterial {
    /** 用于实际加密的 32 字节密钥 */
    key: Buffer
    /** 盐，需持久化到 config */
    salt: Buffer
    /** 迭代次数，需持久化到 config */
    iterations: number
}

export interface PasswordVerification {
    /** 盐（base64），存入 config.cloudSync.passwordSalt */
    salt: string
    /** 迭代次数，存入 config.cloudSync.passwordIterations */
    iterations: number
    /** 校验哈希（base64），存入 config.cloudSync.passwordHash */
    hash: string
}

export interface EncryptedBlob {
    /** base64 密文 */
    ciphertext: string
    /** base64 IV */
    iv: string
    /** base64 GCM 认证标签 */
    tag: string
}

/**
 * 生成随机盐
 */
export function generateSalt (): Buffer {
    return crypto.randomBytes(SALT_LENGTH)
}

/**
 * 从用户密码派生加密密钥
 */
export function deriveKey (
    password: string,
    salt: Buffer,
    iterations: number = PBKDF2_DEFAULT_ITERATIONS,
): Buffer {
    return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, PBKDF2_DIGEST)
}

/**
 * 计算密码验证哈希（与加密密钥不同的派生，用于校验输入密码是否正确，
 * 避免「错误密码 → GCM 解密失败」时无法区分是密码错还是数据损坏）
 */
export function computeVerificationHash (
    password: string,
    salt: Buffer,
    iterations: number = PBKDF2_DEFAULT_ITERATIONS,
): Buffer {
    // 用不同的 info 派生，确保与加密密钥不同
    const verifySalt = Buffer.concat([salt, Buffer.from('verify', 'utf8')])
    return crypto.pbkdf2Sync(password, verifySalt, iterations, KEY_LENGTH, PBKDF2_DIGEST)
}

/**
 * 首次设置同步密码：生成盐 + 派生密钥 + 计算校验哈希
 * 返回持久化所需的验证信息 + 内存中的密钥
 */
export function setupPassword (
    password: string,
    iterations: number = PBKDF2_DEFAULT_ITERATIONS,
): { verification: PasswordVerification; key: Buffer } {
    const salt = generateSalt()
    const key = deriveKey(password, salt, iterations)
    const hash = computeVerificationHash(password, salt, iterations)
    return {
        verification: {
            salt: salt.toString('base64'),
            iterations,
            hash: hash.toString('base64'),
        },
        key,
    }
}

/**
 * 校验用户输入的密码是否与已存储的验证信息匹配
 */
export function verifyPassword (
    password: string,
    verification: PasswordVerification,
): boolean {
    const salt = Buffer.from(verification.salt, 'base64')
    const expectedHash = Buffer.from(verification.hash, 'base64')
    const actualHash = computeVerificationHash(password, salt, verification.iterations)
    // 定时安全比较
    return crypto.timingSafeEqual(expectedHash, actualHash)
}

/**
 * 用已校验的密码派生加密密钥（用于运行时解密/加密）
 */
export function deriveKeyFromVerification (
    password: string,
    verification: PasswordVerification,
): Buffer {
    const salt = Buffer.from(verification.salt, 'base64')
    return deriveKey(password, salt, verification.iterations)
}

/**
 * 加密 + 压缩：明文 Buffer → base64 密文 blob
 */
export function encrypt (
    plaintext: Buffer,
    key: Buffer,
): EncryptedBlob {
    // 先 gzip 压缩
    const compressed = zlib.gzipSync(plaintext, { level: 9 })

    // 再 AES-256-GCM 加密
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH })
    const encrypted = Buffer.concat([
        cipher.update(compressed),
        cipher.final(),
    ])
    const tag = cipher.getAuthTag()

    return {
        ciphertext: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
    }
}

/**
 * 解密 + 解压：base64 密文 blob → 明文 Buffer
 * @throws 当密码错误或数据被篡改时抛出
 */
export function decrypt (
    blob: EncryptedBlob,
    key: Buffer,
): Buffer {
    const iv = Buffer.from(blob.iv, 'base64')
    const tag = Buffer.from(blob.tag, 'base64')
    const ciphertext = Buffer.from(blob.ciphertext, 'base64')

    const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH })
    decipher.setAuthTag(tag)

    let decrypted: Buffer
    try {
        decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ])
    } catch (e) {
        throw new Error('Decryption failed: wrong password or corrupted data')
    }

    // gunzip 解压
    return zlib.gunzipSync(decrypted)
}

/**
 * 计算数据的 SHA-256 指纹（hex），用于冲突检测
 */
export function fingerprint (data: Buffer | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 生成随机设备 ID（uuid v4 风格）
 */
export function generateDeviceId (): string {
    return crypto.randomUUID()
}
