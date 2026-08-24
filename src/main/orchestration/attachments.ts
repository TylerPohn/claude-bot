/**
 * Attachment existence checks (PRD §17.1).
 *
 * Attachments are references, never copies: the app stores the path the user
 * picked and Claude opens it with its own file tools. That makes "does this still
 * exist?" a question with two different answers at two different moments, and both
 * matter:
 *
 * - at send time, so the transcript records what was actually there;
 * - at execution time, because a turn can sit in the queue behind others (default
 *   three at a time) or be retried hours later, and telling Claude to open a path
 *   that has since moved produces a confusing tool error instead of the app's own
 *   honest "not found" line.
 *
 * Both callers share this module so there is exactly one stat implementation and
 * one definition of "missing".
 */
import { statSync } from 'node:fs'
import type { Stats } from 'node:fs'

import type { Attachment } from '@shared/types'
import { log } from '@main/lib/logger'

/**
 * `statSync` throws on permission errors too, which are not "missing" — but we
 * cannot act on the difference, so any failure to stat is reported as missing.
 */
export function safeStat(path: string): Stats | undefined {
  try {
    // `bigint: false` pins the overload to plain `Stats` (sizes stay `number`).
    return statSync(path, { throwIfNoEntry: false, bigint: false })
  } catch (err) {
    log.warn('attachments', `could not stat attachment ${path}`, err)
    return undefined
  }
}

/**
 * Re-check the stored attachments of a message just before its turn runs.
 *
 * Returns a new array; the database is deliberately NOT updated. The stored flag
 * is the transcript's record of what was there when the user sent the message,
 * and a path on an unmounted volume that comes back later must not be dimmed
 * forever because of one unlucky turn. A file that has gone since is marked
 * missing, and a file that has come back is un-marked.
 */
export function restatAttachments(attachments: Attachment[]): Attachment[] {
  if (attachments.length === 0) return attachments
  return attachments.map((attachment) => {
    const missing = safeStat(attachment.path) === undefined
    return missing === attachment.missing ? attachment : { ...attachment, missing }
  })
}
