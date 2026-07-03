/**
 * 自定义 Node ESM loader：把无扩展名的相对导入解析为 .ts 文件。
 * 这样可以在不改源码的前提下用 `node --experimental-strip-types` 直接运行 .ts 测试。
 *
 * 用法：
 *   node --experimental-strip-types --loader ./test/ts-loader.mjs test/unit.test.mts
 */
import { fileURLToPath } from 'node:url'

export function resolve (specifier, context, nextResolve) {
    // 仅处理相对路径且无扩展名的导入
    if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !specifier.endsWith('.ts') &&
        !specifier.endsWith('.js') &&
        !specifier.endsWith('.mjs') &&
        !specifier.endsWith('.json') &&
        !specifier.endsWith('.node')
    ) {
        // 尝试解析为 .ts
        try {
            return nextResolve(specifier + '.ts', context)
        } catch (e) {
            // fall through
        }
    }
    return nextResolve(specifier, context)
}
