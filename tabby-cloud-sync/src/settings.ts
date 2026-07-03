import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { CloudSyncSettingsTabComponent } from './components/cloudSyncSettingsTab.component'

/** @hidden */
@Injectable()
export class CloudSyncSettingsTabProvider extends SettingsTabProvider {
    id = 'cloud-sync'
    icon = 'cloud'
    title = 'Cloud Sync'
    weight = 100

    getComponentType (): any {
        return CloudSyncSettingsTabComponent
    }
}
