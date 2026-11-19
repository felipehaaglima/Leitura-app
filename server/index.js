import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createStorage } from './database.js';
import { createSocialAPI } from './social.js';
import { createNotesAPI } from './notes.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = resolve(process.env.LEITURA_DATA_DIR || resolve(root, 'data'));
const distDirectory = resolve(root, 'dist');
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const vercel = process.env.VERCEL === '1';
const secureCookies = vercel || process.env.LEITURA_SECURE_COOKIES === '1';
const sessionDuration = 30 * 24 * 60 * 60 * 1000;
const sessionCookie = 'leitura_session';
const maxBookBytes = 64 * 1024 * 1024;
const maxImageBytes = 16 * 1024 * 1024;
const maxSmallRequestBytes = 16 * 1024;
const chunkSize = 500_000;
const maxPartBytes = 3_100_000;
const maxHostedJsonBytes = 4_000_000;
const maxImportParts = Math.ceil(maxBookBytes / (chunkSize - 1));
const importDuration = 2 * 60 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deletedImport = 2;
const bookBatchSize = 6;
const highlightBatchSize = 48;
const maxHighlightNoteLength = 2_000;
const scryptAsync = promisify(scrypt);
const dummySalt = randomBytes(16);
const dummyKey = randomBytes(64);
const presetColors = new Set(['yellow', 'green', 'pink']);
const highlightScopes = new Set(['private', 'group']);
const hostedResponses = new WeakSet();

const storage = createStorage({ connectionString: process.env.DATABASE_URL, directory: dataDirectory });

function prepare(sql) {
  return {
    get: (...args) => storage.get(sql, ...args),
    run: (...args) => storage.run(sql, ...args),
  };
}

const summaryFields = `
  id, title, thumbnail, page_count AS "pageCount", current_page AS "currentPage",
  current_block AS "currentBlock", current_offset AS "currentOffset",
  created_at AS "createdAt", updated_at AS "updatedAt",
  (SELECT from_user_id FROM book_origins WHERE book_id = books.id) AS "referrerId",
  (SELECT users.name FROM book_origins JOIN users ON users.id = book_origins.from_user_id
   WHERE book_origins.book_id = books.id) AS "referrerName",
  CAST((SELECT count(*) FROM highlights WHERE highlights.book_id = books.id) AS INTEGER) AS "highlightCount"
`;

const insertBookSql = `
  INSERT INTO books (id, owner_id, title, thumbnail, pages_json, page_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;
const bookSummarySql = `SELECT ${summaryFields} FROM books WHERE id = ? AND owner_id = ?`;
const listBooksSql = `SELECT ${summaryFields} FROM books WHERE owner_id = ? ORDER BY updated_at DESC, id`;
const updateProgressSql = `
  UPDATE books SET current_page = ?, current_block = ?, current_offset = ?, updated_at = ?
  WHERE id = ? AND owner_id = ? AND page_count > ?
`;
const highlightFields = `
  highlights.id, highlights.page, highlights.block, highlights."start", highlights."end",
  highlights.text, highlights.color, highlights.created_at AS "createdAt",
  COALESCE(NULLIF(highlight_details.note, ''),
    (SELECT text FROM highlight_notes WHERE id = highlights.id AND highlight_id = highlights.id), '') AS note,
  COALESCE(highlight_details.scope, 'private') AS scope
`;
const highlightDetailsJoin = 'LEFT JOIN highlight_details ON highlight_details.highlight_id = highlights.id';
const highlightByIdSql = `
  SELECT ${highlightFields}
  FROM highlights ${highlightDetailsJoin}
  WHERE highlights.id = ? AND highlights.book_id = ?
`;
const editableHighlightSql = highlightByIdSql + (storage.postgres ? ' FOR UPDATE OF highlights' : '');
const listHighlightsSql = `
  SELECT ${highlightFields}
  FROM highlights ${highlightDetailsJoin}
  WHERE highlights.book_id = ?
  ORDER BY highlights.page, highlights.block, highlights."start", highlights.created_at, highlights.id
`;
const listAccountHighlightsSql = `
  SELECT books.id AS "bookId", books.title, ${highlightFields}
  FROM books JOIN highlights ON highlights.book_id = books.id
  ${highlightDetailsJoin}
  WHERE books.owner_id = ?
  ORDER BY books.updated_at DESC, books.id, highlights.page, highlights.block, highlights."start",
           highlights.created_at, highlights.id
