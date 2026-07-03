import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { Subject, BehaviorSubject } from 'rxjs'
import { debounceTime } from 'rxjs/operators'
import * as yaml from 'js-yaml'

import { BackendRegistryService } from './backendRegistry.service'
import { SyncPasswordService } from './syncPassword.service'

import {
    encrypt,
    decrypt,
    fingerprint,
    generateDeviceId,
} from '../api/crypto'
import {
    SyncPayload,
    RemoteMeta,
    buildPayload,
    serializePayload,
    parsePayload,
    extractEncryptedBlob,
} from '../api/payload'
import { SyncBackend } from '../api/backend'

/** 同步状态（用于 UI 状态指示） */
export type SyncStatus =
    | 'disabled'        // 未启用
    | 'idle'            // 已启用、已同步、空闲
    | 'syncing'         // 同步中
    | 'error'           // 同步失败
    | 'conflict'        // 冲突待解决
    | 'locked'          // 已启用但密码未解锁

/** 冲突解决选项 */
export type ConflictResolution = 'use-remote' | 'use-local' | 'cancel'

/** 冲突描述（传给弹窗 UI） */
export interface ConflictInfo {
    remote: { modifiedAt?: Date; deviceId?: string; deviceName?: string; fingerprint?: string }
    local: { modifiedAt?: Date; deviceId?: string; deviceName?: string; fingerprint?: string }
}

/**
 * 云同步主服务。负责编排上传/下载/冲突检测/自动同步。
 *
 * 核心流程：
 *  - 上传：收集本地数据 → fingerprint 比较 → 加密压缩 → 后端上传 → 更新 lastSync
 *  - 下载：后端 stat → 与 lastSync 比较 → 下载 → 解密解压 → 合并到 config → 更新 lastSync
 *  - 自动同步：启动时若 enabled && auto，每 autoSyncInterval 秒轮询；config.changed$ debounce 触发上传
 *  - 冲突检测：远端设备 ≠ 本设备 且远端已更新 → 触发 prompt 弹窗
 */
@Injectable({ providedIn: 'root' })
export class CloudSyncService {
    private autoSyncTimer: any = null
    private isSyncing = false
    private sessionConflictChoice: ConflictResolution | null = null

    /** 当前同步状态 */
    readonly status$ = new BehaviorSubject<SyncStatus>('disabled')
    /** 最近一次错误信息 */
    readonly lastError$ = new BehaviorSubject<string | null>(null)
    /** 触发冲突解决弹窗（发出冲突信息，UI 订阅） */
    readonly conflict$ = new Subject<ConflictInfo>()
    /** 用户在弹窗中做出的选择（UI 发出，service 内部订阅） */
    readonly conflictResolution$ = new Subject<ConflictResolution>()
    /** 同步完成通知 */
    readonly syncCompleted$ = new Subject<{ direction: 'upload' | 'download' }>()

    constructor (
        private config: ConfigService,
        private passwordService: SyncPasswordService,
        private backendRegistry: BackendRegistryService,
    ) {
        // 监听配置变更，自动触发上传（debounce 3s，避免频繁同步）
        this.config.changed$.pipe(debounceTime(3000)).subscribe(() => {
            if (this.isEnabled() && this.config.store.cloudSync.auto && this.passwordService.isUnlocked()) {
                this.uploadIfChanged().catch(e => this.handleError(e))
            }
        })

        // 启动时若已启用，开始自动同步
        if (this.isEnabled()) {
            this.startAutoSync()
        }
    }

    /**
     * 是否启用云同步
     */
    isEnabled (): boolean {
        return !!this.config.store.cloudSync?.enabled
    }

    /**
     * 启用云同步（需先设置密码与后端）
     */
    async enable (): Promise<void> {
        if (!this.passwordService.isPasswordSet()) {
            throw new Error('Sync password is not set')
        }
        if (!this.config.store.cloudSync.backend) {
            throw new Error('No backend selected')
        }
        // 生成设备身份
        if (!this.config.store.cloudSync.deviceId) {
            this.config.store.cloudSync.deviceId = generateDeviceId()
        }
        if (!this.config.store.cloudSync.deviceName) {
            this.config.store.cloudSync.deviceName = await this.detectDeviceName()
        }
        this.config.store.cloudSync.enabled = true
        await this.config.save()
        this.updateStatus()
        this.startAutoSync()
    }

