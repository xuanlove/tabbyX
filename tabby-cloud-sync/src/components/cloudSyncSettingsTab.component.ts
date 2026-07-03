import { Component, OnInit, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService, NotificationsService } from 'tabby-core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'

import { CloudSyncService, SyncStatus, ConflictInfo } from '../services/cloudSync.service'
import { SyncPasswordService } from '../services/syncPassword.service'
import { BackendRegistryService } from '../services/backendRegistry.service'
import { PasswordSetupModalComponent } from './passwordSetupModal.component'
import { ConflictResolveModalComponent } from './conflictResolveModal.component'

/** @hidden */
@Component({
    templateUrl: './cloudSyncSettingsTab.component.pug',
})
export class CloudSyncSettingsTabComponent implements OnInit, OnDestroy {
    private subs: Subscription[] = []
    status: SyncStatus = 'disabled'
    lastError: string | null = null
    testingConnection = false
    connectionResult: { ok: boolean; message?: string } | null = null
    syncing = false

    constructor (
        public config: ConfigService,
        private cloudSync: CloudSyncService,
        private passwordService: SyncPasswordService,
        private backendRegistry: BackendRegistryService,
        private notifications: NotificationsService,
        private modal: NgbModal,
    ) { }

    ngOnInit (): void {
        this.subs.push(
            this.cloudSync.status$.subscribe(s => this.status = s),
            this.cloudSync.lastError$.subscribe(e => this.lastError = e),
            this.cloudSync.conflict$.subscribe(info => this.showConflictModal(info)),
        )
        this.status = this.cloudSync.status$.value
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    get backends () {
        return this.backendRegistry.list()
    }

    get passwordSet () { return this.passwordService.isPasswordSet() }
    get passwordUnlocked () { return this.passwordService.isUnlocked() }

    selectBackend (id: string): void {
        this.config.store.cloudSync.backend = id
        this.connectionResult = null
        this.config.save()
    }

    async setupPassword (): Promise<void> {
        const ref = this.modal.open(PasswordSetupModalComponent)
        ref.componentInstance.mode = 'setup'
        const result = await ref.result
        if (result) {
            try {
                await this.passwordService.setPassword(result)
                this.notifications.info('Sync password set', 'Cloud Sync')
            } catch (e: any) {
                this.notifications.error(e.message, 'Cloud Sync')
            }
        }
    }

    async changePassword (): Promise<void> {
        const ref = this.modal.open(PasswordSetupModalComponent)
        ref.componentInstance.mode = 'change'
        const result = await ref.result
        if (result) {
            try {
                await this.passwordService.changePassword(result.oldPassword, result.newPassword)
                this.notifications.info('Password changed', 'Cloud Sync')
            } catch (e: any) {
                this.notifications.error(e.message, 'Cloud Sync')
            }
        }
    }

    async unlock (): Promise<void> {
        const ref = this.modal.open(PasswordSetupModalComponent)
        ref.componentInstance.mode = 'unlock'
        const result = await ref.result
        if (result) {
            const ok = await this.passwordService.unlock(result)
            if (!ok) {
                this.notifications.error('Wrong password', 'Cloud Sync')
            } else {
                this.notifications.info('Unlocked', 'Cloud Sync')
                this.cloudSync.startAutoSync()
            }
        }
    }

    async clearPassword (): Promise<void> {
        if (!confirm('Clear the sync password? All previously synced encrypted data becomes unrecoverable.')) {
            return
        }
        await this.passwordService.clearPassword()
        await this.cloudSync.disable()
        this.notifications.info('Password cleared', 'Cloud Sync')
    }

    async testConnection (): Promise<void> {
        this.testingConnection = true
        this.connectionResult = null
        try {
            this.connectionResult = await this.cloudSync.testConnection()
        } finally {
            this.testingConnection = false
        }
    }

    async enableSync (): Promise<void> {
        try {
            await this.cloudSync.enable()
            this.notifications.info('Enabled', 'Cloud Sync')
        } catch (e: any) {
            this.notifications.error(e.message, 'Cloud Sync')
        }
    }

    async disableSync (): Promise<void> {
        await this.cloudSync.disable()
        this.notifications.info('Disabled', 'Cloud Sync')
    }

    async uploadNow (): Promise<void> {
        this.syncing = true
        try {
            await this.cloudSync.uploadNow()
            this.notifications.info('Upload complete', 'Cloud Sync')
        } catch (e: any) {
            this.notifications.error(e.message, 'Cloud Sync')
        } finally {
            this.syncing = false
        }
    }

    async downloadNow (): Promise<void> {
        this.syncing = true
        try {
            await this.cloudSync.downloadNow()
            this.notifications.info('Download complete', 'Cloud Sync')
        } catch (e: any) {
            this.notifications.error(e.message, 'Cloud Sync')
        } finally {
            this.syncing = false
        }
    }

    private async showConflictModal (info: ConflictInfo): Promise<void> {
        const ref = this.modal.open(ConflictResolveModalComponent)
        ref.componentInstance.info = info
        const result = await ref.result
        if (result) {
            this.cloudSync.resolveConflictWith(result.resolution, result.applyToSession)
        }
    }
}