`;
const getBlockSql = storage.postgres
  ? `SELECT ((pages_json::jsonb -> (?::integer) -> 'blocks' -> (?::integer)) - 'src'::text)::text AS block,
            page_count AS "pageCount"
     FROM books WHERE id = ? AND owner_id = ?${storage.forUpdate}`
  : `SELECT json_remove(json_extract(pages_json, ?), '$.src') AS block, page_count AS "pageCount"
     FROM books WHERE id = ? AND owner_id = ?`;
const pageJsonSql = storage.postgres
  ? '(pages_json::json -> (?::integer))::text'
  : 'json_extract(pages_json, ?)';

const queries = {
  userByEmail: prepare('SELECT * FROM users WHERE email = ?'),
  createUser: prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)'),
  createSession: prepare('INSERT INTO sessions VALUES (?, ?, ?)'),
  findSession: prepare(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE token_hash = ? AND expires_at > ?
  `),
  deleteSession: prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  getBook: prepare(`SELECT ${summaryFields}, pages_json FROM books WHERE id = ? AND owner_id = ?`),
  getBookSummary: prepare(bookSummarySql),
  getBookMetadata: prepare(`SELECT ${summaryFields}, length(pages_json) AS "dataLength" FROM books WHERE id = ? AND owner_id = ?`),
  getBookChunk: prepare('SELECT substr(pages_json, ?, ?) AS chunk FROM books WHERE id = ? AND owner_id = ?'),
  getBookPageChunk: prepare(`
    WITH book_page AS MATERIALIZED (
      SELECT ${pageJsonSql} AS page_json FROM books WHERE id = ? AND owner_id = ?
    )
    SELECT substr(page_json, ?, ?) AS chunk, length(page_json) AS "dataLength" FROM book_page
  `),
  getBookPageCount: prepare('SELECT page_count AS "pageCount" FROM books WHERE id = ? AND owner_id = ?'),
  deleteHighlight: prepare(`
    DELETE FROM highlights
    WHERE id = ? AND book_id IN (SELECT id FROM books WHERE id = ? AND owner_id = ?)
  `),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const social = createSocialAPI({ storage, readJson, respondJson, HttpError });
const notes = createNotesAPI({ storage, readJson, respondJson, HttpError, social });

function respondJson(response, status, body) {
  const payload = JSON.stringify(body);
  if (hostedResponses.has(response) && Buffer.byteLength(payload) > maxHostedJsonBytes) {
    throw new HttpError(413, 'O conteúdo é grande demais. Atualize a página para carregar o livro em partes.');
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function parseJson(source) {
  try {
    const payload = typeof source === 'string' ? JSON.parse(source) : source;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  } catch {
    // Invalid JSON and non-object payloads share the same response.
  }
  throw new HttpError(400, 'Os dados enviados são inválidos.');
}

async function readJson(request, maxBytes = maxSmallRequestBytes) {
  const mediaType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'Envie os dados em formato JSON.');
  }
  if (Number(request.headers['content-length']) > maxBytes) {
    throw new HttpError(413, 'O conteúdo do arquivo é grande demais.');
  }

  const providedBody = await request.body;
  if (providedBody !== undefined) {
    const source = Buffer.isBuffer(providedBody) ? providedBody.toString('utf8') : providedBody;
    const serialized = typeof source === 'string' ? source : JSON.stringify(source);
    if (typeof serialized === 'string' && Buffer.byteLength(serialized) > maxBytes) {
      throw new HttpError(413, 'O conteúdo do arquivo é grande demais.');
    }
    return parseJson(source);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'O conteúdo do arquivo é grande demais.');
    }
    chunks.push(chunk);
  }

  return parseJson(Buffer.concat(chunks, size).toString('utf8'));
}

function enforceSameOrigin(request) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw new HttpError(403, 'Solicitação de origem externa.');
  }
  // A proxy can rewrite Host. Browsers supply their own fetch metadata.
  if (fetchSite === 'same-origin' || !request.headers.origin) return;

  let origin;
  try {
    origin = new URL(request.headers.origin);
  } catch {
    throw new HttpError(403, 'Solicitação de origem externa.');
  }
  if (origin.host !== request.headers.host?.toLowerCase() || !['http:', 'https:'].includes(origin.protocol)) {
    throw new HttpError(403, 'Solicitação de origem externa.');
  }
}

function sessionHash(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`));
  const token = cookie?.slice(sessionCookie.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

function sessionHeader(response, token, maxAge, hosted) {
  const flags = secureCookies || hosted ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${flags}`);
}

async function startSession(request, response, user, hosted) {
  const now = Date.now();
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const existingSession = sessionHash(request);

  await queries.deleteExpiredSessions.run(now);
  await queries.createSession.run(hash, user.id, now + sessionDuration);
  if (existingSession) await queries.deleteSession.run(existingSession);
  sessionHeader(response, token, sessionDuration / 1000, hosted);
}

async function activeUser(request) {
  const hash = sessionHash(request);
  return hash ? (await queries.findSession.get(hash, Date.now())) || null : null;
}

