/**
 * 集成测试：模拟真人用户的完整云同步流程。
 *
 * 不依赖 Angular DI / tabby-core / js-yaml，而是用轻量 mock 复刻
 * CloudSyncService 的核心编排逻辑（uploadIfChanged / checkRemoteAndDownload /
 * resolveConflict / doUpload / applyRemotePayload），并真实调用 crypto + payload。
 *
 * 覆盖场景：
 *  1. 设备 A：设置密码 → 启用 → 上传 profiles
 *  2. 设备 B：设置相同密码 → 启用 → 下载 → 数据一致
 *  3. 设备 A 修改 profiles → 重新上传
 *  4. 设备 B 也有本地修改 → 触发多设备并发 → prompt 弹窗 → use-remote
 *  5. 同样场景 → use-local（用本地覆盖远端）
 *  6. 同样场景 → cancel（保留冲突状态）
 *  7. sessionConflictChoice 批量应用
 *  8. 错误密码无法解密远端数据
 *  9. forcePromptOnMultiDevice=true 时即使 strategy=newest 也弹窗
 * 10. strategy=manual 直接 cancel
 * 11. 同设备上传不触发冲突
 */
import * as assert from 'assert'

// 真实模块：值导入（函数、常量）
import {
    setupPassword, verifyPassword, deriveKeyFromVerification,
    deriveKey,
    encrypt, decrypt, fingerprint, generateDeviceId,
} from '../src/api/crypto.ts'
import {
    buildPayload, serializePayload, parsePayload,
    extractEncryptedBlob, PAYLOAD_VERSION,
} from '../src/api/payload.ts'
// 类型导入（接口/类型别名，运行时擦除）
import type { EncryptedBlob } from '../src/api/crypto.ts'
import type { SyncPayload, RemoteMeta } from '../src/api/payload.ts'
import type { SyncBackend } from '../src/api/backend.ts'

// ---------- 序列化工具 ----------
// 测试环境无 js-yaml，用 JSON 替代（同步逻辑测试不依赖具体 YAML 格式，
// 只要可往返即可；真实生产代码使用 js-yaml）
const yamlDump = (obj: any): string => JSON.stringify(obj, null, 2)
const yamlLoad = (str: string): any => JSON.parse(str)

// ---------- 简易 mock：内存后端（模拟 WebDAV/S3 等远端存储） ----------
class MemoryBackend implements SyncBackend {
    readonly id = 'memory'
    readonly displayName = 'Memory (test)'
    readonly supportsETag = true
    readonly supportsModifiedTime = true

    private files = new Map<string, { data: Buffer; etag: string; modifiedAt: Date }>()

    async testConnection (_config: any): Promise<{ ok: boolean; message?: string }> {
        return { ok: true }
    }

    async upload (path: string, data: Buffer, _config: any): Promise<RemoteMeta> {
        const etag = `"${Date.now()}-${Math.random().toString(36).slice(2, 10)}"`
        const modifiedAt = new Date()
        this.files.set(path, { data: Buffer.from(data), etag, modifiedAt })
        return { etag, modifiedAt, size: data.length }
    }

    async download (path: string, _config: any): Promise<{ data: Buffer; meta: RemoteMeta } | null> {
        const f = this.files.get(path)
        if (!f) return null
        return { data: Buffer.from(f.data), meta: { etag: f.etag, modifiedAt: f.modifiedAt, size: f.data.length } }
    }

    async stat (path: string, _config: any): Promise<RemoteMeta | null> {
        const f = this.files.get(path)
        if (!f) return null
        return { etag: f.etag, modifiedAt: f.modifiedAt, size: f.data.length }
    }

    async delete (path: string, _config: any): Promise<void> {
        this.files.delete(path)
    }
}

// ---------- mock 配置存储 ----------
interface LastSyncState {
    remoteETag: string | null
    remoteModified: string | null
    localModified: string | null
    localFingerprint: string | null
    remoteDeviceId: string | null
    remoteDeviceName: string | null
}

interface CloudSyncConfig {
    enabled: boolean
    backend: string
    remotePath: string
    deviceId: string
    deviceName: string
    auto: boolean
    autoSyncInterval: number
    conflictStrategy: 'prompt' | 'newest' | 'manual'
    forcePromptOnMultiDevice: boolean
    passwordSalt: string | null
    passwordHash: string | null
    passwordIterations: number
    syncParts: { profiles: boolean; knownHosts: boolean; sshConfigImports: boolean }
    backends: Record<string, any>
    lastSync: LastSyncState
}

