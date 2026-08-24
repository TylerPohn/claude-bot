/**
 * Database schema. Migrations are append-only: never edit an existing entry,
 * always add a new one. `runMigrations` applies anything above `user_version`.
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: /* sql */ `
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL DEFAULT '',
  avatar_type TEXT NOT NULL DEFAULT 'shape',
  avatar_value TEXT NOT NULL DEFAULT 'circle',
  accent TEXT NOT NULL DEFAULT 'violet',
  default_working_directory TEXT,
  model TEXT NOT NULL DEFAULT 'default',
  permission_mode TEXT NOT NULL DEFAULT 'default',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  disallowed_tools TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bots_hidden ON bots(hidden, pinned, sort_order);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  workspace_directory TEXT,
  default_responder_bot_id TEXT,
  skip_everyone_confirm INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_updated ON conversations(hidden, pinned, updated_at DESC);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, bot_id)
);
CREATE INDEX idx_members_bot ON conversation_members(bot_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_bot_id TEXT,
  author_name TEXT,
  author_avatar_type TEXT,
  author_avatar_value TEXT,
  author_accent TEXT,
  body_markdown TEXT NOT NULL DEFAULT '',
  thinking_markdown TEXT NOT NULL DEFAULT '',
  reply_to_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  system_kind TEXT,
  handoff_from_bot_id TEXT,
  job_id TEXT,
  error_text TEXT,
  usage_json TEXT,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, seq);
CREATE INDEX idx_messages_created ON messages(conversation_id, created_at);

CREATE TABLE message_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  bot_id TEXT,
  display TEXT NOT NULL,
  everyone INTEGER NOT NULL DEFAULT 0,
  start_index INTEGER NOT NULL DEFAULT 0,
  end_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_mentions_message ON message_mentions(message_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  size_bytes INTEGER,
  mime_type TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  bot_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  detail TEXT,
  tool_name TEXT,
  tool_use_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  added_lines INTEGER,
  removed_lines INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_activities_message ON activities(message_id, seq);
CREATE INDEX idx_activities_tooluse ON activities(tool_use_id);

CREATE TABLE bot_conversation_sessions (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  claude_session_id TEXT,
  last_seen_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, conversation_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  triggering_message_id TEXT,
  response_message_id TEXT NOT NULL,
  origin_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  handoff_depth INTEGER NOT NULL DEFAULT 0,
  process_pid INTEGER,
  claude_session_id TEXT,
  error_text TEXT,
  exit_code INTEGER,
  exit_signal TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status, created_at);
CREATE INDEX idx_jobs_pair ON jobs(bot_id, conversation_id, status);
CREATE INDEX idx_jobs_origin ON jobs(origin_message_id);

CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- External-content FTS5 index over message bodies.
-- NOTE: with content='messages' the FTS column names MUST match the source
-- table's column names, otherwise snippet()/highlight() raise "SQL logic error"
-- when they try to re-read the original text. Do not rename these.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body_markdown,
  author_name,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body_markdown, author_name)
  VALUES (new.rowid, new.body_markdown, COALESCE(new.author_name, ''));
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body_markdown, author_name)
  VALUES ('delete', old.rowid, old.body_markdown, COALESCE(old.author_name, ''));
END;

CREATE TRIGGER messages_au AFTER UPDATE OF body_markdown, author_name ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body_markdown, author_name)
  VALUES ('delete', old.rowid, old.body_markdown, COALESCE(old.author_name, ''));
  INSERT INTO messages_fts(rowid, body_markdown, author_name)
  VALUES (new.rowid, new.body_markdown, COALESCE(new.author_name, ''));
END;
`
  }
]