const attempts = new Map();
const attemptWindow = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(ip);
  }
}, attemptWindow).unref();

function checkAuthRate(request, hosted) {
  const forwarded = hosted && request.headers['x-vercel-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded : request.socket?.remoteAddress;
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + attemptWindow });
    return;
  }
  entry.count += 1;
  if (entry.count > 25) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto e tente novamente.');
  }
}

function cleanText(text) {
  return text.toWellFormed().replaceAll('\0', '\uFFFD');
}

async function register(request, response, hosted) {
  checkAuthRate(request, hosted);
  const data = await readJson(request);
  const name = typeof data.name === 'string' ? cleanText(data.name.trim()) : '';
  const email = normalizedEmail(data.email);
  const password = data.password;
  if (!name || name.length > 100) throw new HttpError(400, 'Informe um nome de até 100 caracteres.');
  if (!email) throw new HttpError(400, 'Informe um endereço de e-mail válido.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new HttpError(400, 'Use uma senha entre 8 e 256 caracteres.');
  }

  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  const user = { id: randomUUID(), name, email };
  try {
    await queries.createUser.run(user.id, name, email, salt, key);
  } catch (error) {
    if (error.errcode !== 2067 && error.code !== '23505') throw error;
    throw new HttpError(409, 'Este e-mail já possui uma conta.');
  }

  await startSession(request, response, user, hosted);
  respondJson(response, 201, { user });
}

function normalizedEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && cleanText(email) === email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function login(request, response, hosted) {
  checkAuthRate(request, hosted);
  const { email, password } = await readJson(request);
  const normalized = normalizedEmail(email);
  if (!normalized || typeof password !== 'string' || password.length > 256) {
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }

  const row = await queries.userByEmail.get(normalized);
  const key = await scryptAsync(password, row?.salt || dummySalt, 64);
  const valid = timingSafeEqual(key, row?.password_key || dummyKey);
  if (!row || !valid) throw new HttpError(401, 'E-mail ou senha incorretos.');

  const user = { id: row.id, name: row.name, email: row.email };
  await startSession(request, response, user, hosted);
  respondJson(response, 200, { user });
}

function isImage(value, maxLength = maxImageBytes) {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,/.exec(value);
  if (!match) return false;
  const payload = value.slice(match[0].length);
  return payload.length > 0 && payload.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(payload);
}

function sanitizeBlock(block) {
  if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && block.text.length <= 250_000) {
    return { type: 'text', text: cleanText(block.text) };
  }
  if (block?.type === 'image' && isImage(block.src)) {
    const alt = typeof block.alt === 'string' ? cleanText(block.alt.slice(0, 250)) : '';
    return { type: 'image', src: block.src, alt };
  }
  throw new HttpError(400, 'O livro contém um trecho em formato inválido.');
}

function formatBookSummary({ currentBlock, currentOffset, referrerId, referrerName, ...summary }) {
  return {
    ...summary,
    anchor: { block: currentBlock, offset: currentOffset },
    recommendedBy: referrerId ? { id: referrerId, name: referrerName } : null,
  };
}

async function saveBook(connection, id, userId, body) {
  const title = typeof body.title === 'string' ? cleanText(body.title.trim()) : '';
  if (!title || title.length > 300) throw new HttpError(400, 'Informe um título de até 300 caracteres.');
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > 2_000) {
    throw new HttpError(400, 'Envie um livro com 1 a 2.000 páginas.');
  }

  const pages = body.pages.map((page) => {
    if (!Array.isArray(page?.blocks) || page.blocks.length > 1_000) {
      throw new HttpError(400, 'O livro contém uma página em formato inválido.');
    }
    return { blocks: page.blocks.map(sanitizeBlock) };
  });
  if (!pages.some((page) => page.blocks.length)) throw new HttpError(400, 'O livro está vazio.');

  const thumbnail = body.thumbnail ?? null;
  if (thumbnail !== null && !isImage(thumbnail, 512 * 1024)) {
    throw new HttpError(400, 'A capa do livro está em formato inválido.');
  }

  const now = new Date().toISOString();
  await connection.run(insertBookSql, id, userId, title, thumbnail, JSON.stringify(pages), pages.length, now, now);
  return formatBookSummary(await connection.get(bookSummarySql, id, userId));
}

function notFound() {
  return new HttpError(404, 'Livro não encontrado.');
}