interface MockConfigStore {
    profiles: any[]
    profileGroups: any[]
    ssh?: { knownHosts: any[] }
    cloudSync: CloudSyncConfig
}

class MockConfigService {
    store: MockConfigStore
    private listeners: (() => void)[] = []

    constructor (initial: MockConfigStore) {
        this.store = initial
    }

    async save (): Promise<void> { /* no-op */ }
    async load (): Promise<void> { /* no-op */ }

    get changed$ () {
        return {
            pipe: () => ({
                subscribe: (fn: () => void) => {
                    this.listeners.push(fn)
                    return { unsubscribe: () => { this.listeners = this.listeners.filter(l => l !== fn) } }
                },
            }),
        }
    }

    emitChange (): void {
        this.listeners.forEach(l => l())
    }
}

// ---------- mock 密码服务 ----------
class MockPasswordService {
    private key: Buffer | null = null
    private password: string | null = null
    private verification: { salt: string; iterations: number; hash: string } | null = null
    private config: MockConfigService

    constructor (config: MockConfigService) {
        this.config = config
    }

    isPasswordSet (): boolean {
        return !!this.config.store.cloudSync.passwordHash
    }

    isUnlocked (): boolean {
        return !!this.key
    }

    setup (password: string): void {
        const { verification, key } = setupPassword(password)
        this.verification = verification
        this.key = key
        this.password = password
        this.config.store.cloudSync.passwordSalt = verification.salt
        this.config.store.cloudSync.passwordHash = verification.hash
        this.config.store.cloudSync.passwordIterations = verification.iterations
    }

    unlock (password: string): boolean {
        const cs = this.config.store.cloudSync
        if (!cs.passwordHash || !cs.passwordSalt) return false
        const verification = { salt: cs.passwordSalt, iterations: cs.passwordIterations, hash: cs.passwordHash }
        if (!verifyPassword(password, verification)) return false
        this.verification = verification
        this.key = deriveKeyFromVerification(password, verification)
        this.password = password
        return true
    }

    lock (): void {
        this.key = null
        this.password = null
    }

    getKey (): Buffer {
        if (!this.key) throw new Error('Password not unlocked')
        return this.key
    }

    getVerification () {
        return this.verification
    }

    /** 用当前会话密码 + 任意 salt 派生密钥（解密其他设备的 payload） */
    deriveKeyWithSalt (salt: Buffer, iterations: number): Buffer {
        if (!this.password) throw new Error('Password not unlocked')
        return deriveKey(this.password, salt, iterations)
    }
}

// ---------- 复刻 CloudSyncService 的核心逻辑（去掉 Angular 依赖） ----------
type ConflictResolution = 'use-remote' | 'use-local' | 'cancel'

interface ConflictInfo {
    remote: { modifiedAt?: Date; deviceId?: string; deviceName?: string; fingerprint?: string }
    local: { modifiedAt?: Date; deviceId?: string; deviceName?: string; fingerprint?: string }
}

class TestSyncService {
    private isSyncing = false
    private sessionConflictChoice: ConflictResolution | null = null
    status: string = 'disabled'
    lastError: string | null = null
    pendingConflict: ConflictInfo | null = null
    private conflictWaiter: ((r: ConflictResolution) => void) | null = null
    private config: MockConfigService
    private passwordService: MockPasswordService
    private backend: MemoryBackend

    constructor (
        config: MockConfigService,
        passwordService: MockPasswordService,
        backend: MemoryBackend,
    ) {
        this.config = config
        this.passwordService = passwordService
        this.backend = backend
    }

    isEnabled (): boolean {
        return !!this.config.store.cloudSync.enabled
    }

