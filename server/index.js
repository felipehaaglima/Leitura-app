import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createStorage } from './database.js';

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
const bookBatchSize = 6;
const highlightBatchSize = 48;
const scryptAsync = promisify(scrypt);
const dummySalt = randomBytes(16);
const dummyKey = randomBytes(64);
const colors = new Set(['yellow', 'green', 'pink']);
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
  created_at AS "createdAt", updated_at AS "updatedAt",
  CAST((SELECT count(*) FROM highlights WHERE highlights.book_id = books.id) AS INTEGER) AS "highlightCount"
`;

const insertBookSql = `
  INSERT INTO books (id, owner_id, title, thumbnail, pages_json, page_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;
const bookSummarySql = `SELECT ${summaryFields} FROM books WHERE id = ? AND owner_id = ?`;
const listBooksSql = `SELECT ${summaryFields} FROM books WHERE owner_id = ? ORDER BY updated_at DESC, id`;
const listHighlightsSql = `
  SELECT id, page, block, "start", "end", text, color, created_at AS "createdAt"
  FROM highlights WHERE book_id = ? ORDER BY page, block, "start", created_at, id
`;
const listAccountHighlightsSql = `
  SELECT books.id AS "bookId", books.title, highlights.id, page, block, "start", "end", text, color,
         highlights.created_at AS "createdAt"
  FROM books JOIN highlights ON highlights.book_id = books.id
  WHERE books.owner_id = ?
  ORDER BY books.updated_at DESC, books.id, page, block, "start", highlights.created_at, highlights.id
`;
const getBlockSql = storage.postgres
  ? `SELECT (pages_json::jsonb -> (?::integer) -> 'blocks' -> (?::integer))::text AS block
     FROM books WHERE id = ? AND owner_id = ?${storage.forUpdate}`
  : 'SELECT json_extract(pages_json, ?) AS block FROM books WHERE id = ? AND owner_id = ?';

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
  deleteBook: prepare('DELETE FROM books WHERE id = ? AND owner_id = ?'),
  updateProgress: prepare(`
    UPDATE books SET current_page = ?, updated_at = ?
    WHERE id = ? AND owner_id = ? AND page_count > ?
  `),
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
  return connection.get(bookSummarySql, id, userId);
}

function notFound() {
  return new HttpError(404, 'Livro não encontrado.');
}

async function saveProgress(request, response, bookId, userId) {
  const { page } = await readJson(request);
  if (!Number.isSafeInteger(page) || page < 0 || page >= 2_000) throw new HttpError(400, 'Página inválida.');

  const result = await queries.updateProgress.run(page, new Date().toISOString(), bookId, userId, page);
  if (result.changes === 0) {
    if (!await queries.getBookSummary.get(bookId, userId)) throw notFound();
    throw new HttpError(400, 'Página inválida.');
  }
  respondJson(response, 200, { ok: true });
}

function splitsSurrogate(text, offset) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

async function saveHighlight(request, response, bookId, userId) {
  const { page, block, start, end, color = 'yellow' } = await readJson(request);
  if (![page, block, start, end].every((number) => Number.isSafeInteger(number) && number >= 0)
      || page >= 2_000 || block >= 1_000 || start >= end || end - start > 10_000 || !colors.has(color)) {
    throw new HttpError(400, 'Seleção de texto inválida.');
  }

  const blockLocation = storage.postgres ? [page, block] : [`$[${page}].blocks[${block}]`];
  const highlight = await storage.transaction(async (connection) => {
    const row = await connection.get(getBlockSql, ...blockLocation, bookId, userId);
    if (!row) throw notFound();
    const target = row.block ? JSON.parse(row.block) : null;
    if (target?.type !== 'text' || end > target.text.length
        || splitsSurrogate(target.text, start) || splitsSurrogate(target.text, end)) {
      throw new HttpError(400, 'Seleção de texto inválida.');
    }
    const text = target.text.slice(start, end);
    if (!text.trim()) throw new HttpError(400, 'Selecione uma palavra ou frase.');

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await connection.run('INSERT INTO highlights VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, bookId, page, block, start, end, cleanText(text), color, createdAt);
    return { id, page, block, start, end, text, color, createdAt };
  });
  respondJson(response, 201, { highlight });
}

function importNotFound() {
  return new HttpError(404, 'Importação não encontrada ou expirada.');
}

async function startImport(request, response, userId) {
  const { partCount } = await readJson(request);
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > maxImportParts) {
    throw new HttpError(400, 'Quantidade de partes inválida.');
  }

  const id = randomUUID();
  const now = Date.now();
  await storage.transaction(async (connection) => {
    await connection.run('DELETE FROM imports WHERE expires_at <= ?', now);
    await connection.get(`SELECT id FROM users WHERE id = ?${storage.forUpdate}`, userId);
    const { count } = await connection.get(
      'SELECT CAST(count(*) AS INTEGER) AS count FROM imports WHERE owner_id = ? AND completed = 0', userId,
    );
    if (count >= 4) throw new HttpError(429, 'Há muitas importações em andamento. Conclua ou cancele uma delas.');
    await connection.run('INSERT INTO imports (id, owner_id, part_count, expires_at) VALUES (?, ?, ?, ?)',
      id, userId, partCount, now + importDuration);
  });
  respondJson(response, 201, { id });
}

