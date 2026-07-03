import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { ConflictInfo, ConflictResolution } from '../services/cloudSync.service'

/** @hidden */
@Component({
    templateUrl: './conflictResolveModal.component.pug',
})
export class ConflictResolveModalComponent {
    info: ConflictInfo
    choice: ConflictResolution = 'use-remote'
    applyToSession = false

    constructor (
        private modalInstance: NgbActiveModal,
    ) { }

    ok (): void {
        this.modalInstance.close({ resolution: this.choice, applyToSession: this.applyToSession })
    }

    cancel (): void {
        this.modalInstance.close({ resolution: 'cancel' as ConflictResolution, applyToSession: false })
    }

    formatDate (d?: Date): string {
        if (!d) return 'unknown'
        return d.toLocaleString()
    }
}