    async enable (): Promise<void> {
        if (!this.passwordService.isPasswordSet()) throw new Error('Sync password is not set')
        if (!this.config.store.cloudSync.backend) throw new Error('No backend selected')
        if (!this.config.store.cloudSync.deviceId) {
            this.config.store.cloudSync.deviceId = generateDeviceId()
        }
        if (!this.config.store.cloudSync.deviceName) {
            this.config.store.cloudSync.deviceName = 'TEST-DEVICE'
        }
        this.config.store.cloudSync.enabled = true
        this.updateStatus()
    }

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
        return yamlDump(data)
    }

    async mergeRemoteData (yamlStr: string): Promise<void> {
        const remote = yamlLoad(yamlStr) as any
        const store = this.config.store
        const parts = store.cloudSync.syncParts
        if (parts.profiles) {
            if (Array.isArray(remote.profiles)) store.profiles = remote.profiles
            if (Array.isArray(remote.profileGroups)) store.profileGroups = remote.profileGroups
        }
        if (parts.knownHosts && remote.ssh?.knownHosts) {
            store.ssh = store.ssh ?? {}
            store.ssh.knownHosts = remote.ssh.knownHosts
        }
    }

    getLocalFingerprint (): string {
        return fingerprint(this.collectLocalData())
    }

    private isLocalChanged (): boolean {
        if (!this.config.store.cloudSync.lastSync.localFingerprint) {
            return false
        }
        const localFp = this.getLocalFingerprint()
        return this.config.store.cloudSync.lastSync.localFingerprint !== localFp
    }

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
        const meta = await this.backend.upload(
            this.config.store.cloudSync.remotePath,
            buffer,
            this.config.store.cloudSync.backends[this.config.store.cloudSync.backend],
        )
        const lastSync = this.config.store.cloudSync.lastSync
        lastSync.remoteETag = meta.etag ?? null
        lastSync.remoteModified = meta.modifiedAt?.toISOString() ?? null
        lastSync.localModified = new Date().toISOString()
        lastSync.localFingerprint = localFp
        lastSync.remoteDeviceId = payload.sourceDevice
        lastSync.remoteDeviceName = payload.sourceDeviceName
    }

    private async downloadPayload (): Promise<SyncPayload | null> {
        const result = await this.backend.download(
            this.config.store.cloudSync.remotePath,
            this.config.store.cloudSync.backends[this.config.store.cloudSync.backend],
        )
        if (!result) return null
        return parsePayload(result.data)
    }

    private async getRemoteMeta (): Promise<RemoteMeta | null> {
        return this.backend.stat(
            this.config.store.cloudSync.remotePath,
            this.config.store.cloudSync.backends[this.config.store.cloudSync.backend],
        )
    }

    private async applyRemotePayload (payload: SyncPayload): Promise<void> {
        const salt = Buffer.from(payload.crypto.salt, 'base64')
        const key = this.passwordService.deriveKeyWithSalt(salt, payload.crypto.iterations)
        const blob = extractEncryptedBlob(payload)
        const decrypted = decrypt(blob, key)
        const yamlStr = decrypted.toString('utf8')
        const actualFp = fingerprint(yamlStr)
        if (payload.fingerprint && actualFp !== payload.fingerprint) {
            throw new Error('Remote data fingerprint mismatch — possible corruption')
        }
        await this.mergeRemoteData(yamlStr)
        const lastSync = this.config.store.cloudSync.lastSync
        lastSync.localFingerprint = actualFp
        lastSync.localModified = new Date().toISOString()
        lastSync.remoteDeviceId = payload.sourceDevice
        lastSync.remoteDeviceName = payload.sourceDeviceName
        const meta = await this.getRemoteMeta()
        lastSync.remoteETag = meta?.etag ?? null
        lastSync.remoteModified = meta?.modifiedAt?.toISOString() ?? null
    }

    private async resolveConflict (remotePayload: SyncPayload, remoteMeta: RemoteMeta): Promise<ConflictResolution> {
        if (this.sessionConflictChoice) {
            return this.sessionConflictChoice
        }
        const strategy = this.config.store.cloudSync.conflictStrategy || 'prompt'
        if (strategy === 'newest' && !this.config.store.cloudSync.forcePromptOnMultiDevice) {
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
        this.pendingConflict = info
        return new Promise<ConflictResolution>(resolve => {
            this.conflictWaiter = resolve
        })
    }

    resolveConflictWith (resolution: ConflictResolution, applyToSession: boolean): void {
        if (applyToSession) {
            this.sessionConflictChoice = resolution === 'cancel' ? null : resolution
        }
        const w = this.conflictWaiter
        this.conflictWaiter = null
        this.pendingConflict = null
        if (w) w(resolution)
    }

    async uploadIfChanged (): Promise<boolean> {
        if (this.isSyncing) return false
        this.isSyncing = true
        try {
            this.status = 'syncing'
            const localData = this.collectLocalData()
            const localFp = fingerprint(localData)
            const lastSync = this.config.store.cloudSync.lastSync
            if (lastSync.localFingerprint === localFp) {
                return false
            }
            const remoteMeta = await this.getRemoteMeta()
            if (remoteMeta && lastSync.remoteModified) {
                const remoteModifiedStr = remoteMeta.modifiedAt?.toISOString()
                if (remoteModifiedStr && remoteModifiedStr > lastSync.remoteModified) {
                    const remotePayload = await this.downloadPayload()
                    if (remotePayload && remotePayload.sourceDevice !== this.config.store.cloudSync.deviceId) {
                        const conflictLocal = this.isLocalChanged()
                        if (conflictLocal || this.config.store.cloudSync.forcePromptOnMultiDevice) {
                            const resolution = await this.resolveConflict(remotePayload, remoteMeta)
                            if (resolution === 'use-remote') {
                                await this.applyRemotePayload(remotePayload)
                                return false
                            } else if (resolution === 'cancel') {
                                this.status = 'conflict'
                                return false
                            }
                        }
                    }
                }
            }
            await this.doUpload(localData, localFp)
            return true
        } finally {
            this.isSyncing = false
            this.updateStatus()
        }
    }

    async checkRemoteAndDownload (): Promise<boolean> {
        if (this.isSyncing) return false
        this.isSyncing = true
        try {
            this.status = 'syncing'
            const remoteMeta = await this.getRemoteMeta()
            if (!remoteMeta) {
                return false
            }
            const lastSync = this.config.store.cloudSync.lastSync
            const firstTime = !lastSync.remoteETag && !lastSync.remoteModified
            const etagChanged = remoteMeta.etag && lastSync.remoteETag && remoteMeta.etag !== lastSync.remoteETag
            const modifiedChanged = remoteMeta.modifiedAt && lastSync.remoteModified
                && remoteMeta.modifiedAt.toISOString() > lastSync.remoteModified
            if (!firstTime && !etagChanged && !modifiedChanged) {
                return false
            }
            const payload = await this.downloadPayload()
            if (!payload) {
                return false
            }
            if (payload.sourceDevice === this.config.store.cloudSync.deviceId) {
                await this.applyRemotePayload(payload)
                return true
            }
            const localChanged = this.isLocalChanged()
            if (localChanged) {
                const resolution = await this.resolveConflict(payload, remoteMeta)
                if (resolution === 'use-remote') {
                    await this.applyRemotePayload(payload)
                } else if (resolution === 'use-local') {
                    const localData = this.collectLocalData()
                    const localFp = fingerprint(localData)
                    await this.doUpload(localData, localFp)
                } else {
                    this.status = 'conflict'
                    return false
                }
            } else {
                await this.applyRemotePayload(payload)
            }
            return true
        } finally {
            this.isSyncing = false
            this.updateStatus()
        }
    }

    private updateStatus (): void {
        if (this.status === 'conflict') { return }
        if (!this.isEnabled()) { this.status = 'disabled'; return }
        if (!this.passwordService.isUnlocked()) { this.status = 'locked'; return }
        if (this.isSyncing) { this.status = 'syncing'; return }
        if (this.lastError) { this.status = 'error'; return }
        this.status = 'idle'
    }
}

