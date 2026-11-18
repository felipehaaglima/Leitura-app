import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

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
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(schema.replaceAll('BINARY_TYPE', 'BLOB').replaceAll('TIME_TYPE', 'INTEGER').replaceAll('TABLE_OPTION', 'STRICT'));

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