function getImport(connection, importId, userId) {
  return connection.get(
    `SELECT part_count, completed FROM imports WHERE id = ? AND owner_id = ? AND expires_at > ?${storage.forUpdate}`,
    importId, userId, Date.now(),
  );
}

async function putImportPart(request, response, importId, userId, partNumber) {
  const { chunk } = await readJson(request, maxPartBytes);
  if (typeof chunk !== 'string' || !chunk.length || chunk.length > chunkSize || cleanText(chunk) !== chunk) {
    throw new HttpError(400, 'Parte do arquivo inválida.');
  }

  await storage.transaction(async (connection) => {
    const item = await getImport(connection, importId, userId);
    if (!item) throw importNotFound();
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
    const item = await getImport(connection, importId, userId);
    if (!item) throw importNotFound();
    if (item.completed) {
      const existing = await connection.get(bookSummarySql, importId, userId);
      if (!existing) throw notFound();
      return existing;
    }

    const parts = await connection.all('SELECT chunk FROM import_parts WHERE import_id = ? ORDER BY part_number', importId);
    if (parts.length !== item.part_count) throw new HttpError(409, 'Ainda faltam partes do arquivo.');

    const body = parseJson(parts.map(({ chunk }) => chunk).join(''));
    const saved = await saveBook(connection, importId, userId, body);
    await connection.run('UPDATE imports SET completed = 1 WHERE id = ?', importId);
    await connection.run('DELETE FROM import_parts WHERE import_id = ?', importId);
    return saved;
  });
  respondJson(response, 201, { book });
}

function numericParam(value, message, max = 10_000_000) {
  if (!/^\d{1,8}$/.test(value) || Number(value) > max) throw new HttpError(400, message);
  return Number(value);
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

  if (pathname === '/api/highlights' && method === 'GET') {
    const { rows, nextOffset } = await listRows(listAccountHighlightsSql, user.id, searchParams, highlightBatchSize, hosted);
    const groups = new Map();
    for (const { bookId, title, ...highlight } of rows) {
      if (!groups.has(bookId)) groups.set(bookId, { id: bookId, title, highlights: [] });
      groups.get(bookId).highlights.push(highlight);
    }
    return respondJson(response, 200, { books: [...groups.values()], nextOffset });
  }

  if (pathname === '/api/books') {
    if (method === 'GET') {
      const { rows, nextOffset } = await listRows(listBooksSql, user.id, searchParams, bookBatchSize, hosted);
      return respondJson(response, 200, { books: rows, nextOffset });
    }
    if (method === 'POST') {
      const body = await readJson(request, hosted ? maxHostedJsonBytes : maxBookBytes);
      const book = await saveBook(storage, randomUUID(), user.id, body);
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

  const match = /^\/api\/books\/([a-f0-9-]{36})(?:\/(progress|highlights|data)(?:\/([a-f0-9-]{36}))?)?$/.exec(pathname);
  if (!match) throw new HttpError(404, 'Recurso não encontrado.');
  const [, bookId, resource, highlightId] = match;

  if (!resource && method === 'GET') {
    if (searchParams.get('metadata') === '1') {
      const row = await queries.getBookMetadata.get(bookId, user.id);
      if (!row) throw notFound();
      const { dataLength, ...summary } = row;
      const { rows, nextOffset } = await listRows(listHighlightsSql, bookId, new URLSearchParams({ offset: '0' }), highlightBatchSize, true);
      const partCount = Math.ceil(dataLength / chunkSize);
      return respondJson(response, 200, { book: { ...summary, partCount, highlights: rows, nextHighlightOffset: nextOffset } });
    }
    const row = await queries.getBook.get(bookId, user.id);
    if (!row) throw notFound();
    const { pages_json: pages, ...summary } = row;
    return respondJson(response, 200, {
      book: { ...summary, pages: JSON.parse(pages), highlights: await storage.all(listHighlightsSql, bookId) },
    });
  }
  if (!resource && method === 'DELETE') {
    if ((await queries.deleteBook.run(bookId, user.id)).changes === 0) throw notFound();
    return respondJson(response, 200, { ok: true });
  }
  if (resource === 'data' && !highlightId && method === 'GET') {
    const part = numericParam(searchParams.get('part'), 'Número de parte inválido.', maxImportParts - 1);
    const row = await queries.getBookChunk.get(part * chunkSize + 1, chunkSize, bookId, user.id);
    if (!row) throw notFound();
    if (!row.chunk) throw new HttpError(404, 'Parte do livro não encontrada.');
    return respondJson(response, 200, { chunk: row.chunk });
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