async function saveProgress(request, response, bookId, userId) {
  const { page, anchor = { block: 0, offset: 0 } } = await readJson(request);
  const { block, offset } = anchor ?? {};
  if (!Number.isSafeInteger(page) || page < 0 || page >= 2_000) throw new HttpError(400, 'Página inválida.');
  if (!Number.isSafeInteger(block) || block < 0 || block >= 1_000
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 250_000) {
    throw new HttpError(400, 'Posição de leitura inválida.');
  }

  const update = (connection) => connection.run(
    updateProgressSql, page, block, offset, new Date().toISOString(), bookId, userId, page,
  );
  // Page-only progress and an anchor at the page start need no PDF content lookup.
  const result = block || offset ? await storage.transaction(async (connection) => {
    const row = await getBookBlock(connection, page, block, bookId, userId);
    if (!row) throw notFound();
    if (page >= row.pageCount) throw new HttpError(400, 'Página inválida.');
    const target = row.block ? JSON.parse(row.block) : null;
    if (!target || (offset > 0 && (target.type !== 'text'
        || offset > target.text.length || splitsSurrogate(target.text, offset)))) {
      throw new HttpError(400, 'Posição de leitura inválida.');
    }
    return update(connection);
  }) : await update(storage);
  if (result.changes === 0) {
    if (!await queries.getBookPageCount.get(bookId, userId)) throw notFound();
    throw new HttpError(400, 'Página inválida.');
  }
  respondJson(response, 200, { ok: true });
}

function splitsSurrogate(text, offset) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function getBookBlock(connection, page, block, bookId, userId) {
  const location = storage.postgres ? [page, block] : [`$[${page}].blocks[${block}]`];
  return connection.get(getBlockSql, ...location, bookId, userId);
}

function hexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

async function readerColors(response, userId) {
  const rows = await storage.all('SELECT color FROM reader_colors WHERE user_id = ? ORDER BY created_at DESC, color', userId);
  return respondJson(response, 200, { colors: rows.map(({ color }) => color) });
}

async function saveReaderColor(request, response, userId) {
  const { color } = await readJson(request);
  const normalized = hexColor(color);
  if (!normalized) throw new HttpError(400, 'Cor inválida.');
  await storage.run(`
    INSERT INTO reader_colors (user_id, color, created_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id, color) DO UPDATE SET created_at = excluded.created_at
  `, userId, normalized, Date.now());
  return readerColors(response, userId);
}

