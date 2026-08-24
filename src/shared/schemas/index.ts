/**
 * Zod schemas for every IPC input. The main process validates against these
 * before touching the database or spawning a process. Zod v4 API.
 */
import { z } from 'zod'
import { BOT_ACCENTS, BOT_SHAPES } from '../types'

export const avatarTypeSchema = z.enum(['shape', 'emoji', 'initials', 'image'])
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan'])
export const botAccentSchema = z.enum(BOT_ACCENTS)
export const botShapeSchema = z.enum(BOT_SHAPES)
export const conversationTypeSchema = z.enum(['direct', 'group'])
export const appearanceSchema = z.enum(['system', 'light', 'dark'])

/** Model is free-form so users can pin a full model id, but must be sane. */
export const modelSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Model may only contain letters, numbers, dots, dashes and underscores')
  // A leading dash would reach `--model <value>` in argv as a FLAG, letting a
  // model id smuggle a CLI option past the runtime.
  .regex(/^[^-]/, 'Model ids cannot start with a dash')

const toolNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_*().:\-\s/|,'"$]+$/, 'Invalid tool pattern')

export const idSchema = z.string().min(1).max(64)

/** Hard cap on a single message body. The composer enforces the same number
 *  client-side so the user gets a counter instead of an IPC rejection. */
export const MAX_MESSAGE_BODY = 200_000

export const botDraftSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(40, 'Keep names under 40 characters')
    .regex(/^[^\s@][^@]*$/, 'Names cannot contain @ or start with a space')
    // A newline in a name would let a Bot profile open its own line inside a
    // group-context prompt and impersonate a structural marker.
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Names cannot contain line breaks or control characters'),
  title: z
    .string()
    .trim()
    .max(60)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'Titles cannot contain line breaks or control characters')
    .nullish(),
  description: z.string().max(20000).default(''),
  avatarType: avatarTypeSchema.default('shape'),
  avatarValue: z.string().max(2048).default('circle'),
  accent: botAccentSchema.default('violet'),
  defaultWorkingDirectory: z.string().max(4096).nullish(),
  model: modelSchema.default('default'),
  permissionMode: permissionModeSchema.default('default'),
  allowedTools: z.array(toolNameSchema).max(200).default([]),
  disallowedTools: z.array(toolNameSchema).max(200).default([])
})

export const botPatchSchema = botDraftSchema
  .partial()
  .extend({ pinned: z.boolean().optional(), hidden: z.boolean().optional() })

export const createGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Group names cannot contain line breaks or control characters'),
  icon: z.string().max(8).nullish(),
  memberBotIds: z.array(idSchema).min(1, 'Add at least one Bot').max(10, 'Groups hold up to 10 Bots'),
  workspaceDirectory: z.string().max(4096).nullish()
})

export const conversationPatchSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Group names cannot contain line breaks or control characters')
    .optional(),
  icon: z.string().max(8).nullish(),
  memberBotIds: z.array(idSchema).min(1).max(10).optional(),
  workspaceDirectory: z.string().max(4096).nullish(),
  defaultResponderBotId: idSchema.nullish(),
  skipEveryoneConfirm: z.boolean().optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional()
})

export const mentionSchema = z.object({
  botId: idSchema.nullable(),
  display: z.string().min(1).max(64),
  everyone: z.boolean().default(false),
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(0)
})

export const attachmentInputSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(512),
  kind: z.enum(['file', 'folder', 'image']).default('file'),
  sizeBytes: z.number().int().nonnegative().nullish(),
  mimeType: z.string().max(200).nullish()
})

export const sendMessageSchema = z.object({
  conversationId: idSchema,
  body: z.string().max(MAX_MESSAGE_BODY),
  mentions: z.array(mentionSchema).max(20).default([]),
  attachments: z.array(attachmentInputSchema).max(20).default([]),
  replyToMessageId: idSchema.nullish(),
  /** Explicit routing override from the composer's routing selector. */
  routing: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('auto') }),
      z.object({ mode: z.literal('everyone') }),
      z.object({ mode: z.literal('bot'), botId: idSchema })
    ])
    .default({ mode: 'auto' })
})

export const settingsPatchSchema = z.object({
  appearance: appearanceSchema.optional(),
  launchAtLogin: z.boolean().optional(),
  showNotifications: z.boolean().optional(),
  notifyOnFocusedConversation: z.boolean().optional(),
  defaultWorkspace: z.string().max(4096).nullish(),
  maxConcurrentBots: z.number().int().min(1).max(12).optional(),
  allowSameBotConcurrentConversations: z.boolean().optional(),
  claudeExecutablePath: z.string().max(4096).nullish(),
  defaultModel: modelSchema.optional(),
  defaultPermissionMode: permissionModeSchema.optional(),
  globalAllowedTools: z.array(toolNameSchema).max(200).optional(),
  globalDisallowedTools: z.array(toolNameSchema).max(200).optional(),
  safetyGuardrails: z.boolean().optional(),
  handoffsEnabled: z.boolean().optional(),
  maxHandoffDepth: z.number().int().min(0).max(6).optional(),
  maxAutomatedTurnsPerHumanMessage: z.number().int().min(1).max(32).optional(),
  groupBridgeCharBudget: z.number().int().min(1000).max(200000).optional(),
  showThinking: z.boolean().optional(),
  sendKey: z.enum(['enter', 'mod+enter']).optional(),
  onboardingCompleted: z.boolean().optional(),
  fontScale: z.number().min(0.85).max(1.3).optional()
})

export const getMessagesSchema = z.object({
  conversationId: idSchema,
  /** ISO timestamp cursor — fetch messages strictly before this. */
  before: z.string().max(40).nullish(),
  limit: z.number().int().min(1).max(500).default(80)
})

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(200).default(50)
})

export const reactionSchema = z.object({
  messageId: idSchema,
  emoji: z.string().min(1).max(8)
})

export type BotDraftInput = z.input<typeof botDraftSchema>
export type BotPatchInput = z.input<typeof botPatchSchema>
export type CreateGroupInput = z.input<typeof createGroupSchema>
export type ConversationPatchInput = z.input<typeof conversationPatchSchema>
export type SendMessageInput = z.input<typeof sendMessageSchema>
export type SettingsPatchInput = z.input<typeof settingsPatchSchema>
export type GetMessagesInput = z.input<typeof getMessagesSchema>
export type SearchInput = z.input<typeof searchSchema>
export type AttachmentInput = z.input<typeof attachmentInputSchema>
export type MentionInput = z.input<typeof mentionSchema>
