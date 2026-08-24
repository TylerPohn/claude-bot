import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Download, FolderOpen, Trash2, TriangleAlert, Upload } from 'lucide-react'

import { bridge, withToast } from '@/lib/ipc'
import { useAppStore } from '@/stores/appStore'
import { useUiStore } from '@/stores/uiStore'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { CopyField, Note, SettingRow, SettingsSection, useControlId } from './SettingRow'

/** Typed exactly, in capitals. A confirmation you can pass by muscle memory is not one. */
const WIPE_PHRASE = 'DELETE'

export function DataTab(): ReactElement {
  const refreshBots = useAppStore((s) => s.refreshBots)
  const refreshConversations = useAppStore((s) => s.refreshConversations)
  const toast = useUiStore((s) => s.toast)

  const [dbPath, setDbPath] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [wiping, setWiping] = useState(false)
  const phraseId = useControlId('wipe-phrase')

  useEffect(() => {
    let cancelled = false
    void bridge()
      .system.diagnostics()
      .then((report) => {
        if (!cancelled) setDbPath(report.dbPath)
      })
      .catch(() => {
        // The path is a nicety; the buttons below all work without it.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const exportBackup = useCallback(async () => {
    setExporting(true)
    try {
      const result = await withToast(() => bridge().system.exportBackup(), {
        errorTitle: 'Export failed'
      })
      // A null path means the user closed the save dialog — not a failure.
      if (!result?.path) return
      const path = result.path
      toast({
        level: 'success',
        title: 'Backup exported',
        body: path,
        actionLabel: 'Reveal',
        onAction: () => {
          void bridge().system.revealPath(path)
        }
      })
    } finally {
      setExporting(false)
    }
  }, [toast])

  const importBackup = useCallback(async () => {
    setImporting(true)
    try {
      const result = await withToast(() => bridge().system.importBackup(), {
        errorTitle: 'Import failed'
      })
      if (!result) return
      if (!result.imported) {
        if (result.error) toast({ level: 'error', title: 'Import failed', body: result.error })
        return
      }
      // Import is additive and rewrites ids, so the in-memory roster is stale.
      await Promise.all([refreshBots(), refreshConversations()])
      toast({
        level: 'success',
        title: 'Backup imported',
        body: 'Restored Bots and conversations were added alongside what you already had.'
      })
    } finally {
      setImporting(false)
    }
  }, [refreshBots, refreshConversations, toast])

  const wipe = useCallback(async () => {
    setWiping(true)
    try {
      // Main shows its own native confirmation and relaunches on success, so
      // there is nothing to update here — this either never returns or the user
      // backed out at the system dialog.
      await withToast(() => bridge().system.clearAllData(), {
        errorTitle: 'Could not clear local data'
      })
      setPhrase('')
    } finally {
      setWiping(false)
    }
  }, [])

  return (
    <>
      <SettingsSection
        title="On this computer"
        description="Claude Code Bots has no server of its own. Everything below lives in one folder on this machine and is never uploaded by this app."
      >
        <SettingRow
          label="What is stored"
          description="Bot profiles, full conversation transcripts, workspace paths, the Claude session ids used to resume a Bot, and tool-activity metadata."
          footnote={
            <Note tone="neutral">
              When a Bot runs, your installed Claude Code sends the prompt and context to Anthropic
              under your own Claude account and privacy settings. Inference does not happen on this
              computer.
            </Note>
          }
        />

        <SettingRow
          label="App data folder"
          description="The database, logs and window state."
          control={
            <Button
              size="sm"
              leading={<FolderOpen size={14} strokeWidth={1.75} />}
              onClick={() => {
                void withToast(() => bridge().system.revealAppData(), {
                  errorTitle: 'Could not open the app data folder'
                })
              }}
            >
              Reveal
            </Button>
          }
          footnote={<CopyField value={dbPath} empty="Locating…" copyLabel="Copy database path" />}
        />
      </SettingsSection>

      <SettingsSection
        title="Backup"
        description="A backup is a plain folder of JSON: a manifest, your Bots, conversations, messages and settings."
      >
        <SettingRow
          label="Export backup"
          description="Never includes credentials. Claude session ids are left out on purpose — they are the closest thing this app holds to a token, and they do not work on another machine anyway."
          control={
            <Button
              size="sm"
              loading={exporting}
              leading={<Download size={14} strokeWidth={1.75} />}
              onClick={() => void exportBackup()}
            >
              Export…
            </Button>
          }
        />

        <SettingRow
          label="Import backup"
          description="Adds to what you already have rather than replacing it: every id is regenerated, so importing twice gives you two copies instead of a broken merge. It is all-or-nothing — if anything in the folder is unreadable, nothing is written."
          control={
            <Button
              size="sm"
              loading={importing}
              leading={<Upload size={14} strokeWidth={1.75} />}
              onClick={() => void importBackup()}
            >
              Import…
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Danger zone" danger>
        <SettingRow
          label="Clear all local data"
          description="Deletes every Bot, conversation, message and setting on this computer, then restarts the app empty. Your files, your repositories and your Claude Code installation are not touched — and a backup you already exported still works."
          footnote={
            <div className="flex flex-col" style={{ gap: 8 }}>
              <Note tone="danger" icon={<TriangleAlert size={14} strokeWidth={1.75} />}>
                There is no undo. Export a backup first if there is anything here you would miss.
              </Note>
              <label
                htmlFor={phraseId}
                className="text-[var(--fg-secondary)]"
                style={{ fontSize: 'var(--fs-meta)' }}
              >
                Type <strong style={{ fontWeight: 550, color: 'var(--fg-primary)' }}>
                  {WIPE_PHRASE}
                </strong>{' '}
                to enable the button.
              </label>
              <div className="flex items-center gap-[8px]">
                <div style={{ width: 200 }}>
                  <Input
                    id={phraseId}
                    value={phrase}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={WIPE_PHRASE}
                    aria-label={`Type ${WIPE_PHRASE} to confirm`}
                    onChange={(e) => setPhrase(e.currentTarget.value)}
                  />
                </div>
                <Button
                  size="md"
                  variant="danger"
                  loading={wiping}
                  disabled={phrase.trim() !== WIPE_PHRASE}
                  leading={<Trash2 size={14} strokeWidth={1.75} />}
                  style={
                    phrase.trim() === WIPE_PHRASE
                      ? { background: 'var(--fg-danger)', color: 'var(--white)' }
                      : undefined
                  }
                  onClick={() => void wipe()}
                >
                  Delete everything
                </Button>
              </div>
              <p className="text-[var(--fg-quaternary)]" style={{ fontSize: 'var(--fs-micro)' }}>
                Your system will ask once more before anything is removed.
              </p>
            </div>
          }
        />
      </SettingsSection>
    </>
  )
}
