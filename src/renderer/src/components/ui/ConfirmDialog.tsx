import type { ReactElement } from 'react'

import { useUiStore } from '@/stores/uiStore'
import { Button } from './Button'
import { Modal } from './Modal'

/**
 * The single destructive-confirmation surface (DESIGN §3.13). Every caller opens
 * it through `uiStore.confirm(...)`, so the copy, the button order and the
 * danger styling can never drift between features.
 */
export function ConfirmDialog(): ReactElement | null {
  const modal = useUiStore((s) => s.modal)
  const closeModal = useUiStore((s) => s.closeModal)

  if (!modal || modal.kind !== 'confirm') return null

  return (
    <Modal
      width={400}
      onClose={closeModal}
      title={modal.title}
      hideClose
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            data-autofocus
            variant={modal.danger ? 'danger' : 'filled'}
            style={
              modal.danger
                ? { background: 'var(--fg-danger)', color: 'var(--white)' }
                : undefined
            }
            onClick={() => {
              // Close first: the callback may open another dialog.
              closeModal()
              modal.onConfirm()
            }}
          >
            {modal.confirmLabel}
          </Button>
        </>
      }
    >
      {modal.body ? (
        <p
          className="selectable text-[var(--fg-secondary)]"
          style={{ fontSize: 'var(--fs-chrome)', lineHeight: 'var(--lh-chrome)' }}
        >
          {modal.body}
        </p>
      ) : null}
    </Modal>
  )
}