function highlightNote(value) {
  if (value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Observação inválida.');
  const note = cleanText(value.trim());
  if (note.length > maxHighlightNoteLength) {
    throw new HttpError(400, `A observação pode ter até ${maxHighlightNoteLength} caracteres.`);
  }
  return note;
}

function highlightScope(value) {
  if (!highlightScopes.has(value)) throw new HttpError(400, 'Visibilidade de destaque inválida.');
  return value;
}

async function verifyHighlightSharing(connection, bookId, userId) {
  if (!await social.canShareHighlight(bookId, userId, connection)) {
    throw new HttpError(403, 'Vincule este livro a um grupo para compartilhar destaques.');
  }
}

function writeHighlightDetails(connection, id, note, scope) {
  return connection.run(`
    INSERT INTO highlight_details (highlight_id, note, scope) VALUES (?, ?, ?)
    ON CONFLICT (highlight_id) DO UPDATE SET note = excluded.note, scope = excluded.scope
  `, id, note, scope);
}

async function saveHighlight(request, response, bookId, userId) {
  const {
    id: clientId, page, block, start, end, color: inputColor = 'yellow', note: inputNote = '', scope: inputScope = 'private',
  } = await readJson(request);
  const color = presetColors.has(inputColor) ? inputColor : hexColor(inputColor);
  if (![page, block, start, end].every((number) => Number.isSafeInteger(number) && number >= 0)
      || page >= 2_000 || block >= 1_000 || start >= end || end - start > 10_000 || !color) {
    throw new HttpError(400, 'Seleção de texto inválida.');
  }
  if (clientId !== undefined && (typeof clientId !== 'string' || !uuidPattern.test(clientId))) {
    throw new HttpError(400, 'Identificador de destaque inválido.');
  }
  const id = clientId?.toLowerCase() ?? randomUUID();
  const note = highlightNote(inputNote);
  const scope = highlightScope(inputScope);

  const highlight = await storage.transaction(async (connection) => {
    const row = await getBookBlock(connection, page, block, bookId, userId);
    if (!row) throw notFound();
    const target = row.block ? JSON.parse(row.block) : null;
    if (target?.type !== 'text' || end > target.text.length
        || splitsSurrogate(target.text, start) || splitsSurrogate(target.text, end)) {
      throw new HttpError(400, 'Seleção de texto inválida.');
    }
    const text = cleanText(target.text.slice(start, end));
    if (!text.trim()) throw new HttpError(400, 'Selecione uma palavra ou frase.');

    const existing = clientId ? await connection.get(highlightByIdSql, id, bookId) : null;
    if (existing) {
      if (existing.page === page && existing.block === block && existing.start === start && existing.end === end
          && existing.text === text && existing.color === color && existing.note === note && existing.scope === scope) return existing;
      throw new HttpError(409, 'Não foi possível usar este identificador de destaque.');
    }

    if (scope === 'group') await verifyHighlightSharing(connection, bookId, userId);
    const createdAt = new Date().toISOString();
    const inserted = await connection.run(`
      INSERT INTO highlights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `, id, bookId, page, block, start, end, text, color, createdAt);
    if (!inserted.changes) throw new HttpError(409, 'Não foi possível usar este identificador de destaque.');
    await writeHighlightDetails(connection, id, note, scope);
    return { id, page, block, start, end, text, color, createdAt, note, scope };
  });
  respondJson(response, 201, { highlight });
}

async function editHighlight(request, response, bookId, highlightId, userId) {
  const { note: inputNote, scope: inputScope } = await readJson(request);
  if (inputNote === undefined && inputScope === undefined) {
    throw new HttpError(400, 'Informe uma observação ou visibilidade para o destaque.');
  }
  const requestedNote = inputNote === undefined ? undefined : highlightNote(inputNote);
  const requestedScope = inputScope === undefined ? undefined : highlightScope(inputScope);
  const highlight = await storage.transaction(async (connection) => {
    // Use the same book row lock as creation to serialize updates and client retries.
    const book = await connection.get(`SELECT id FROM books WHERE id = ? AND owner_id = ?${storage.forUpdate}`, bookId, userId);
    const existing = book ? await connection.get(editableHighlightSql, highlightId, bookId) : null;
    if (!existing) throw new HttpError(404, 'Destaque não encontrado.');
    const note = requestedNote ?? existing.note;
    const scope = requestedScope ?? existing.scope;
    if (scope === 'group' && existing.scope !== 'group') await verifyHighlightSharing(connection, bookId, userId);
    if (existing.scope !== scope) await notes.preserveLegacyNote(connection, highlightId);
    if (requestedNote === undefined) {
      if (existing.scope !== scope) {
        await writeHighlightDetails(connection, highlightId, '', scope);
      }
    } else {
      const materialized = await notes.writeLegacyNote(connection, highlightId, note);
      await writeHighlightDetails(connection, highlightId, materialized ? '' : note, scope);
    }
    return { ...existing, note, scope };
  });
  respondJson(response, 200, { highlight });
}

function importNotFound() {
  return new HttpError(404, 'Importação não encontrada ou expirada.');
}

function importConflict() {
  return new HttpError(409, 'Não foi possível usar este identificador de importação.');
}

async function startImport(request, response, userId) {
  const { id: clientId, partCount, accountId } = await readJson(request);
  if (accountId !== undefined && accountId !== userId) {
    throw new HttpError(403, 'Entre novamente na conta que iniciou esta importação.');
  }
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > maxImportParts) {
    throw new HttpError(400, 'Quantidade de partes inválida.');
  }
  if (clientId !== undefined && (typeof clientId !== 'string' || !uuidPattern.test(clientId))) {
    throw new HttpError(400, 'Identificador de importação inválido.');
  }

  const id = clientId?.toLowerCase() ?? randomUUID();
  await storage.run('DELETE FROM imports WHERE expires_at <= ? AND completed <> ?', Date.now(), deletedImport);
  const { status, body } = await storage.transaction(async (connection) => {
    // Serialize starts for one account without blocking the book insert's foreign-key check.
    const userLock = storage.postgres ? ' FOR NO KEY UPDATE' : '';
    await connection.get(`SELECT id FROM users WHERE id = ?${userLock}`, userId);
    const item = await lockImport(connection, id, userId);
    const now = Date.now();

    if (item?.completed === deletedImport) throw notFound();
    if (item && item.expires_at > now && !item.completed) {
      if (item.part_count !== partCount) throw new HttpError(409, 'A quantidade de partes desta importação mudou.');
      const parts = await connection.all(
        'SELECT part_number FROM import_parts WHERE import_id = ? ORDER BY part_number', id,
      );
      await connection.run('UPDATE imports SET expires_at = ? WHERE id = ?', now + importDuration, id);
      return { status: 200, body: { id, receivedParts: parts.map(({ part_number }) => part_number) } };
    }

    const book = await connection.get(bookSummarySql, id, userId);
    if (book) return { status: 200, body: { id, book: formatBookSummary(book), receivedParts: [] } };
    if (item && item.expires_at > now) throw notFound();
    if (await connection.get('SELECT id FROM books WHERE id = ?', id)) throw importConflict();

    await connection.run('DELETE FROM imports WHERE id = ? AND expires_at <= ? AND completed <> ?', id, now, deletedImport);
    const { count } = await connection.get(
      `SELECT CAST(count(*) AS INTEGER) AS count
       FROM imports WHERE owner_id = ? AND completed = 0 AND expires_at > ?`, userId, now,
    );
    if (count >= 4) throw new HttpError(429, 'Há muitas importações em andamento. Conclua ou cancele uma delas.');
    const created = await connection.run(
      `INSERT INTO imports (id, owner_id, part_count, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      id, userId, partCount, now + importDuration,
    );
    if (!created.changes) throw importConflict();
    return { status: 201, body: { id, receivedParts: [] } };
  });
  respondJson(response, status, body);
}

function lockImport(connection, importId, userId) {
  return connection.get(
    `SELECT part_count, completed, expires_at FROM imports WHERE id = ? AND owner_id = ?${storage.forUpdate}`,
    importId, userId,
  );
}

async function putImportPart(request, response, importId, userId, partNumber) {
  const { chunk } = await readJson(request, maxPartBytes);
  if (typeof chunk !== 'string' || !chunk.length || chunk.length > chunkSize || cleanText(chunk) !== chunk) {
    throw new HttpError(400, 'Parte do arquivo inválida.');
  }

  await storage.transaction(async (connection) => {
    const item = await lockImport(connection, importId, userId);
    if (!item || item.completed === deletedImport || item.expires_at <= Date.now()) throw importNotFound();
    if (item.completed) throw new HttpError(409, 'Esta importação já foi concluída.');
    if (partNumber >= item.part_count) throw new HttpError(400, 'Número de parte inválido.');

    const bytes = Buffer.byteLength(chunk);
    const { previousBytes } = await connection.get(
      `SELECT CAST(COALESCE(sum(byte_count), 0) AS INTEGER) AS "previousBytes"
       FROM import_parts WHERE import_id = ? AND part_number <> ?`,
      importId, partNumber,
    );
    if (previousBytes + bytes > maxBookBytes) {
      throw new HttpError(413, 'O conteúdo do arquivo é grande demais.');
    }
    await connection.run(`
      INSERT INTO import_parts (import_id, part_number, chunk, byte_count) VALUES (?, ?, ?, ?)
      ON CONFLICT (import_id, part_number) DO UPDATE SET chunk = excluded.chunk, byte_count = excluded.byte_count
    `, importId, partNumber, chunk, bytes);
  });
  respondJson(response, 200, { ok: true });
}

async function completeImport(response, importId, userId) {
  const book = await storage.transaction(async (connection) => {
    const item = await lockImport(connection, importId, userId);
    if (item?.completed === deletedImport) throw notFound();
    if (!item || item.completed || item.expires_at <= Date.now()) {
      const existing = await connection.get(bookSummarySql, importId, userId);
      if (existing) return formatBookSummary(existing);
      if (item?.completed) throw notFound();
      throw importNotFound();
    }

    const parts = await connection.all('SELECT chunk FROM import_parts WHERE import_id = ? ORDER BY part_number', importId);
    if (parts.length !== item.part_count) throw new HttpError(409, 'Ainda faltam partes do arquivo.');

    const body = parseJson(parts.map(({ chunk }) => chunk).join(''));
    const saved = await saveBook(connection, importId, userId, body);
    await connection.run('UPDATE imports SET completed = 1, expires_at = ? WHERE id = ?', Date.now() + importDuration, importId);
    await connection.run('DELETE FROM import_parts WHERE import_id = ?', importId);
    return saved;
  });
  respondJson(response, 201, { book });
}

async function deleteBook(response, bookId, userId) {
  await storage.transaction(async (connection) => {
    await lockImport(connection, bookId, userId);
    const deleted = await connection.run('DELETE FROM books WHERE id = ? AND owner_id = ?', bookId, userId);
    if (!deleted.changes) throw notFound();

    // An old client job can outlive the upload receipt and must not restore a deleted book.
    const marker = await connection.run(`
      INSERT INTO imports (id, owner_id, part_count, expires_at, completed) VALUES (?, ?, 0, ?, ?)
      ON CONFLICT (id) DO UPDATE SET part_count = 0, expires_at = excluded.expires_at, completed = excluded.completed
      WHERE imports.owner_id = excluded.owner_id
    `, bookId, userId, Number.MAX_SAFE_INTEGER, deletedImport);
    if (!marker.changes) throw importConflict();
    await connection.run('DELETE FROM import_parts WHERE import_id = ?', bookId);
  });
  respondJson(response, 200, { ok: true });
}

function numericParam(value, message, max = 10_000_000) {
  if (!/^\d{1,8}$/.test(value) || Number(value) > max) throw new HttpError(400, message);
  return Number(value);
}

async function readBookPage(response, bookId, userId, searchParams) {
  const page = numericParam(searchParams.get('page'), 'Página inválida.', 1_999);
  const part = numericParam(searchParams.get('part') ?? '0', 'Número de parte inválido.', maxImportParts - 1);
  const location = storage.postgres ? page : `$[${page}]`;
  const row = await queries.getBookPageChunk.get(location, bookId, userId, part * chunkSize + 1, chunkSize);
  if (!row) throw notFound();
  if (row.dataLength === null) throw new HttpError(404, 'Página do livro não encontrada.');
  if (!row.chunk) throw new HttpError(404, 'Parte da página não encontrada.');
  return respondJson(response, 200, { chunk: row.chunk, partCount: Math.ceil(row.dataLength / chunkSize) });
}

async function listRows(sql, id, searchParams, limit, hosted) {
  const offset = searchParams.get('offset');
  if (offset === null && !hosted) return { rows: await storage.all(sql, id), nextOffset: null };

  const start = numericParam(offset ?? '0', 'Posição da lista inválida.');
  const rows = await storage.all(`${sql} LIMIT ? OFFSET ?`, id, limit + 1, start);
  const nextOffset = rows.length > limit ? start + limit : null;
  return { rows: rows.slice(0, limit), nextOffset };
}

async function handleApi(request, response, pathname, searchParams, hosted) {
  const { method } = request;
  if (method !== 'GET') enforceSameOrigin(request);
  if (pathname === '/api/session' && method === 'GET') {
    return respondJson(response, 200, { user: await activeUser(request) });
  }
  if (pathname === '/api/register' && method === 'POST') return register(request, response, hosted);
  if (pathname === '/api/login' && method === 'POST') return login(request, response, hosted);
  if (pathname === '/api/logout' && method === 'POST') {
    const hash = sessionHash(request);
    if (hash) await queries.deleteSession.run(hash);
    sessionHeader(response, '', 0, hosted);
    return respondJson(response, 200, { ok: true });
  }

  const user = await activeUser(request);
  if (!user) throw new HttpError(401, 'Entre na sua conta para continuar.');

  if (pathname.startsWith('/api/social') && await social.handle(request, response, pathname, searchParams, user)) return;
  if (await notes.handle(request, response, pathname, searchParams, user)) return;

  if (pathname === '/api/highlights' && method === 'GET') {
    const { rows, nextOffset } = await listRows(listAccountHighlightsSql, user.id, searchParams, highlightBatchSize, hosted);
    const groups = new Map();
    for (const { bookId, title, ...highlight } of rows) {
      if (!groups.has(bookId)) groups.set(bookId, { id: bookId, title, highlights: [] });
      groups.get(bookId).highlights.push(highlight);
    }
    return respondJson(response, 200, { books: [...groups.values()], nextOffset });
  }
  if (pathname === '/api/reader/colors' && method === 'GET') {
    return readerColors(response, user.id);
  }
  if (pathname === '/api/reader/colors' && method === 'POST') {
    return saveReaderColor(request, response, user.id);
  }

  if (pathname === '/api/books') {
    if (method === 'GET') {
      const { rows, nextOffset } = await listRows(listBooksSql, user.id, searchParams, bookBatchSize, hosted);
      return respondJson(response, 200, { books: rows.map(formatBookSummary), nextOffset });
    }
    if (method === 'POST') {
      const body = await readJson(request, hosted ? maxHostedJsonBytes : maxBookBytes);
      const book = await storage.transaction((connection) => saveBook(connection, randomUUID(), user.id, body));
      return respondJson(response, 201, { book });
    }
  }

  if (pathname === '/api/imports' && method === 'POST') return startImport(request, response, user.id);
  const importRoute = /^\/api\/imports\/([a-f0-9-]{36})(?:\/(complete|\d{1,3}))?$/.exec(pathname);
  if (importRoute) {
    const [, importId, operation] = importRoute;
    if (!operation && method === 'DELETE') {
      const result = await storage.run('DELETE FROM imports WHERE id = ? AND owner_id = ? AND completed = 0', importId, user.id);
      if (result.changes === 0) throw importNotFound();
      return respondJson(response, 200, { ok: true });
    }
    if (operation === 'complete' && method === 'POST') return completeImport(response, importId, user.id);
    if (operation && operation !== 'complete' && method === 'PUT') {
      return putImportPart(request, response, importId, user.id, Number(operation));
    }
  }

  const match = /^\/api\/books\/([a-f0-9-]{36})(?:\/(progress|highlights|data|page)(?:\/([a-f0-9-]{36}))?)?$/.exec(pathname);
  if (!match) throw new HttpError(404, 'Recurso não encontrado.');
  const [, bookId, resource, highlightId] = match;

  if (!resource && method === 'GET') {
    if (searchParams.get('metadata') === '1') {
      const paged = searchParams.get('paged') === '1';
      const row = await (paged ? queries.getBookSummary : queries.getBookMetadata).get(bookId, user.id);
      if (!row) throw notFound();
      const { dataLength, ...summary } = row;
      const { rows, nextOffset } = await listRows(listHighlightsSql, bookId, new URLSearchParams({ offset: '0' }), highlightBatchSize, true);
      const transfer = paged ? {} : { partCount: Math.ceil(dataLength / chunkSize) };
      return respondJson(response, 200, {
        book: { ...formatBookSummary(summary), ...transfer, highlights: rows, nextHighlightOffset: nextOffset },
      });
    }
    const row = await queries.getBook.get(bookId, user.id);
    if (!row) throw notFound();
    const { pages_json: pages, ...summary } = row;
    return respondJson(response, 200, {
      book: { ...formatBookSummary(summary), pages: JSON.parse(pages), highlights: await storage.all(listHighlightsSql, bookId) },
    });
  }
  if (!resource && method === 'DELETE') {
    return deleteBook(response, bookId, user.id);
  }
  if (resource === 'data' && !highlightId && method === 'GET') {
    const part = numericParam(searchParams.get('part'), 'Número de parte inválido.', maxImportParts - 1);
    const row = await queries.getBookChunk.get(part * chunkSize + 1, chunkSize, bookId, user.id);
    if (!row) throw notFound();
    if (!row.chunk) throw new HttpError(404, 'Parte do livro não encontrada.');
    return respondJson(response, 200, { chunk: row.chunk });
  }
  if (resource === 'page' && !highlightId && method === 'GET') {
    return readBookPage(response, bookId, user.id, searchParams);
  }
  if (resource === 'progress' && !highlightId && method === 'PATCH') {
    return saveProgress(request, response, bookId, user.id);
  }
  if (resource === 'highlights' && !highlightId && method === 'GET') {
    if (!await queries.getBookSummary.get(bookId, user.id)) throw notFound();
    const { rows, nextOffset } = await listRows(listHighlightsSql, bookId, searchParams, highlightBatchSize, hosted);
    return respondJson(response, 200, { highlights: rows, nextOffset });
  }
  if (resource === 'highlights' && !highlightId && method === 'POST') {
    return saveHighlight(request, response, bookId, user.id);
  }
  if (resource === 'highlights' && highlightId && method === 'PATCH') {
    return editHighlight(request, response, bookId, highlightId, user.id);
  }
  if (resource === 'highlights' && highlightId && method === 'DELETE') {
    if ((await queries.deleteHighlight.run(highlightId, bookId, user.id)).changes === 0) {
      throw new HttpError(404, 'Destaque não encontrado.');
    }
    return respondJson(response, 200, { ok: true });
  }
  throw new HttpError(404, 'Recurso não encontrado.');
}

const staticTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

async function serveStatic(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Método inválido.');

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Endereço inválido.');
  }

  const target = resolve(distDirectory, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!target.startsWith(`${distDirectory}${sep}`) || target.includes('\0')) {
    throw new HttpError(404, 'Página não encontrada.');
  }
  const info = await stat(target).catch((error) => {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return null;
  });
  if (!info?.isFile()) throw new HttpError(404, 'Página não encontrada.');

  response.writeHead(200, {
    'Content-Type': staticTypes[extname(target)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': target.startsWith(resolve(distDirectory, 'assets') + sep)
      ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (request.method === 'HEAD') return response.end();
  await pipeline(createReadStream(target), response);
}

export async function handleRequest(request, response, { hosted = vercel } = {}) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (hosted) hostedResponses.add(response);
  try {
    if (hosted && !storage.postgres) {
      throw new HttpError(503, 'O banco de dados está indisponível. Tente novamente em instantes.');
    }
    const url = new URL(request.url, 'http://localhost');
    const pathname = hosted && url.pathname === '/api/router' && url.searchParams.has('__route')
      ? `/api/${url.searchParams.get('__route')}`
      : url.pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(request, response, pathname, url.searchParams, hosted);
    } else if (hosted) {
      throw new HttpError(404, 'Recurso não encontrado.');
    } else {
      await serveStatic(request, response, pathname);
    }
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    request.resume?.();
    if (error instanceof HttpError) {
      respondJson(response, error.status, { error: error.message });
    } else {
      console.error('Falha ao processar a solicitação.', error.code || error.name);
      respondJson(response, 500, { error: 'Ocorreu um erro ao processar sua solicitação.' });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer({ requestTimeout: 120_000 }, handleRequest);
  server.listen(port, host, () => {
    console.log(`Leitura disponível em http://${host}:${port}`);
  });
}
