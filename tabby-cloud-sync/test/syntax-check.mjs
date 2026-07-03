#!/usr/bin/env node
/**
 * 语法检查：对每个 .ts 源文件尝试动态 import，
 * 用 --experimental-strip-types + ts-loader 解析。
 * 语法错误（SyntaxError / ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）算失败；
 * 外部依赖缺失（ERR_MODULE_NOT_FOUND）算通过（语法 OK）。
 */
import { readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

function walkDir (dir) {
    const results = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            results.push(...walkDir(full))
        } else if (entry.endsWith('.ts')) {
            results.push(full)
        }
    }
    return results
}

const files = walkDir('src')
let syntaxErrors = 0
let ok = 0

// 为每个文件生成一个临时 importer .mts，用 strip-types 运行
const tmpDir = '.syntax-tmp'
mkdirSync(tmpDir, { recursive: true })

for (const file of files) {
    const importerPath = join(tmpDir, `import-${file.replace(/[/\\]/g, '_')}.mts`)
    // 动态 import 目标文件，catch 所有错误（语法错误会在此抛出）
    const importerCode = `import ${JSON.stringify('../../' + file.replace(/\\/g, '/'))}\n`
    writeFileSync(importerPath, importerCode)
    try {
        execFileSync('node', [
            '--experimental-strip-types',
            '--no-warnings',
            '--loader', './test/ts-loader.mjs',
            importerPath,
        ], { stdio: 'pipe', timeout: 5000, cwd: process.cwd() })
        ok++
        console.log(`  ✓ ${file}`)
    } catch (e) {
        const stderr = e.stderr?.toString() ?? ''
        if (stderr.includes('SyntaxError') || stderr.includes('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
            syntaxErrors++
            console.log(`  ✗ ${file}`)
            const lines = stderr.split('\n')
            const errLine = lines.find(l => l.includes('SyntaxError') || l.includes('ERR_UNSUPPORTED'))
            console.log(`    ${errLine?.trim() ?? stderr.slice(0, 300)}`)
        } else {
            // ERR_MODULE_NOT_FOUND 等：语法 OK
            ok++
            console.log(`  ✓ ${file} (语法 OK)`)
        }
    } finally {
        try { unlinkSync(importerPath) } catch {}
    }
}

// 清理临时目录
try { for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f)) } catch {}

console.log(`\n=== 语法检查结果 ===`)
console.log(`语法正确: ${ok}/${files.length}, 语法错误: ${syntaxErrors}`)
if (syntaxErrors > 0) process.exit(1)