// ---------- 测试工具：构造一台新设备 ----------
function makeDevice (opts: {
    deviceId?: string
    deviceName: string
    password: string
    conflictStrategy?: 'prompt' | 'newest' | 'manual'
    forcePromptOnMultiDevice?: boolean
    profiles?: any[]
    knownHosts?: any[]
}): {
    config: MockConfigService
    password: MockPasswordService
    service: TestSyncService
} {
    const backend = new MemoryBackend()  // 每台设备独立后端实例（共享通过外层传入）
    const config = new MockConfigService({
        profiles: opts.profiles ?? [],
        profileGroups: [],
        ssh: { knownHosts: opts.knownHosts ?? [] },
        cloudSync: {
            enabled: false,
            backend: 'memory',
            remotePath: 'sync.bin',
            deviceId: opts.deviceId ?? generateDeviceId(),
            deviceName: opts.deviceName,
            auto: true,
            autoSyncInterval: 300,
            conflictStrategy: opts.conflictStrategy ?? 'prompt',
            forcePromptOnMultiDevice: opts.forcePromptOnMultiDevice ?? true,
            passwordSalt: null,
            passwordHash: null,
            passwordIterations: 200000,
            syncParts: { profiles: true, knownHosts: true, sshConfigImports: false },
            backends: { memory: {} },
            lastSync: {
                remoteETag: null,
                remoteModified: null,
                localModified: null,
                localFingerprint: null,
                remoteDeviceId: null,
                remoteDeviceName: null,
            },
        },
    })
    const password = new MockPasswordService(config)
    password.setup(opts.password)
    const service = new TestSyncService(config, password, backend)
    return { config, password, service }
}

