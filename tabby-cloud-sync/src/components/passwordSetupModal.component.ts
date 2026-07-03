import { Component, ViewChild, ElementRef } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

export type PasswordSetupMode = 'setup' | 'change' | 'unlock'

/** @hidden */
@Component({
    templateUrl: './passwordSetupModal.component.pug',
})
export class PasswordSetupModalComponent {
    mode: PasswordSetupMode = 'setup'
    password = ''
    confirmPassword = ''
    oldPassword = ''
    showPassword = false
    error: string | null = null

    @ViewChild('firstInput') firstInput: ElementRef

    constructor (
        private modalInstance: NgbActiveModal,
    ) { }

    ngOnInit (): void {
        setTimeout(() => {
            this.firstInput?.nativeElement.focus()
        })
    }

    get title (): string {
        switch (this.mode) {
            case 'setup': return 'Set sync password'
            case 'change': return 'Change sync password'
            case 'unlock': return 'Unlock cloud sync'
        }
    }

    get okLabel (): string {
        switch (this.mode) {
            case 'setup': return 'Set password'
            case 'change': return 'Change password'
            case 'unlock': return 'Unlock'
        }
    }

    ok (): void {
        this.error = null
        if (this.password.length < 6) {
            this.error = 'Password must be at least 6 characters'
            return
        }
        if (this.mode !== 'unlock' && this.password !== this.confirmPassword) {
            this.error = 'Passwords do not match'
            return
        }
        if (this.mode === 'change') {
            this.modalInstance.close({ oldPassword: this.oldPassword, newPassword: this.password })
        } else {
            this.modalInstance.close(this.password)
        }
    }

    cancel (): void {
        this.modalInstance.close(null)
    }
}