    /**
     * 禁用云同步
     */
    async disable (): Promise<void> {
        this.config.store.cloudSync.enabled = false
        await this.config.save()
        this.stopAutoSync()
        this.updateStatus()
    }

    /**
     * 开始自动同步轮询
     */
    startAutoSync (): void {
        this.stopAutoSync()
        if (!this.isEnabled()) return
        const interval = (this.config.store.cloudSync.autoSyncInterval || 300) * 1000
        this.autoSyncTimer = setInterval(() => {
            if (this.passwordService.isUnlocked() && !this.isSyncing) {
                this.checkRemoteAndDownload().catch(e => this.handleError(e))
            }
        }, interval)
        // 立即检查一次
        if (this.passwordService.isUnlocked()) {
            this.checkRemoteAndDownload().catch(e => this.handleError(e))
        }
        this.updateStatus()
    }

    /**
     * 停止自动同步
     */
    stopAutoSync (): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer)
            this.autoSyncTimer = null
        }
    }

    /**
     * 取当前选中的后端实例
     */
    getBackend (): SyncBackend {
        const id = this.config.store.cloudSync.backend
        if (!id) {
            throw new Error('No backend selected')
        }
        const backend = this.backendRegistry.get(id)
        if (!backend) {
            throw new Error(`Backend "${id}" is not registered`)
        }
        return backend
    }

    /**
     * 取当前后端的配置对象
     */
    getBackendConfig (): any {
        const id = this.config.store.cloudSync.backend
        return this.config.store.cloudSync.backends?.[id]
    }

    /**
     * 测试当前后端连接
     */
    async testConnection (): Promise<{ ok: boolean; message?: string }> {
        try {
            const backend = this.getBackend()
            return await backend.testConnection(this.getBackendConfig())
        } catch (e: any) {
            return { ok: false, message: e?.message || String(e) }
        }
    }

    /**
     * 收集本地需要同步的数据，序列化为 YAML 字符串
     */
    collectLocalData (): string {
        const store = this.config.store
        const parts = store.cloudSync.syncParts
        const data: any = {}
        if (parts.profiles) {
            data.profiles = store.profiles ?? []
            data.profileGroups = store.profileGroups ?? []
        }
        if (parts.knownHosts) {
            data.ssh = { knownHosts: store.ssh?.knownHosts ?? [] }
        }
        if (parts.sshConfigImports) {
            data.cloudSync = data.cloudSync ?? {}
            data.cloudSync.sshConfigImports = store.cloudSync?.sshConfigImports ?? null
        }
        // vaultSecrets 由 VaultService 单独处理（阶段三集成）
        return yaml.dump(data, { lineWidth: -1 })
    }

    /**
     * 将下载的 YAML 数据合并到本地 config
     * 保留本地 cloudSync 配置本身，避免自覆盖导致循环
     */
    async mergeRemoteData (yamlStr: string): Promise<void> {
        const remote = yaml.load(yamlStr) as any
        const store = this.config.store
        const parts = store.cloudSync.syncParts

        if (parts.profiles) {
            if (Array.isArray(remote.profiles)) {
                store.profiles = remote.profiles
            }
            if (Array.isArray(remote.profileGroups)) {
                store.profileGroups = remote.profileGroups
            }
        }
        if (parts.knownHosts && remote.ssh?.knownHosts) {
            store.ssh = store.ssh ?? {}
            store.ssh.knownHosts = remote.ssh.knownHosts
        }
        if (parts.sshConfigImports && remote.cloudSync?.sshConfigImports !== undefined) {
            store.cloudSync.sshConfigImports = remote.cloudSync.sshConfigImports
        }
        await this.config.save()
        await this.config.load()
    }

    /**
     * 计算本地数据指纹
     */
    getLocalFingerprint (): string {
        return fingerprint(this.collectLocalData())
    }

    /**
     * 上传（如本地数据有变化）
     */
    async uploadIfChanged (): Promise<boolean> {
        if (this.isSyncing) return false
        this.isSyncing = true
        try {
            this.status$.next('syncing')

            const localData = this.collectLocalData()
            const localFp = fingerprint(localData)
            const lastSync = this.config.store.cloudSync.lastSync

            // 本地未变化则跳过
            if (lastSync.localFingerprint === localFp) {
                this.updateStatus()
                return false
            }

            // 上传前检查远端是否被其他设备更新（避免覆盖他人修改）
            const backend = this.getBackend()
            const remotePath = this.config.store.cloudSync.remotePath
            const remoteMeta = await backend.stat(remotePath, this.getBackendConfig())
            if (remoteMeta && lastSync.remoteModified) {
                const remoteModifiedStr = remoteMeta.modifiedAt?.toISOString()
                if (remoteModifiedStr && remoteModifiedStr > lastSync.remoteModified) {
                    // 远端已被更新，需先下载判断是否来自其他设备
                    const remotePayload = await this.downloadPayload()
                    if (remotePayload && remotePayload.sourceDevice !== this.config.store.cloudSync.deviceId) {
                        // 多设备并发，触发冲突处理
                        const conflictLocal = this.isLocalChanged()
                        if (conflictLocal || this.config.store.cloudSync.forcePromptOnMultiDevice) {
                            const resolution = await this.resolveConflict(remotePayload, remoteMeta)
                            if (resolution === 'use-remote') {
                                await this.applyRemotePayload(remotePayload)
                                this.updateStatus()
                                return false
                            } else if (resolution === 'cancel') {
                                this.status$.next('conflict')
                                return false
                            }
                            // use-local: 继续上传
                        }
                    }
                }
            }

            await this.doUpload(localData, localFp)
            this.syncCompleted$.next({ direction: 'upload' })
            this.updateStatus()
            return true
        } finally {
            this.isSyncing = false
        }
    }

    /**
     * 强制上传（手动触发，跳过 fingerprint 检查但仍做并发保护）
     */
    async uploadNow (): Promise<void> {
        if (this.isSyncing) return
        this.isSyncing = true
        try {
            this.status$.next('syncing')
            const localData = this.collectLocalData()
            const localFp = fingerprint(localData)

            // 手动上传前仍需并发保护
            const backend = this.getBackend()
            const remotePath = this.config.store.cloudSync.remotePath
            const remoteMeta = await backend.stat(remotePath, this.getBackendConfig())
            const lastSync = this.config.store.cloudSync.lastSync
            if (remoteMeta && lastSync.remoteModified) {
                const remoteModifiedStr = remoteMeta.modifiedAt?.toISOString()
                if (remoteModifiedStr && remoteModifiedStr > lastSync.remoteModified) {
                    const remotePayload = await this.downloadPayload()
                    if (remotePayload && remotePayload.sourceDevice !== this.config.store.cloudSync.deviceId) {
                        const resolution = await this.resolveConflict(remotePayload, remoteMeta)
                        if (resolution === 'use-remote') {
                            await this.applyRemotePayload(remotePayload)
                            this.updateStatus()
                            return
                        } else if (resolution === 'cancel') {
                            this.status$.next('conflict')
                            return
                        }
                    }
                }
            }

            await this.doUpload(localData, localFp)
            this.syncCompleted$.next({ direction: 'upload' })
            this.updateStatus()
        } finally {
            this.isSyncing = false
        }
    }

    /**
     * 实际执行加密 + 上传
     */
    private async doUpload (localData: string, localFp: string): Promise<void> {
        const key = this.passwordService.getKey()
        const encrypted = encrypt(Buffer.from(localData, 'utf8'), key)

        const verification = this.passwordService.getVerification()!
        const payload = buildPayload({
            encrypted,
            salt: verification.salt,
            iterations: verification.iterations,
            fingerprint: localFp,
            deviceId: this.config.store.cloudSync.deviceId,
            deviceName: this.config.store.cloudSync.deviceName || 'unknown',
            tabbyVersion: 'tabby-cloud-sync/1.0',
        })

        const buffer = serializePayload(payload)
        const backend = this.getBackend()
        const remotePath = this.config.store.cloudSync.remotePath
        const meta = await backend.upload(remotePath, buffer, this.getBackendConfig())

        // 更新 lastSync
        const lastSync = this.config.store.cloudSync.lastSync
        lastSync.remoteETag = meta.etag ?? null
        lastSync.remoteModified = meta.modifiedAt?.toISOString() ?? null
        lastSync.localModified = new Date().toISOString()
        lastSync.localFingerprint = localFp
        lastSync.remoteDeviceId = payload.sourceDevice
        lastSync.remoteDeviceName = payload.sourceDeviceName
        await this.config.save()
    }

    /**
     * 检查远端是否更新，若是则下载并应用
     */
    async checkRemoteAndDownload (): Promise<boolean> {
        if (this.isSyncing) return false
        this.isSyncing = true
        try {
            this.status$.next('syncing')
            const backend = this.getBackend()
            const remotePath = this.config.store.cloudSync.remotePath
            const remoteMeta = await backend.stat(remotePath, this.getBackendConfig())
            if (!remoteMeta) {
                this.updateStatus()
                return false
            }

            const lastSync = this.config.store.cloudSync.lastSync
            // ETag 或 modifiedAt 任一变化都视为有更新
            const etagChanged = remoteMeta.etag && lastSync.remoteETag && remoteMeta.etag !== lastSync.remoteETag
            const modifiedChanged = remoteMeta.modifiedAt && lastSync.remoteModified
                && remoteMeta.modifiedAt.toISOString() > lastSync.remoteModified
            if (!etagChanged && !modifiedChanged) {
                this.updateStatus()
                return false
            }

            // 下载 payload
            const payload = await this.downloadPayload()
            if (!payload) {
                this.updateStatus()
                return false
            }

            // 同设备上传：直接覆盖本地（无冲突）
            if (payload.sourceDevice === this.config.store.cloudSync.deviceId) {
                await this.applyRemotePayload(payload)
                this.syncCompleted$.next({ direction: 'download' })
                this.updateStatus()
                return true
            }

            // 多设备并发：判断是否需要 prompt
            const localChanged = this.isLocalChanged()
            const strategy = this.config.store.cloudSync.conflictStrategy || 'prompt'
            const forcePrompt = this.config.store.cloudSync.forcePromptOnMultiDevice

            if (localChanged || strategy === 'prompt' || forcePrompt) {
                const resolution = await this.resolveConflict(payload, remoteMeta)
                if (resolution === 'use-remote') {
                    await this.applyRemotePayload(payload)
                    this.syncCompleted$.next({ direction: 'download' })
                } else if (resolution === 'use-local') {
                    // 上传本地覆盖远端
                    const localData = this.collectLocalData()
                    const localFp = fingerprint(localData)
                    await this.doUpload(localData, localFp)
                    this.syncCompleted$.next({ direction: 'upload' })
                } else {
                    // cancel
                    this.status$.next('conflict')
                    return false
                }
            } else {
                // strategy === 'newest' 且未强制 prompt 且本地未变 → 单向更新，直接下载
                await this.applyRemotePayload(payload)
                this.syncCompleted$.next({ direction: 'download' })
            }

            this.updateStatus()
            return true
        } finally {
            this.isSyncing = false
        }
    }

    /**
     * 强制下载（手动触发，跳过 fingerprint 检查但仍做并发保护）
     */
    async downloadNow (): Promise<void> {
        if (this.isSyncing) return
        this.isSyncing = true
        try {
            this.status$.next('syncing')
            const payload = await this.downloadPayload()
            if (!payload) {
                this.updateStatus()
                return
            }

            // 本地有未同步修改时弹窗确认
            if (this.isLocalChanged()) {
                const resolution = await this.resolveConflict(payload, await this.getRemoteMeta())
                if (resolution !== 'use-remote') {
                    if (resolution === 'cancel') {
                        this.status$.next('conflict')
                    } else {
                        this.updateStatus()
                    }
                    return
                }
            }

            await this.applyRemotePayload(payload)
            this.syncCompleted$.next({ direction: 'download' })
            this.updateStatus()
        } finally {
            this.isSyncing = false
        }
    }

    /**
     * 下载远端 payload（不解密）
     */
    private async downloadPayload (): Promise<SyncPayload | null> {
        const backend = this.getBackend()
        const remotePath = this.config.store.cloudSync.remotePath
        const result = await backend.download(remotePath, this.getBackendConfig())
        if (!result) return null
        return parsePayload(result.data)
    }

    /**
     * 取远端元信息
     */
    private async getRemoteMeta (): Promise<RemoteMeta | null> {
        const backend = this.getBackend()
        const remotePath = this.config.store.cloudSync.remotePath
        return backend.stat(remotePath, this.getBackendConfig())
    }

    /**
     * 解密 + 合并远端 payload 到本地
     */
    private async applyRemotePayload (payload: SyncPayload): Promise<void> {
        const key = this.passwordService.getKey()
        const blob = extractEncryptedBlob(payload)
        const decrypted = decrypt(blob, key)
        const yamlStr = decrypted.toString('utf8')

        // 校验指纹（可选，防篡改）
        const actualFp = fingerprint(yamlStr)
        if (payload.fingerprint && actualFp !== payload.fingerprint) {
            throw new Error('Remote data fingerprint mismatch — possible corruption')
        }

        await this.mergeRemoteData(yamlStr)

        // 更新 lastSync
        const lastSync = this.config.store.cloudSync.lastSync
        lastSync.remoteETag = null  // 无法在 download 时拿到 etag，stat 时再更新
        lastSync.localFingerprint = actualFp
        lastSync.localModified = new Date().toISOString()
        lastSync.remoteDeviceId = payload.sourceDevice
        lastSync.remoteDeviceName = payload.sourceDeviceName
        // 重新 stat 取 etag/modifiedAt
        try {
            const meta = await this.getRemoteMeta()
            lastSync.remoteETag = meta?.etag ?? null
            lastSync.remoteModified = meta?.modifiedAt?.toISOString() ?? null
        } catch { /* 忽略 stat 失败 */ }
        await this.config.save()
    }

    /**
     * 本地是否有未同步修改
     */
    private isLocalChanged (): boolean {
        const localFp = this.getLocalFingerprint()
        return this.config.store.cloudSync.lastSync.localFingerprint !== localFp
    }

    /**
     * 触发冲突解决（默认 prompt 弹窗）
     * 若用户在本次会话已选择「应用相同选择」，则直接返回该选择
     */
    private async resolveConflict (remotePayload: SyncPayload, remoteMeta: RemoteMeta): Promise<ConflictResolution> {
        if (this.sessionConflictChoice) {
            return this.sessionConflictChoice
        }
        const strategy = this.config.store.cloudSync.conflictStrategy || 'prompt'
        if (strategy === 'newest' && !this.config.store.cloudSync.forcePromptOnMultiDevice) {
            // 比较时间，新者胜
            const remoteTime = remoteMeta.modifiedAt?.getTime() ?? 0
            const localTime = this.config.store.cloudSync.lastSync.localModified
                ? new Date(this.config.store.cloudSync.lastSync.localModified).getTime()
                : 0
            return remoteTime > localTime ? 'use-remote' : 'use-local'
        }
        if (strategy === 'manual') {
            return 'cancel'
        }

        // prompt
        const info: ConflictInfo = {
            remote: {
                modifiedAt: remoteMeta.modifiedAt,
                deviceId: remotePayload.sourceDevice,
                deviceName: remotePayload.sourceDeviceName,
                fingerprint: remotePayload.fingerprint,
            },
            local: {
                modifiedAt: this.config.store.cloudSync.lastSync.localModified
                    ? new Date(this.config.store.cloudSync.lastSync.localModified) : undefined,
                deviceId: this.config.store.cloudSync.deviceId ?? undefined,
                deviceName: this.config.store.cloudSync.deviceName ?? undefined,
                fingerprint: this.getLocalFingerprint(),
            },
        }
        return new Promise<ConflictResolution>(resolve => {
            const sub = this.conflictResolution$.subscribe(resolution => {
                sub.unsubscribe()
                resolve(resolution)
            })
            this.conflict$.next(info)
        })
    }

    /**
     * 由 UI 调用：用户在弹窗中做出的选择
     * @param resolution 用户选择
     * @param applyToSession 是否对本次会话所有冲突应用相同选择
     */
    resolveConflictWith (resolution: ConflictResolution, applyToSession: boolean): void {
        if (applyToSession) {
            this.sessionConflictChoice = resolution === 'cancel' ? null : resolution
        }
        this.conflictResolution$.next(resolution)
    }

    /**
     * 探测设备友好名
     */
    private async detectDeviceName (): Promise<string> {
        try {
            const os = require('os')
            return os.hostname() || 'unknown-device'
        } catch {
            return 'unknown-device'
        }
    }

    private updateStatus (): void {
        if (!this.isEnabled()) {
            this.status$.next('disabled')
            return
        }
        if (!this.passwordService.isUnlocked()) {
            this.status$.next('locked')
            return
        }
        if (this.isSyncing) {
            this.status$.next('syncing')
            return
        }
        if (this.lastError$.value) {
            this.status$.next('error')
            return
        }
        this.status$.next('idle')
    }

    private handleError (e: any): void {
        const msg = e?.message || String(e)
        this.lastError$.next(msg)
        this.status$.next('error')
    }

    /**
     * 清除错误状态
     */
    clearError (): void {
        this.lastError$.next(null)
        this.updateStatus()
    }
}
