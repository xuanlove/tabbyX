import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, AppService, TranslateService } from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'

import { CloudSyncService } from './services/cloudSync.service'

/** @hidden */
@Injectable()
export class CloudSyncButtonProvider extends ToolbarButtonProvider {
    constructor (
        private app: AppService,
        private translate: TranslateService,
        private cloudSync: CloudSyncService,
    ) {
        super()
    }

    provide (): ToolbarButton[] {
        if (!this.cloudSync.isEnabled()) {
            return []
        }
        const status = this.cloudSync.status$.value
        return [{
            icon: require('./icons/cloud.svg'),
            title: this.getTitle(status),
            weight: 50,
            click: (): void => this.openSettings(),
        }]
    }

    private getTitle (status: string): string {
        switch (status) {
            case 'syncing': return this.translate.instant('Cloud Sync: syncing…')
            case 'error': return this.translate.instant('Cloud Sync: error')
            case 'conflict': return this.translate.instant('Cloud Sync: conflict pending')
            case 'locked': return this.translate.instant('Cloud Sync: locked')
            default: return this.translate.instant('Cloud Sync')
        }
    }

    private openSettings (): void {
        const tab = this.app.tabs.find(t => t instanceof SettingsTabComponent) as SettingsTabComponent
        if (tab) {
            this.app.selectTab(tab)
            tab.activeTab = 'cloud-sync'
        } else {
            this.app.openNewTabRaw({
                type: SettingsTabComponent,
                inputs: { activeTab: 'cloud-sync' },
            })
        }
    }
}
