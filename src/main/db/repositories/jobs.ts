/**
 * Job repository — one row per Claude Code turn.
 *
 * The scheduler's admission rules (PRD §23.2) are all expressed as counting
 * queries here so the decision is made against committed state rather than an
 * in-memory mirror that a crash could desynchronize.
 */
import type { BotJob } from '@shared/types'
import { getDb, stmt, transaction } from '@main/db/index'
import { AppError } from '@main/lib/errors'
import { newId, nowIso } from '@main/lib/id'
import { bindValue, rowToJob, type JobRow } from '@main/db/rows'

export interface CreateJobInput {
  botId: string
  conversationId: string
  triggeringMessageId: string | null
  responseMessageId: string
  originMessageId: string | null
  handoffDepth: number
}

export type JobPatch = Partial<BotJob> & { exitCode?: number | null; exitSignal?: string | null }

const JOB_COLUMNS = `id, bot_id, conversation_id, triggering_message_id, response_message_id,
  origin_message_id, status, handoff_depth, process_pid, claude_session_id, error_text,
  exit_code, exit_signal, created_at, started_at, completed_at`

/** A job that has been admitted or is waiting to be. */
const ACTIVE_STATUSES = "('queued', 'running')"

const insertJob = stmt(`
  INSERT INTO jobs (
    id, bot_id, conversation_id, triggering_message_id, response_message_id, origin_message_id,
    status, handoff_depth, process_pid, claude_session_id, error_text, exit_code, exit_signal,
    created_at, started_at, completed_at
  ) VALUES (
    @id, @bot_id, @conversation_id, @triggering_message_id, @response_message_id, @origin_message_id,
    'queued', @handoff_depth, NULL, NULL, NULL, NULL, NULL,
    @created_at, NULL, NULL
  )`)

const selectById = stmt<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
const selectQueued = stmt<JobRow>(
  `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC`
)
const selectRunning = stmt<JobRow>(
  `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'running' ORDER BY created_at ASC, id ASC`
)
const selectRunningCount = stmt<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'")
const selectActiveForPair = stmt<{ n: number }>(
  `SELECT COUNT(*) AS n FROM jobs WHERE bot_id = ? AND conversation_id = ? AND status IN ${ACTIVE_STATUSES}`
)
const selectRunningForBot = stmt<{ n: number }>(
  "SELECT COUNT(*) AS n FROM jobs WHERE bot_id = ? AND status = 'running'"
)
const selectOriginCount = stmt<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE origin_message_id = ?')
const selectActiveForConversation = stmt<JobRow>(
  `SELECT ${JOB_COLUMNS} FROM jobs WHERE conversation_id = ? AND status IN ${ACTIVE_STATUSES}
   ORDER BY created_at ASC, id ASC`
)
const markInterrupted = stmt(`
  UPDATE jobs
  SET status = 'interrupted',
      completed_at = ?,
      error_text = COALESCE(error_text, 'Interrupted when the app quit.')
  WHERE status = 'running'`)

/** Patch key -> column. `id` and `createdAt` are deliberately absent: they are immutable. */
const UPDATABLE: Record<string, string> = {
  botId: 'bot_id',
  conversationId: 'conversation_id',
  triggeringMessageId: 'triggering_message_id',
  responseMessageId: 'response_message_id',
  originMessageId: 'origin_message_id',
  status: 'status',
  handoffDepth: 'handoff_depth',
  processPid: 'process_pid',
  claudeSessionId: 'claude_session_id',
  errorText: 'error_text',
  exitCode: 'exit_code',
  exitSignal: 'exit_signal',
  startedAt: 'started_at',
  completedAt: 'completed_at'
}

function requireRow(id: string): JobRow {
  const row = selectById().get(id)
  if (!row) throw new AppError('not_found', 'That job no longer exists.', id)
  return row
}

export const jobsRepo = Object.freeze({
  create(input: CreateJobInput): BotJob {
    const id = newId('job')
    insertJob().run({
      id,
      bot_id: input.botId,
      conversation_id: input.conversationId,
      triggering_message_id: input.triggeringMessageId ?? null,
      response_message_id: input.responseMessageId,
      origin_message_id: input.originMessageId ?? null,
      handoff_depth: input.handoffDepth,
      created_at: nowIso()
    })
    return rowToJob(requireRow(id))
  },

  get(id: string): BotJob | null {
    const row = selectById().get(id)
    return row ? rowToJob(row) : null
  },

  update(id: string, patch: JobPatch): BotJob {
    requireRow(id)

    const assignments: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      const column = UPDATABLE[key]
      if (!column || value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(bindValue(value))
    }

    if (assignments.length > 0) {
      values.push(id)
      getDb()
        .prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values)
    }

    return rowToJob(requireRow(id))
  },

  /** FIFO across the whole app; the scheduler applies the per-pair rules on top. */
  listQueued(): BotJob[] {
    return selectQueued().all().map(rowToJob)
  },

  listRunning(): BotJob[] {
    return selectRunning().all().map(rowToJob)
  },

  runningCount(): number {
    return selectRunningCount().get()?.n ?? 0
  },

  /** At most one active job per (bot, conversation) — the core anti-confusion rule. */
  hasActiveForPair(botId: string, conversationId: string): boolean {
    return (selectActiveForPair().get(botId, conversationId)?.n ?? 0) > 0
  },

  runningCountForBot(botId: string): number {
    return selectRunningForBot().get(botId)?.n ?? 0
  },

  /**
   * How many turns one human message has already caused, counting the first one.
   * Compared against `maxAutomatedTurnsPerHumanMessage` to stop handoff ping-pong.
   */
  countAutomatedForOrigin(originMessageId: string): number {
    return selectOriginCount().get(originMessageId)?.n ?? 0
  },

  /**
   * Startup recovery: a `running` row can only be a leftover, because the process
   * that owned it died with the previous app instance. `queued` rows are left
   * alone — the scheduler drains them normally once it starts.
   */
  markOrphansInterrupted(): BotJob[] {
    return transaction(() => {
      const orphans = selectRunning().all()
      if (orphans.length === 0) return []
      markInterrupted().run(nowIso())
      return orphans.map((row) => rowToJob(requireRow(row.id)))
    })
  },

  activeForConversation(conversationId: string): BotJob[] {
    return selectActiveForConversation().all(conversationId).map(rowToJob)
  }
})
