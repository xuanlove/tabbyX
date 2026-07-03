/**
 * 单元测试：crypto + payload 核心逻辑
 * 用 Node.js 内置能力验证，不依赖外部库
 */
import * as assert from 'assert'
import * as crypto from 'crypto'
import * as zlib from 'zlib'

// 从源码导入（Node 24 strip-types 直接运行 .ts）
import {
    setupPassword, verifyPassword, deriveKeyFromVerification,
    encrypt, decrypt, fingerprint, generateDeviceId, generateSalt,
} from '../src/api/crypto.ts'
import {
    buildPayload, serializePayload, parsePayload, extractEncryptedBlob,
    PAYLOAD_VERSION,
} from '../src/api/payload.ts'

let passed = 0
let failed = 0

function test (name: string, fn: () => void): void {
    try {
        fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (e: any) {
        failed++
        console.log(`  ✗ ${name}`)
        console.log(`    ${e.message}`)
    }
}

async function testAsync (name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (e: any) {
        failed++
        console.log(`  ✗ ${name}`)
        console.log(`    ${e.message}`)
    }
}

console.log('\n=== crypto.ts 测试 ===')

test('setupPassword 生成校验信息', () => {
    const { verification, key } = setupPassword('mypassword')
    assert.ok(verification.salt, 'salt 应存在')
    assert.ok(verification.hash, 'hash 应存在')
    assert.strictEqual(verification.iterations, 200000)
    assert.strictEqual(key.length, 32, '密钥应为 32 字节')
})

test('verifyPassword 正确密码返回 true', () => {
    const { verification } = setupPassword('mypassword')
    assert.strictEqual(verifyPassword('mypassword', verification), true)
})

test('verifyPassword 错误密码返回 false', () => {
    const { verification } = setupPassword('mypassword')
    assert.strictEqual(verifyPassword('wrongpassword', verification), false)
})

test('verifyPassword 定时安全（不抛错）', () => {
    const { verification } = setupPassword('test123')
    // 多次调用不应抛错
    for (let i = 0; i < 100; i++) {
        verifyPassword('test123', verification)
        verifyPassword('wrong', verification)
    }
})

test('deriveKeyFromVerification 与 setupPassword 派生相同密钥', () => {
    const password = 'mypassword'
    const { verification, key } = setupPassword(password)
    const derivedKey = deriveKeyFromVerification(password, verification)
    assert.deepStrictEqual(Buffer.from(derivedKey), Buffer.from(key))
})

test('encrypt + decrypt 往返一致', () => {
    const { key } = setupPassword('test')
    const plaintext = Buffer.from('Hello Tabby Cloud Sync!', 'utf8')
    const encrypted = encrypt(plaintext, key)
    const decrypted = decrypt(encrypted, key)
    assert.deepStrictEqual(Buffer.from(decrypted), Buffer.from(plaintext))
})

test('encrypt 加密后内容不同（含随机 IV）', () => {
    const { key } = setupPassword('test')
    const plaintext = Buffer.from('same data', 'utf8')
    const e1 = encrypt(plaintext, key)
    const e2 = encrypt(plaintext, key)
    assert.notStrictEqual(e1.ciphertext, e2.ciphertext, 'IV 随机应使密文不同')
    assert.notStrictEqual(e1.iv, e2.iv)
})

test('decrypt 错误密码抛出错误', () => {
    const { key: key1 } = setupPassword('password1')
    const { key: key2 } = setupPassword('password2')
    const encrypted = encrypt(Buffer.from('secret'), key1)
    assert.throws(() => decrypt(encrypted, key2), /Decryption failed/)
})

test('decrypt 篡改密文抛出错误（GCM 认证）', () => {
    const { key } = setupPassword('test')
    const encrypted = encrypt(Buffer.from('secret'), key)
    // 篡改密文
    const tampered = {
        ciphertext: encrypted.ciphertext.slice(0, -4) + 'AAAA',
        iv: encrypted.iv,
        tag: encrypted.tag,
    }
    assert.throws(() => decrypt(tampered, key))
})

test('decrypt 篡改认证标签抛出错误', () => {
    const { key } = setupPassword('test')
    const encrypted = encrypt(Buffer.from('secret'), key)
    const tampered = {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: Buffer.from('0'.repeat(32)).toString('base64'),
    }
    assert.throws(() => decrypt(tampered, key))
})

test('加密压缩比验证（YAML 数据压缩显著）', () => {
    const { key } = setupPassword('test')
    // 模拟真实 profiles YAML
    const yaml = Array.from({ length: 50 }, (_, i) =>
        `- id: ssh:server-${i}\n  type: ssh\n  options:\n    host: server-${i}.example.com\n    user: root\n    port: 22\n`
    ).join('')
    const plaintext = Buffer.from(yaml, 'utf8')
    const encrypted = encrypt(plaintext, key)
    const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64')
    // 压缩 + 加密后应显著小于原文
    assert.ok(ciphertextBuf.length < plaintext.length,
        `密文 ${ciphertextBuf.length} 应小于原文 ${plaintext.length}`)
    console.log(`    原文 ${plaintext.length}B → 密文 ${ciphertextBuf.length}B (${Math.round(ciphertextBuf.length/plaintext.length*100)}%)`)
})

test('fingerprint 相同数据返回相同值', () => {
    const fp1 = fingerprint('hello')
    const fp2 = fingerprint('hello')
    const fp3 = fingerprint('world')
    assert.strictEqual(fp1, fp2)
    assert.notStrictEqual(fp1, fp3)
    assert.strictEqual(fp1.length, 64, 'SHA-256 hex 应为 64 字符')
})

test('fingerprint 支持 Buffer 输入', () => {
    const fp1 = fingerprint(Buffer.from('hello', 'utf8'))
    const fp2 = fingerprint('hello')
    assert.strictEqual(fp1, fp2)
})

test('generateDeviceId 返回 uuid 格式', () => {
    const id = generateDeviceId()
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const id2 = generateDeviceId()
    assert.notStrictEqual(id, id2, '应生成唯一 ID')
})

test('generateSalt 返回 16 字节随机值', () => {
    const salt = generateSalt()
    assert.strictEqual(salt.length, 16)
    const salt2 = generateSalt()
    assert.notStrictEqual(salt.toString('hex'), salt2.toString('hex'))
})


console.log('\n=== payload.ts 测试 ===')

test('buildPayload 构造完整 payload', () => {
    const { verification, key } = setupPassword('test')
    const plaintext = Buffer.from('test data', 'utf8')
    const encrypted = encrypt(plaintext, key)
    const fp = fingerprint('test data')

    const payload = buildPayload({
        encrypted,
        salt: verification.salt,
        iterations: verification.iterations,
        fingerprint: fp,
        deviceId: 'device-123',
        deviceName: 'MY-LAPTOP',
        tabbyVersion: '1.0.231',
    })

    assert.strictEqual(payload.version, PAYLOAD_VERSION)
    assert.strictEqual(payload.sourceDevice, 'device-123')
    assert.strictEqual(payload.sourceDeviceName, 'MY-LAPTOP')
    assert.strictEqual(payload.fingerprint, fp)
    assert.strictEqual(payload.crypto.algo, 'aes-256-gcm')
    assert.strictEqual(payload.crypto.kdf, 'pbkdf2-sha256')
    assert.strictEqual(payload.compression, 'gzip')
    assert.ok(payload.data, 'data 字段应存在')
    assert.ok(payload.createdAt)
})

test('serializePayload + parsePayload 往返一致', () => {
    const { verification, key } = setupPassword('test')
    const encrypted = encrypt(Buffer.from('test'), key)
    const payload = buildPayload({
        encrypted,
        salt: verification.salt,
        iterations: verification.iterations,
        fingerprint: 'fp123',
        deviceId: 'dev1',
        deviceName: 'PC1',
        tabbyVersion: '1.0',
    })

    const buffer = serializePayload(payload)
    assert.ok(Buffer.isBuffer(buffer))

    const parsed = parsePayload(buffer)
    assert.strictEqual(parsed.version, payload.version)
    assert.strictEqual(parsed.sourceDevice, payload.sourceDevice)
    assert.strictEqual(parsed.fingerprint, payload.fingerprint)
    assert.strictEqual(parsed.data, payload.data)
})

test('parsePayload 拒绝无效数据', () => {
    assert.throws(() => parsePayload(Buffer.from('not json')), /SyntaxError|Unexpected/)
    assert.throws(() => parsePayload(Buffer.from('{}')), /missing version/)
})

test('parsePayload 拒绝过高版本', () => {
    const futurePayload = { version: 999 }
    assert.throws(() => parsePayload(Buffer.from(JSON.stringify(futurePayload))),
        /Unsupported payload version/)
})

test('extractEncryptedBlob 提取正确', () => {
    const { verification, key } = setupPassword('test')
    const encrypted = encrypt(Buffer.from('secret'), key)
    const payload = buildPayload({
        encrypted,
        salt: verification.salt,
        iterations: verification.iterations,
        fingerprint: 'fp',
        deviceId: 'd',
        deviceName: 'n',
        tabbyVersion: '1',
    })
    const blob = extractEncryptedBlob(payload)
    assert.strictEqual(blob.ciphertext, encrypted.ciphertext)
    assert.strictEqual(blob.iv, encrypted.iv)
    assert.strictEqual(blob.tag, encrypted.tag)
})

test('端到端：加密 → payload → 序列化 → 反序列化 → 解密', () => {
    const { verification, key } = setupPassword('mypassword')
    const originalData = 'profiles:\n  - id: ssh:server1\n    host: example.com\n'

    // 加密
    const encrypted = encrypt(Buffer.from(originalData, 'utf8'), key)
    const fp = fingerprint(originalData)

    // 构造 payload
    const payload = buildPayload({
        encrypted,
        salt: verification.salt,
        iterations: verification.iterations,
        fingerprint: fp,
        deviceId: 'device-A',
        deviceName: 'OFFICE-PC',
        tabbyVersion: '1.0.231',
    })

    // 序列化（模拟上传到云端）
    const wireData = serializePayload(payload)

    // 反序列化（模拟从云端下载）
    const receivedPayload = parsePayload(wireData)

    // 提取密文并解密
    const receivedBlob = extractEncryptedBlob(receivedPayload)
    const decrypted = decrypt(receivedBlob, key)
    const recoveredData = decrypted.toString('utf8')

    assert.strictEqual(recoveredData, originalData, '数据应完整往返')
    assert.strictEqual(receivedPayload.sourceDevice, 'device-A')
    assert.strictEqual(receivedPayload.fingerprint, fp)
})


console.log(`\n=== 测试结果 ===`)
console.log(`通过: ${passed}, 失败: ${failed}`)
if (failed > 0) {
    process.exit(1)
}
