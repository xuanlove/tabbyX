import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCorePlugin, {
    ConfigProvider,
    ToolbarButtonProvider,
} from 'tabby-core'
import TabbySettingsPlugin, { SettingsTabProvider } from 'tabby-settings'

import { CloudSyncConfigProvider } from './config'
import { CloudSyncSettingsTabProvider } from './settings'
import { CloudSyncButtonProvider } from './buttonProvider'

import { CloudSyncService } from './services/cloudSync.service'
import { SyncPasswordService } from './services/syncPassword.service'
import { BackendRegistryService } from './services/backendRegistry.service'

import { SyncBackend } from './api/backend'
import { WebDAVBackend } from './backends/webdav.backend'
import { FTPBackend } from './backends/ftp.backend'
import { S3Backend } from './backends/s3.backend'

import { CloudSyncSettingsTabComponent } from './components/cloudSyncSettingsTab.component'
import { PasswordSetupModalComponent } from './components/passwordSetupModal.component'
import { ConflictResolveModalComponent } from './components/conflictResolveModal.component'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCorePlugin,
        TabbySettingsPlugin,
    ],
    providers: [
        { provide: ConfigProvider, useClass: CloudSyncConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: CloudSyncSettingsTabProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: CloudSyncButtonProvider, multi: true },
        // 后端注册（DI multi-provider，第三方插件可扩展新协议）
        { provide: SyncBackend, useClass: WebDAVBackend, multi: true },
        { provide: SyncBackend, useClass: FTPBackend, multi: true },
        { provide: SyncBackend, useClass: S3Backend, multi: true },
    ],
    declarations: [
        CloudSyncSettingsTabComponent,
        PasswordSetupModalComponent,
        ConflictResolveModalComponent,
    ],
    entryComponents: [
        PasswordSetupModalComponent,
        ConflictResolveModalComponent,
    ],
})
export default class CloudSyncModule {
    // 注入这些服务以确保它们在应用启动时被实例化并开始监听 config.changed$
    constructor (
        private cloudSync: CloudSyncService,
        private passwordService: SyncPasswordService,
        private backendRegistry: BackendRegistryService,
    ) {
        // 引用以触发服务实例化（构造函数副作用：注册监听器）
        void this.cloudSync
        void this.passwordService
        void this.backendRegistry
    }
}

export * from './api'
export { CloudSyncService, SyncStatus, ConflictInfo, ConflictResolution } from './services/cloudSync.service'
export { SyncPasswordService } from './services/syncPassword.service'
export { BackendRegistryService } from './services/backendRegistry.service'
export { WebDAVBackend } from './backends/webdav.backend'
export { FTPBackend } from './backends/ftp.backend'
export { S3Backend } from './backends/s3.backend'
