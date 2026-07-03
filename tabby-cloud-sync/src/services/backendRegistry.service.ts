import { Injectable, Optional, Inject } from '@angular/core'
import { SyncBackend } from '../api/backend'

/**
 * 后端注册表。通过 Angular DI multi-provider 收集所有已注册的 SyncBackend 实现，
 * 按 id 查找当前选中的后端实例。便于第三方插件扩展新协议。
 */
@Injectable({ providedIn: 'root' })
export class BackendRegistryService {
    private backends = new Map<string, SyncBackend>()

    constructor (
        @Optional() @Inject(SyncBackend) injected: SyncBackend[],
    ) {
        if (injected) {
            for (const backend of injected) {
                this.backends.set(backend.id, backend)
            }
        }
    }

    /**
     * 注册一个后端（运行时动态注册用）
     */
    register (backend: SyncBackend): void {
        this.backends.set(backend.id, backend)
    }

    /**
     * 按 id 查找后端
     */
    get (id: string): SyncBackend | null {
        return this.backends.get(id) ?? null
    }

    /**
     * 列出所有已注册后端
     */
    list (): SyncBackend[] {
        return Array.from(this.backends.values())
    }
}
