import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const progressColumns = ['current_block', 'current_offset'];
const missingProgressColumns = (columns) => progressColumns.filter((name) => !columns.some((column) => column.name === name));
const addProgressColumn = (name) => `ALTER TABLE books ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`;

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    salt BINARY_TYPE NOT NULL,
    password_key BINARY_TYPE NOT NULL
  ) TABLE_OPTION;

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIME_TYPE NOT NULL
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS sessions_expiration ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    thumbnail TEXT,
    pages_json TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    current_page INTEGER NOT NULL DEFAULT 0,
    current_block INTEGER NOT NULL DEFAULT 0,
    current_offset INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS books_owner ON books(owner_id, updated_at);

  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    block INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    text TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS highlights_book ON highlights(book_id, page, block);

  CREATE TABLE IF NOT EXISTS highlight_details (
    highlight_id TEXT PRIMARY KEY REFERENCES highlights(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'group'))
  ) TABLE_OPTION;

  CREATE TABLE IF NOT EXISTS reader_colors (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    color TEXT NOT NULL,
    created_at TIME_TYPE NOT NULL,
    PRIMARY KEY (user_id, color)
  ) TABLE_OPTION;

  CREATE TABLE IF NOT EXISTS social_friendships (
    id TEXT PRIMARY KEY,
    left_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    right_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    UNIQUE (left_user_id, right_user_id),
    CHECK (left_user_id <> right_user_id AND requested_by IN (left_user_id, right_user_id))
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS social_friendships_right ON social_friendships(right_user_id);

  CREATE TABLE IF NOT EXISTS book_origins (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    circle_id TEXT NOT NULL,
    from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS book_origins_circle ON book_origins(circle_id);

  CREATE TABLE IF NOT EXISTS social_share_requests (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    copy_id TEXT REFERENCES books(id) ON DELETE SET NULL,
    UNIQUE (book_id, requester_id),
    CHECK (owner_id <> requester_id)
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS social_share_requests_owner ON social_share_requests(owner_id);
  CREATE INDEX IF NOT EXISTS social_share_requests_requester ON social_share_requests(requester_id);
  CREATE INDEX IF NOT EXISTS social_share_requests_copy ON social_share_requests(copy_id);

  CREATE TABLE IF NOT EXISTS reading_groups (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL UNIQUE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  ) TABLE_OPTION;

  CREATE TABLE IF NOT EXISTS reading_group_members (
    group_id TEXT NOT NULL REFERENCES reading_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'declined', 'left')),
    PRIMARY KEY (group_id, user_id)
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS reading_group_members_user ON reading_group_members(user_id);
  CREATE INDEX IF NOT EXISTS reading_group_members_book ON reading_group_members(book_id);

  CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    part_count INTEGER NOT NULL,
    expires_at TIME_TYPE NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  ) TABLE_OPTION;
  CREATE INDEX IF NOT EXISTS imports_expiration ON imports(expires_at);
  CREATE INDEX IF NOT EXISTS imports_owner ON imports(owner_id);

  CREATE TABLE IF NOT EXISTS import_parts (
    import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL,
    chunk TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    PRIMARY KEY (import_id, part_number)
  ) TABLE_OPTION;
`;

function sqliteConnection(database) {
  const statements = new Map();
  function statement(sql) {
    if (!statements.has(sql)) statements.set(sql, database.prepare(sql));
    return statements.get(sql);
  }
  return {
    get: (sql, ...args) => statement(sql).get(...args),
    all: (sql, ...args) => statement(sql).all(...args),
    run: (sql, ...args) => statement(sql).run(...args),
  };
}

async function openSqlite(directory) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(resolve(directory, 'leitura.sqlite'));
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    database.exec(schema.replaceAll('BINARY_TYPE', 'BLOB').replaceAll('TIME_TYPE', 'INTEGER').replaceAll('TABLE_OPTION', 'STRICT'));
    for (const name of missingProgressColumns(database.prepare('PRAGMA table_info(books)').all())) {
      database.exec(addProgressColumn(name));
    }
    database.exec('COMMIT');
  } catch (error) {
    database.close();
    throw error;
  }

  const connection = sqliteConnection(database);
  let queue = Promise.resolve();
  function exclusive(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }
  return {
    get: (sql, ...args) => exclusive(() => connection.get(sql, ...args)),
    all: (sql, ...args) => exclusive(() => connection.all(sql, ...args)),
    run: (sql, ...args) => exclusive(() => connection.run(sql, ...args)),
    transaction: (fn) => exclusive(async () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const value = await fn(connection);
        database.exec('COMMIT');
        return value;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }),
  };
}

function postgresConnection(client) {
  function query(sql, args) {
    let parameter = 0;
    return client.query(sql.replaceAll('?', () => `$${++parameter}`), args);
  }
  return {
    get: async (sql, ...args) => (await query(sql, args)).rows[0],
    all: async (sql, ...args) => (await query(sql, args)).rows,
    run: async (sql, ...args) => ({ changes: (await query(sql, args)).rowCount }),
  };
}

async function openPostgres(connectionString) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    enableChannelBinding: true,
  });
  pool.on('error', (error) => console.error('Falha em conexão ociosa com o banco.', error.code));

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(postgresConnection(client));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    await transaction(async (connection) => {
      await connection.run('SELECT pg_advisory_xact_lock(418824069)');
      await connection.run(schema.replaceAll('BINARY_TYPE', 'BYTEA').replaceAll('TIME_TYPE', 'BIGINT').replaceAll('TABLE_OPTION', ''));
      const columns = await connection.all(`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = 'books'::regclass AND attnum > 0 AND NOT attisdropped
      `);
      for (const name of missingProgressColumns(columns)) await connection.run(addProgressColumn(name));
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { ...postgresConnection(pool), transaction };
}

export function createStorage({ connectionString, directory }) {
  let opening;
  function open() {
    if (!opening) {
      opening = (connectionString ? openPostgres(connectionString) : openSqlite(directory)).catch((error) => {
        opening = undefined;
        throw error;
      });
    }
    return opening;
  }
  return {
    forUpdate: connectionString ? ' FOR UPDATE' : '',
    postgres: Boolean(connectionString),
    get: async (...args) => (await open()).get(...args),
    all: async (...args) => (await open()).all(...args),
    run: async (...args) => (await open()).run(...args),
    transaction: async (fn) => (await open()).transaction(fn),
  };
}