// 把两台设备指向同一后端存储
function shareBackend (target: { service: TestSyncService }, source: { service: TestSyncService }): void {
    ;(target.service as any).backend = (source.service as any).backend
}

// ---------- 测试运行器 ----------
let passed = 0
let failed = 0
let expectedTotal = 0
// keep-alive 定时器：防止 Node 在所有异步测试完成前退出
const keepAlive = setInterval(() => {}, 1000)
// 全局超时：30 秒后强制输出结果（防卡死）
const timeout = setTimeout(() => {
    if (passed + failed < expectedTotal) {
        console.log(`\n[超时] 已完成 ${passed + failed}/${expectedTotal}，剩余 ${expectedTotal - passed - failed} 个测试卡住`)
        printResult()
    }
}, 30000)
function expect (n: number) { expectedTotal = n }
function test (name: string, fn: () => void | Promise<void>): void {
    Promise.resolve(fn()).then(() => {
        passed++
        console.log(`  ✓ ${name}`)
        if (passed + failed === expectedTotal) printResult()
    }).catch(e => {
        failed++
        console.log(`  ✗ ${name}`)
        console.log(`    ${e?.message || e}`)
        if (e?.stack) console.log(`    ${e.stack.split('\n')[1]?.trim() ?? ''}`)
        if (passed + failed === expectedTotal) printResult()
    })
}
function printResult () {
    clearInterval(keepAlive)
    clearTimeout(timeout)
    console.log(`\n=== 集成测试结果 ===`)
    console.log(`通过: ${passed}, 失败: ${failed}`)
    if (failed > 0) process.exit(1)
}

// 让测试有微小的时间差，使 modifiedAt 可比较
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------- 场景测试 ----------

console.log('\n=== 场景 1：单设备首次设置 + 上传 ===')
expect(15)

test('1.1 设备 A 设置密码、启用同步、上传 profiles', async () => {
    const A = makeDevice({ deviceName: 'OFFICE-PC', password: 'P@ssw0rd' })
    A.config.store.profiles = [
        { id: 'ssh:server1', type: 'ssh', options: { host: 'srv1.example.com', user: 'root' } },
        { id: 'ssh:server2', type: 'ssh', options: { host: 'srv2.example.com', user: 'root' } },
    ]
    await A.service.enable()
    assert.strictEqual(A.service.isEnabled(), true)
    const uploaded = await A.service.uploadIfChanged()
    assert.strictEqual(uploaded, true, '应成功上传')
    assert.strictEqual(A.service.status, 'idle')
    // lastSync 应已更新
    assert.ok(A.config.store.cloudSync.lastSync.remoteETag, '应有 remoteETag')
    assert.ok(A.config.store.cloudSync.lastSync.localFingerprint, '应有 localFingerprint')
    assert.strictEqual(
        A.config.store.cloudSync.lastSync.remoteDeviceId,
        A.config.store.cloudSync.deviceId,
    )
})

