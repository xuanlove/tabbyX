import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import {
    PasswordVerification,
    setupPassword,
    verifyPassword,
    deriveKeyFromVerification,
    deriveKey,
} from '../api/crypto'

/**
 * 同步密码管理服务。
 *
 * 同步密码本身不落盘明文：
 *  - passwordHash / passwordSalt 仅用于校验用户输入是否正确
 *  - 真正的加密密钥由「用户输入 + salt」实时派生，仅保存在会话内存中
 *  - 应用重启后需用户重新输入密码（或后续可选存入 Vault 自动解锁）
 *
 * 多设备协同：各设备的 salt 不同（首次设置时随机生成），但 salt 随 payload
 * 明文头部上传。解密远端数据时需用远端 payload 中的 salt 重新派生密钥，
 * 因此会话内存中同时保留原始密码（仅内存，不落盘）。
 */
@Injectable({ providedIn: 'root' })
export class SyncPasswordService {
    /** 会话内存中的派生密钥（本设备 salt），应用重启后清空 */
    private memoryKey: Buffer | null = null
    /** 会话内存中的原始密码（用于解密其他设备用不同 salt 加密的 payload），不落盘 */
    private memoryPassword: string | null = null

    constructor (
        private config: ConfigService,
    ) { }

    /**
     * 是否已设置过同步密码（配置中存在校验信息）
     */
    isPasswordSet (): boolean {
        const cs = this.config.store.cloudSync
        return !!(cs?.passwordHash && cs?.passwordSalt)
    }

    /**
     * 当前会话是否已解锁（内存中持有派生密钥）
     */
    isUnlocked (): boolean {
        return this.memoryKey !== null
    }

    /**
     * 获取已解锁的密钥（未解锁时抛错）
     */
    getKey (): Buffer {
        if (!this.memoryKey) {
            throw new Error('Sync password is not unlocked')
        }
        return this.memoryKey
    }

    /**
     * 首次设置同步密码（或修改密码）
     * - 生成 salt + 派生密钥 + 计算校验哈希
     * - 持久化校验信息到 config
     * - 派生密钥存入会话内存
     */
    async setPassword (password: string): Promise<void> {
        if (!password || password.length < 6) {
            throw new Error('Password must be at least 6 characters')
        }
        const iterations = this.config.store.cloudSync.passwordIterations || 200000
        const { verification, key } = setupPassword(password, iterations)
        this.config.store.cloudSync.passwordHash = verification.hash
        this.config.store.cloudSync.passwordSalt = verification.salt
        this.config.store.cloudSync.passwordIterations = verification.iterations
        await this.config.save()
        this.memoryKey = key
        this.memoryPassword = password
    }

    /**
     * 用用户输入的密码解锁（启动后调用）
     * @returns 是否解锁成功
     */
    async unlock (password: string): Promise<boolean> {
        const verification = this.getVerification()
        if (!verification) {
            return false
        }
        if (!verifyPassword(password, verification)) {
            return false
        }
        this.memoryKey = deriveKeyFromVerification(password, verification)
        this.memoryPassword = password
        return true
    }

    /**
     * 清空会话内存中的密钥（锁定）
     */
    lock (): void {
        this.memoryKey = null
        this.memoryPassword = null
    }

    /**
     * 修改密码（需先输入旧密码验证）
     */
    async changePassword (oldPassword: string, newPassword: string): Promise<void> {
        const verified = await this.unlock(oldPassword)
        if (!verified) {
            throw new Error('Current password is incorrect')
        }
        await this.setPassword(newPassword)
    }

    /**
     * 清除已设置的同步密码（同时清空 lastSync，因旧密文无法再解密）
     */
    async clearPassword (): Promise<void> {
        this.memoryKey = null
        this.memoryPassword = null
        this.config.store.cloudSync.passwordHash = null
        this.config.store.cloudSync.passwordSalt = null
        this.config.store.cloudSync.lastSync = {
            remoteETag: null,
            remoteModified: null,
            localModified: null,
            localFingerprint: null,
            remoteDeviceId: null,
            remoteDeviceName: null,
        }
        await this.config.save()
    }

    /**
     * 取已存储的密码校验信息
     */
    getVerification (): PasswordVerification | null {
        const cs = this.config.store.cloudSync
        if (!cs?.passwordHash || !cs?.passwordSalt) {
            return null
        }
        return {
            salt: cs.passwordSalt,
            iterations: cs.passwordIterations || 200000,
            hash: cs.passwordHash,
        }
    }

    /**
     * 用当前会话密码 + 任意 salt 派生密钥
     * 用于解密其他设备上传的 payload（其 salt 在 payload.crypto.salt 中明文携带）
     */
    deriveKeyWithSalt (salt: Buffer, iterations: number): Buffer {
        if (!this.memoryPassword) {
            throw new Error('Sync password is not unlocked')
        }
        return deriveKey(this.memoryPassword, salt, iterations)
    }
}
