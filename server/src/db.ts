import { DatabaseSync } from 'node:sqlite'

/** Schema migrations, applied in order; `user_version` records how many ran. */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
    recovery_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE replays (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    cursor_time INTEGER NOT NULL,
    trades INTEGER NOT NULL,
    balance REAL NOT NULL,
    state_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX replays_user ON replays(user_id, updated_at);

  CREATE TABLE backtests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    curve_json TEXT NOT NULL,
    range_from INTEGER NOT NULL,
    range_to INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX backtests_user ON backtests(user_id, created_at);

  CREATE TABLE journal (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    replay_id INTEGER,
    trade_json TEXT,
    setup TEXT NOT NULL,
    emotion TEXT NOT NULL,
    note TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX journal_user ON journal(user_id, created_at);

  CREATE TABLE journal_shots (
    journal_id INTEGER PRIMARY KEY REFERENCES journal(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL
  );
  `,
  `
  CREATE TABLE duels (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL,
    rounds INTEGER NOT NULL,
    analysis_sec INTEGER NOT NULL,
    run_minutes INTEGER NOT NULL,
    hardcore INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE duel_rounds (
    duel_id INTEGER NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
    round_no INTEGER NOT NULL,
    cut_time INTEGER NOT NULL,
    k REAL NOT NULL,
    PRIMARY KEY (duel_id, round_no)
  );
  CREATE TABLE duel_players (
    duel_id INTEGER NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    finished_at INTEGER,
    total_r REAL,
    PRIMARY KEY (duel_id, user_id)
  );
  CREATE INDEX duel_players_user ON duel_players(user_id);
  CREATE TABLE duel_decisions (
    duel_id INTEGER NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
    round_no INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at INTEGER NOT NULL,
    submitted_at INTEGER,
    side TEXT,
    sl REAL,
    tp REAL,
    entry REAL,
    exit REAL,
    exit_time INTEGER,
    reason TEXT,
    r REAL,
    PRIMARY KEY (duel_id, round_no, user_id)
  );
  `,
  // duel limit/stop orders
  `
  ALTER TABLE duel_decisions ADD COLUMN order_type TEXT;
  ALTER TABLE duel_decisions ADD COLUMN order_price REAL;
  `,
  // several instruments: each round has its own, the duel remembers the choice (a symbol or 'random')
  `
  ALTER TABLE duel_rounds ADD COLUMN symbol TEXT NOT NULL DEFAULT 'XAUUSD';
  ALTER TABLE duels ADD COLUMN pair TEXT NOT NULL DEFAULT 'XAUUSD';
  `,
]

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return db
}
