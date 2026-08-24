/**
 * Runtime lane contracts.
 *
 * The app deliberately talks to Claude Code through a narrow interface so that a
 * different local agent runtime could be dropped in later (PRD §50). Nothing outside
 * `src/main/runtime` should know that we spawn a CLI, build argv, or parse NDJSON.
 */
import type { RuntimeEvent } from '@shared/types/events'
import type { RuntimeStatus, PermissionMode, ModelPreference } from '@shared/types'

export interface RunTurnInput {
  jobId: string
  /** Full composed prompt. Sent via stdin — never as an argv element (PRD §27.2). */
  prompt: string
  cwd: string
  resumeSessionId: string | null
  /** `'default'` → omit `--model` and let the user's own Claude Code default win. */
  model: ModelPreference
  /**
   * `'default'` → omit `--permission-mode` entirely. Claude Code 2.1.241 has no
   * `default` member in that flag's enum, so passing the string would abort the
   * process before a single token is produced (ARCHITECTURE §0).
   */
  permissionMode: PermissionMode
  allowedTools: string[]
  disallowedTools: string[]
  /**
   * Serialized `{ mcpServers: {...} }`; when null, no `--mcp-config` is passed.
   *
   * Treat this as a secret: it carries the control server's bearer token. The
   * runtime writes it to a 0600 file and passes the CLI that path - it must never
   * be interpolated into a command line, where `ps` would publish it to every
   * account on the machine.
   *
   * One document per JOB. The runtime exchanges it for an attempt-scoped
   * credential (`mcpConfigForAttempt`) on every call, so the same input may
   * safely be run twice - which is exactly what session recovery does.
   */
  mcpConfigJson: string | null
  includePartialMessages: boolean
}

export interface AgentRuntime {
  checkAvailability(force?: boolean): Promise<RuntimeStatus>
  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent>
  cancel(jobId: string): Promise<void>
  isRunning(jobId: string): boolean
}