test('1.2 同设备再次上传（无变化）应跳过', async () => {
    const A = makeDevice({ deviceName: 'OFFICE-PC', password: 'P@ssw0rd' })
    A.config.store.profiles = [{ id: 'ssh:x', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()
    const second = await A.service.uploadIfChanged()
    assert.strictEqual(second, false, '无变化应跳过')
})

console.log('\n=== 场景 2：双设备同步——B 下载 A 上传的数据 ===')

test('2.1 设备 B 用相同密码下载，profiles 一致', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'shared-secret' })
    A.config.store.profiles = [
        { id: 'ssh:prod', type: 'ssh', options: { host: 'prod.example.com', user: 'deploy' } },
    ]
    A.config.store.ssh!.knownHosts = [{ host: 'prod.example.com', key: 'ssh-rsa AAA...' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    // 设备 B：相同密码，指向同一后端
    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'shared-secret' })
    shareBackend(B, A)  // 共享 A 的内存后端
    B.config.store.cloudSync.deviceId = generateDeviceId()  // 不同设备 ID
    B.config.store.profiles = []  // 本地为空
    await B.service.enable()
    const downloaded = await B.service.checkRemoteAndDownload()
    assert.strictEqual(downloaded, true, '应有下载')
    assert.strictEqual(B.service.status, 'idle')
    // B 的 profiles 应与 A 一致
    assert.strictEqual(B.config.store.profiles.length, 1)
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:prod')
    assert.strictEqual(B.config.store.profiles[0].options.host, 'prod.example.com')
    // knownHosts 也同步
    assert.strictEqual(B.config.store.ssh!.knownHosts.length, 1)
    assert.strictEqual(B.config.store.ssh!.knownHosts[0].host, 'prod.example.com')
})

test('2.2 错误密码无法解密远端数据', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'correct-password' })
    A.config.store.profiles = [{ id: 'ssh:x', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'WRONG-password' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await assert.rejects(
        () => B.service.checkRemoteAndDownload(),
        /Decryption failed/,
        '错误密码应抛出 Decryption failed',
    )
})

console.log('\n=== 场景 3：多设备并发——prompt 冲突解决 ===')

test('3.1 多设备并发上传：use-remote（采用远端）', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw', conflictStrategy: 'prompt' })
    A.config.store.profiles = [{ id: 'ssh:v1', type: 'ssh', options: { host: 'v1.com' } }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    // B 下载到 v1
    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'pw' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:v1')

    // A 修改为 v2 并上传
    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:v2', type: 'ssh', options: { host: 'v2.com' } }]
    await A.service.uploadIfChanged()

    // B 也修改本地为 v3（与远端 v2 冲突）
    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:v3', type: 'ssh', options: { host: 'v3.com' } }]
    // B 触发上传，应检测到远端被 A 修改，弹窗
    const uploadP = B.service.uploadIfChanged()
    // 等待弹窗出现
    await sleep(50)
    assert.ok(B.service.pendingConflict, '应已弹出冲突对话框')
    assert.strictEqual(B.service.pendingConflict!.remote.deviceName, 'A-PC')
    assert.strictEqual(B.service.pendingConflict!.local.deviceName, 'B-LAPTOP')
    // 用户选择 use-remote
    B.service.resolveConflictWith('use-remote', false)
    await uploadP
    // B 应已采用远端 v2
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:v2')
    assert.strictEqual(B.config.store.profiles[0].options.host, 'v2.com')
})

