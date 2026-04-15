const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'mail.db');

function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      folder    TEXT PRIMARY KEY,
      last_uid  INTEGER DEFAULT 0,
      last_sync TEXT
    );

    CREATE TABLE IF NOT EXISTS folders (
      path        TEXT PRIMARY KEY,
      name        TEXT,
      special_use TEXT,
      parent_path TEXT,
      synced_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS emails (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uid           INTEGER,
      folder        TEXT,
      message_id    TEXT,
      in_reply_to   TEXT,
      thread_id     TEXT,

      from_addr     TEXT,
      from_name     TEXT,
      to_addrs      TEXT,
      cc_addrs      TEXT,
      subject       TEXT,
      date          TEXT,

      body_raw      TEXT,

      has_attachment INTEGER DEFAULT 0,
      attachments   TEXT,

      synced_at     TEXT DEFAULT (datetime('now')),

      UNIQUE(uid, folder)
    );

    CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder, date DESC);
    CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_addr);
    CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
    CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
    CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);

    CREATE TABLE IF NOT EXISTS email_turns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id    INTEGER REFERENCES emails(id),
      turn_index  INTEGER,
      from_name   TEXT,
      from_addr   TEXT,
      date        TEXT,
      content     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_turns_email ON email_turns(email_id);
    CREATE INDEX IF NOT EXISTS idx_turns_index ON email_turns(email_id, turn_index);

    CREATE TABLE IF NOT EXISTS contacts (
      addr          TEXT PRIMARY KEY,
      name          TEXT,
      last_email_at TEXT,
      email_count   INTEGER DEFAULT 0,
      folders       TEXT
    );

  `);

  // FTS5 全文搜索索引
  try {
    db.exec(`
      CREATE VIRTUAL TABLE emails_fts USING fts5(
        subject, body_raw, from_name,
        content='emails',
        content_rowid='id',
        tokenize='trigram'
      );
    `);
  } catch (e) {
    // Already exists
  }

  // Triggers to keep FTS in sync
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
        INSERT INTO emails_fts(rowid, subject, body_raw, from_name)
        VALUES (new.id, new.subject, new.body_raw, new.from_name);
      END;

      CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
        INSERT INTO emails_fts(emails_fts, rowid, subject, body_raw, from_name)
        VALUES ('delete', old.id, old.subject, old.body_raw, old.from_name);
        INSERT INTO emails_fts(rowid, subject, body_raw, from_name)
        VALUES (new.id, new.subject, new.body_raw, new.from_name);
      END;
    `);
  } catch (e) {
    // Already exists
  }

  return db;
}

module.exports = { initDB, DB_PATH };