test('3.2 多设备并发上传：use-local（用本地覆盖远端）', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw', conflictStrategy: 'prompt' })
    A.config.store.profiles = [{ id: 'ssh:base', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'pw' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()

    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:A-new', type: 'ssh' }]
    await A.service.uploadIfChanged()

    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B-new', type: 'ssh' }]
    const uploadP = B.service.uploadIfChanged()
    await sleep(50)
    assert.ok(B.service.pendingConflict)
    // 用户选择 use-local：B 的本地版本覆盖远端
    B.service.resolveConflictWith('use-local', false)
    await uploadP

    // 远端现应是 B 的版本
    const remotePayload = await (B.service as any).backend.download('sync.bin', {})
    const parsed = parsePayload(remotePayload.data)
    assert.strictEqual(parsed.sourceDevice, B.config.store.cloudSync.deviceId)
    // 解密验证内容
    const blob = extractEncryptedBlob(parsed)
    const decrypted = decrypt(blob, B.password.getKey())
    const remoteData = yamlLoad(decrypted.toString('utf8')) as any
    assert.strictEqual(remoteData.profiles[0].id, 'ssh:B-new')
})

test('3.3 多设备并发：cancel 保留冲突状态', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw' })
    A.config.store.profiles = [{ id: 'ssh:base', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'pw' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()

    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:A-version', type: 'ssh' }]
    await A.service.uploadIfChanged()

    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B-version', type: 'ssh' }]
    const uploadP = B.service.uploadIfChanged()
    await sleep(50)
    B.service.resolveConflictWith('cancel', false)
    await uploadP
    assert.strictEqual(B.service.status, 'conflict')
    // 本地仍是 B 的版本，未合并远端
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:B-version')
})

test('3.4 多设备并发下载：use-remote', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw' })
    A.config.store.profiles = [{ id: 'ssh:init', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'pw' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()

    // A 修改并上传
    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:from-A', type: 'ssh' }]
    await A.service.uploadIfChanged()

    // B 本地也修改
    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:from-B', type: 'ssh' }]

    // B 触发下载，应弹窗
    const dlP = B.service.checkRemoteAndDownload()
    await sleep(50)
    assert.ok(B.service.pendingConflict)
    B.service.resolveConflictWith('use-remote', false)
    await dlP
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:from-A')
})

console.log('\n=== 场景 4：会话级批量应用 ===')

test('4.1 applyToSession=true 后续冲突不再弹窗', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw' })
    A.config.store.profiles = [{ id: 'ssh:v0', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'pw' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()

    // 第一轮冲突：用户选择 use-remote 并 applyToSession
    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:v1', type: 'ssh' }]
    await A.service.uploadIfChanged()
    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B-v1', type: 'ssh' }]
    let p = B.service.uploadIfChanged()
    await sleep(50)
    assert.ok(B.service.pendingConflict, '第一次应弹窗')
    B.service.resolveConflictWith('use-remote', true)  // 应用到整个会话
    await p
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:v1')

    // 第二轮：A 再次修改，B 也修改 → 不应弹窗，直接 use-remote
    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:v2', type: 'ssh' }]
    await A.service.uploadIfChanged()
    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B-v2', type: 'ssh' }]
    p = B.service.uploadIfChanged()
    await sleep(50)
    assert.ok(!B.service.pendingConflict, '会话级选择后不应再弹窗')
    await p
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:v2', '应自动采用远端')
})

console.log('\n=== 场景 5：冲突策略 = manual → 直接 cancel ===')

test('5.1 strategy=manual 不弹窗，直接 cancel', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw' })
    A.config.store.profiles = [{ id: 'ssh:init', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    // B 先用 prompt 策略完成首次同步（用户选 use-remote），确保 lastSync 有值
    const B = makeDevice({ deviceName: 'B-LAPTOP', password: 'pw', conflictStrategy: 'prompt' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    const firstDl = B.service.checkRemoteAndDownload()
    await sleep(50)
    B.service.resolveConflictWith('use-remote', false)
    await firstDl
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:init')

    // 切换为 manual 策略
    B.config.store.cloudSync.conflictStrategy = 'manual'

    // A 修改并上传
    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:A', type: 'ssh' }]
    await A.service.uploadIfChanged()

    // B 也修改本地，触发上传 → manual 策略应直接 cancel，不弹窗
    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B', type: 'ssh' }]
    const p = B.service.uploadIfChanged()
    await sleep(50)
    assert.ok(!B.service.pendingConflict, 'manual 策略不应弹窗')
    await p
    assert.strictEqual(B.service.status, 'conflict')
    // 本地保留 B 的版本
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:B')
})

console.log('\n=== 场景 6：forcePromptOnMultiDevice 与 newest 策略 ===')

test('6.1 strategy=newest 且 forcePrompt=false：自动选新者，不弹窗', async () => {
    const A = makeDevice({
        deviceName: 'A-PC', password: 'pw',
        conflictStrategy: 'newest', forcePromptOnMultiDevice: false,
    })
    A.config.store.profiles = [{ id: 'ssh:init', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({
        deviceName: 'B-LAPTOP', password: 'pw',
        conflictStrategy: 'newest', forcePromptOnMultiDevice: false,
    })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()

    // A 较新（后上传）
    await sleep(50)
    A.config.store.profiles = [{ id: 'ssh:A-newer', type: 'ssh' }]
    await A.service.uploadIfChanged()

    // B 本地也有修改但 lastSync.localModified 较早 → 远端更新
    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B-older', type: 'ssh' }]
    const p = B.service.uploadIfChanged()
    await sleep(50)
    assert.ok(!B.service.pendingConflict, 'newest 策略且不强制 prompt 时不应弹窗')
    await p
    // 远端时间更新 → use-remote
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:A-newer')
})

test('6.2 strategy=newest 但 forcePrompt=true：仍弹窗', async () => {
    const A = makeDevice({
        deviceName: 'A-PC', password: 'pw',
        conflictStrategy: 'newest', forcePromptOnMultiDevice: true,
    })
    A.config.store.profiles = [{ id: 'ssh:init', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    const B = makeDevice({
        deviceName: 'B-LAPTOP', password: 'pw',
        conflictStrategy: 'newest', forcePromptOnMultiDevice: true,
    })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await B.service.checkRemoteAndDownload()

    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:A', type: 'ssh' }]
    await A.service.uploadIfChanged()

    await sleep(10)
    B.config.store.profiles = [{ id: 'ssh:B', type: 'ssh' }]
    const p = B.service.uploadIfChanged()
    await sleep(50)
    assert.ok(B.service.pendingConflict, 'forcePromptOnMultiDevice=true 时应弹窗')
    B.service.resolveConflictWith('use-local', false)
    await p
    assert.strictEqual(B.config.store.profiles[0].id, 'ssh:B')
})

console.log('\n=== 场景 7：同设备上传不触发冲突 ===')

test('7.1 同设备上传后下载不弹窗', async () => {
    const A = makeDevice({ deviceName: 'A-PC', password: 'pw' })
    A.config.store.profiles = [{ id: 'ssh:v1', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    // A 自己修改后再上传
    await sleep(10)
    A.config.store.profiles = [{ id: 'ssh:v2', type: 'ssh' }]
    await A.service.uploadIfChanged()

    // A 触发下载检查：远端 sourceDevice == A，应直接应用，不弹窗
    await sleep(10)
    const downloaded = await A.service.checkRemoteAndDownload()
    // 远端就是 A 自己上传的，etag 一致，应返回 false（无变化）
    assert.strictEqual(downloaded, false)
    assert.strictEqual(A.service.status, 'idle')
    assert.ok(!A.service.pendingConflict)
})

console.log('\n=== 场景 8：数据完整性 ===')

test('8.1 远端 payload 头部明文可见设备信息但不泄露内容', async () => {
    const A = makeDevice({ deviceName: 'SECRET-DEVICE', password: 'pw' })
    A.config.store.profiles = [
        { id: 'ssh:prod-db', type: 'ssh', options: { host: '10.0.0.99', user: 'root', password: 'supersecret' } },
    ]
    await A.service.enable()
    await A.service.uploadIfChanged()

    // 直接从后端读 payload（模拟窃听者拿到远端文件）
    const raw = await (A.service as any).backend.download('sync.bin', {})
    const text = raw.data.toString('utf8')
    // 头部明文：deviceName 可见（这是设计如此，便于冲突判断）
    assert.ok(text.includes('SECRET-DEVICE'), '设备名应在头部明文')
    assert.ok(text.includes('"version":1'))
    // 但敏感内容不应明文出现
    assert.ok(!text.includes('supersecret'), '密码不应明文出现')
    assert.ok(!text.includes('10.0.0.99'), '主机不应明文出现')
    assert.ok(!text.includes('prod-db'), 'profile id 不应明文出现')
})

test('8.2 指纹校验防篡改：远端 fingerprint 与解密后内容不匹配应报错', async () => {
    const A = makeDevice({ deviceName: 'A', password: 'pw' })
    A.config.store.profiles = [{ id: 'ssh:orig', type: 'ssh' }]
    await A.service.enable()
    await A.service.uploadIfChanged()

    // 篡改远端 payload 的 fingerprint 字段
    const backend = (A.service as any).backend as MemoryBackend
    const raw = await backend.download('sync.bin', {})
    const payload = parsePayload(raw.data)
    payload.fingerprint = '0'.repeat(64)  // 假指纹
    await backend.upload('sync.bin', serializePayload(payload), {})

    // B 下载应因指纹不匹配抛错
    const B = makeDevice({ deviceName: 'B', password: 'pw' })
    shareBackend(B, A)
    B.config.store.cloudSync.deviceId = generateDeviceId()
    await B.service.enable()
    await assert.rejects(
        () => B.service.checkRemoteAndDownload(),
        /fingerprint mismatch/,
    )
})

console.log(`\n（共 ${expectedTotal} 个集成测试，等待全部完成...）`)
