import { randomUUID } from 'node:crypto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxNoteLength = 2_000;
const mentionBatchSize = 40;
const noteFields = 'id, text, scope, created_at AS "createdAt", updated_at AS "updatedAt"';
const visibleNotesSql = `
  WITH visible_mark AS (
    SELECT h.id, h.created_at, d.note, COALESCE(d.scope, 'private') AS mark_scope,
           CASE WHEN h.book_id = viewer.id THEN 1 ELSE 0 END AS owned,
           reader.group_id
    FROM books AS viewer JOIN highlights AS h ON h.id = ?
    JOIN books AS writer_book ON writer_book.id = h.book_id
    LEFT JOIN highlight_details AS d ON d.highlight_id = h.id
    LEFT JOIN reading_group_members AS reader ON reader.book_id = viewer.id
      AND reader.user_id = viewer.owner_id AND reader.status = 'active'
    LEFT JOIN reading_group_members AS writer ON writer.book_id = writer_book.id
      AND writer.user_id = writer_book.owner_id AND writer.status = 'active' AND writer.group_id = reader.group_id
    WHERE viewer.id = ? AND viewer.owner_id = ?
      AND (h.book_id = viewer.id OR (d.scope = 'group' AND writer.user_id <> viewer.owner_id))
  ), notes AS (
    SELECT n.id, n.highlight_id, n.text, n.scope, n.created_at, n.updated_at
    FROM highlight_notes AS n JOIN visible_mark AS m ON m.id = n.highlight_id
    WHERE m.owned = 1 OR n.scope = 'group'
    UNION ALL
    SELECT m.id, m.id, m.note, m.mark_scope, m.created_at, m.created_at
    FROM visible_mark AS m WHERE m.note <> '' AND (m.owned = 1 OR m.mark_scope = 'group')
      AND NOT EXISTS (SELECT 1 FROM highlight_notes AS adopted WHERE adopted.id = m.id AND adopted.highlight_id = m.id)
  )
  SELECT n.id, n.text, n.scope, n.created_at AS "createdAt", n.updated_at AS "updatedAt",
         u.id AS mention_id, u.name AS mention_name
  FROM visible_mark AS m LEFT JOIN notes AS n ON n.highlight_id = m.id
  LEFT JOIN highlight_note_mentions AS selected ON selected.note_id = n.id AND n.scope = 'group' AND m.mark_scope = 'group'
  LEFT JOIN reading_group_members AS target ON target.group_id = m.group_id AND target.user_id = selected.user_id AND target.status = 'active'
  LEFT JOIN users AS u ON u.id = target.user_id
  ORDER BY n.created_at, n.id, u.name, u.id
`;
const activeMembersSql = `
  SELECT u.id, u.name FROM reading_group_members AS owner
  JOIN reading_group_members AS target ON target.group_id = owner.group_id AND target.status = 'active'
  JOIN users AS u ON u.id = target.user_id
  WHERE owner.book_id = ? AND owner.user_id = ? AND owner.status = 'active'
  ORDER BY u.name, u.id
`;
const inboxSql = `
  SELECT n.id, h.id AS "highlightId", viewer_book.id AS "bookId", viewer_book.title,
         h.page, h.block, h."start", n.text, u.id AS author_id, u.name AS author_name,
         n.created_at AS "createdAt"
  FROM highlight_note_mentions AS selected
  JOIN highlight_notes AS n ON n.id = selected.note_id AND n.scope = 'group'
  JOIN highlights AS h ON h.id = n.highlight_id
  JOIN highlight_details AS d ON d.highlight_id = h.id AND d.scope = 'group'
  JOIN books AS writer_book ON writer_book.id = h.book_id
  JOIN reading_group_members AS writer ON writer.book_id = writer_book.id
    AND writer.user_id = writer_book.owner_id AND writer.status = 'active'
  JOIN reading_group_members AS reader ON reader.group_id = writer.group_id
    AND reader.user_id = selected.user_id AND reader.status = 'active'
  JOIN books AS viewer_book ON viewer_book.id = reader.book_id AND viewer_book.owner_id = reader.user_id
  JOIN users AS u ON u.id = writer.user_id
  WHERE selected.user_id = ? AND writer.user_id <> selected.user_id
  ORDER BY n.created_at DESC, n.id LIMIT ? OFFSET ?
`;

export function createNotesAPI({ storage, readJson, respondJson, HttpError, social }) {
  const highlightLock = storage.postgres ? ' FOR UPDATE OF h' : '';
  const notFound = () => new HttpError(404, 'Esta nota ou destaque não está disponível.');
  const conflict = () => new HttpError(409, 'Não foi possível usar este identificador de nota.');

  function normalizeId(value) {
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw new HttpError(400, 'Identificador inválido.');
    return value.toLowerCase();
  }

  function parseText(value) {
    if (typeof value !== 'string') throw new HttpError(400, 'Informe o texto da nota.');
    const text = value.trim().toWellFormed().replaceAll('\0', '\uFFFD');
    if (!text || text.length > maxNoteLength) {
      throw new HttpError(400, `Escreva uma nota de até ${maxNoteLength} caracteres.`);
    }
    return text;
  }

  function parseScope(value) {
    if (value !== 'private' && value !== 'group') throw new HttpError(400, 'Visibilidade de nota inválida.');
    return value;
  }

  function parseMentions(value) {
    if (!Array.isArray(value)) throw new HttpError(400, 'Menções inválidas.');
    return [...new Set(value.map(normalizeId))].sort();
  }

  async function ownedMark(connection, bookId, markId, userId) {
    const book = await connection.get(`SELECT id FROM books WHERE id = ? AND owner_id = ?${storage.forUpdate}`, bookId, userId);
    if (!book) throw notFound();
    const mark = await connection.get(`
      SELECT h.id, h.created_at AS "createdAt", COALESCE(d.note, '') AS legacy_text, COALESCE(d.scope, 'private') AS scope
      FROM highlights AS h LEFT JOIN highlight_details AS d ON d.highlight_id = h.id
      WHERE h.id = ? AND h.book_id = ?${highlightLock}
    `, markId, bookId);
    if (!mark) throw notFound();
    return mark;
  }

  async function listNotes(bookId, markId, userId) {
    const rows = await storage.all(visibleNotesSql, markId, bookId, userId);
    if (!rows.length) throw notFound();
    const notes = new Map();
    for (const { mention_id, mention_name, ...item } of rows) {
      if (!item.id) continue;
      if (!notes.has(item.id)) notes.set(item.id, { ...item, mentions: [] });
      if (mention_id) notes.get(item.id).mentions.push({ id: mention_id, name: mention_name });
    }
    return { notes: [...notes.values()] };
  }

  function storedNote(connection, markId, noteId) {
    return connection.get(`SELECT ${noteFields} FROM highlight_notes WHERE id = ? AND highlight_id = ?`, noteId, markId);
  }

  async function storedMentions(connection, noteId) {
    const rows = await connection.all('SELECT user_id FROM highlight_note_mentions WHERE note_id = ?', noteId);
    return rows.map(row => row.user_id).sort();
  }

  async function replaceMentions(connection, noteId, ids) {
    await connection.run('DELETE FROM highlight_note_mentions WHERE note_id = ?', noteId);
    if (!ids.length) return;
    const placeholders = ids.map(() => '(?, ?)').join(', ');
    await connection.run(`INSERT INTO highlight_note_mentions (note_id, user_id) VALUES ${placeholders}`,
      ...ids.flatMap(id => [noteId, id]));
  }

  async function verifySharing(connection, bookId, mark, userId, scope, mentions) {
    if (scope === 'private') {
      if (mentions?.length) throw new HttpError(400, 'Menções estão disponíveis em notas de grupo.');
      return;
    }
    if (mark.scope !== 'group' || !await social.canShareHighlight(bookId, userId, connection)) {
      throw new HttpError(403, 'Compartilhe o destaque com um grupo ativo para adicionar uma nota de grupo.');
    }
    if (!mentions?.length) return;
    const active = new Set((await connection.all(activeMembersSql, bookId, userId)).map(member => member.id));
    if (mentions.some(id => !active.has(id))) {
      throw new HttpError(400, 'Mencione apenas pessoas que participam deste grupo.');
    }
  }

  async function renderNote(connection, note, ids, bookId, mark, userId) {
    let mentions = [];
    if (ids.length && note.scope === 'group' && mark.scope === 'group') {
      const selected = new Set(ids);
      mentions = (await connection.all(activeMembersSql, bookId, userId)).filter(person => selected.has(person.id));
    }
    return { ...note, mentions };
  }

  async function preserveLegacyNote(connection, highlightId) {
    const legacy = await connection.get(`
      SELECT h.created_at, d.note, d.scope FROM highlights AS h JOIN highlight_details AS d ON d.highlight_id = h.id
      WHERE h.id = ? AND d.note <> ''
    `, highlightId);
    if (!legacy) return;
    const inserted = await connection.run(`
      INSERT INTO highlight_notes (id, highlight_id, text, scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING
    `, highlightId, highlightId, legacy.note, legacy.scope, legacy.created_at, legacy.created_at);
    if (!inserted.changes && !await storedNote(connection, highlightId, highlightId)) throw conflict();
    await connection.run("UPDATE highlight_details SET note = '' WHERE highlight_id = ?", highlightId);
  }

  async function writeLegacyNote(connection, highlightId, text, scope) {
    const adopted = await storedNote(connection, highlightId, highlightId);
    if (!adopted) return false;
    if (!text) {
      await connection.run('DELETE FROM highlight_notes WHERE id = ? AND highlight_id = ?', highlightId, highlightId);
    } else {
      const visibility = scope ?? adopted.scope;
      await connection.run(`
        UPDATE highlight_notes SET text = ?, scope = ?, updated_at = ? WHERE id = ? AND highlight_id = ?
      `, text, visibility, new Date().toISOString(), highlightId, highlightId);
      if (visibility === 'private') await replaceMentions(connection, highlightId, []);
    }
    return true;
  }

  async function createNote(request, bookId, markId, userId) {
    const { id: clientId, text: inputText, scope: inputScope = 'private', mentions: inputMentions = [] } = await readJson(request);
    const id = clientId === undefined ? randomUUID() : normalizeId(clientId);
    const text = parseText(inputText);
    const scope = parseScope(inputScope);
    const mentions = parseMentions(inputMentions);
    return storage.transaction(async (connection) => {
      const mark = await ownedMark(connection, bookId, markId, userId);
      const previous = clientId ? await storedNote(connection, markId, id) : null;
      const virtual = id === markId && mark.legacy_text
        ? { id, text: mark.legacy_text, scope: mark.scope, createdAt: mark.createdAt, updatedAt: mark.createdAt }
        : null;
      const original = previous || virtual;
      if (original) {
        const ids = previous ? await storedMentions(connection, id) : [];
        if (original.text !== text || original.scope !== scope || JSON.stringify(ids) !== JSON.stringify(mentions)) throw conflict();
        return { note: await renderNote(connection, original, ids, bookId, mark, userId) };
      }
      if (clientId && id !== markId && await connection.get('SELECT id FROM highlights WHERE id = ?', id)) throw conflict();
      await verifySharing(connection, bookId, mark, userId, scope, mentions);
      const now = new Date().toISOString();
      const inserted = await connection.run(`
        INSERT INTO highlight_notes (id, highlight_id, text, scope, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING
      `, id, markId, text, scope, now, now);
      if (!inserted.changes) throw conflict();
      if (mentions.length) await replaceMentions(connection, id, mentions);
      return { note: await renderNote(connection, { id, text, scope, createdAt: now, updatedAt: now }, mentions, bookId, mark, userId) };
    });
  }

  async function updateNote(request, bookId, markId, noteId, userId) {
    const body = await readJson(request);
    const text = body.text === undefined ? undefined : parseText(body.text);
    const scope = body.scope === undefined ? undefined : parseScope(body.scope);
    const mentions = body.mentions === undefined ? undefined : parseMentions(body.mentions);
    if (text === undefined && scope === undefined && mentions === undefined) {
      throw new HttpError(400, 'Informe uma alteração para a nota.');
    }
    return storage.transaction(async (connection) => {
      const mark = await ownedMark(connection, bookId, markId, userId);
      if (noteId === markId && mark.legacy_text) await preserveLegacyNote(connection, markId);
      const old = await storedNote(connection, markId, noteId);
      if (!old) throw notFound();
      const visibility = scope ?? old.scope;
      await verifySharing(connection, bookId, mark, userId, visibility, mentions);
      const ids = mentions ?? (visibility === 'private' ? [] : await storedMentions(connection, noteId));
      const note = { ...old, text: text ?? old.text, scope: visibility, updatedAt: new Date().toISOString() };
      await connection.run(`
        UPDATE highlight_notes SET text = ?, scope = ?, updated_at = ? WHERE id = ? AND highlight_id = ?
      `, note.text, note.scope, note.updatedAt, noteId, markId);
      if (mentions !== undefined || visibility === 'private') await replaceMentions(connection, noteId, ids);
      return { note: await renderNote(connection, note, ids, bookId, mark, userId) };
    });
  }

  async function deleteNote(bookId, markId, noteId, userId) {
    await storage.transaction(async (connection) => {
      const mark = await ownedMark(connection, bookId, markId, userId);
      if (noteId === markId && mark.legacy_text) await preserveLegacyNote(connection, markId);
      const result = await connection.run('DELETE FROM highlight_notes WHERE id = ? AND highlight_id = ?', noteId, markId);
      if (!result.changes) throw notFound();
    });
    return { ok: true };
  }

  async function mentionsInbox(search, userId) {
    const value = search.get('offset') ?? '0';
    if (!/^\d{1,8}$/.test(value) || Number(value) > 10_000_000) throw new HttpError(400, 'Posição inválida.');
    const offset = Number(value);
    const rows = await storage.all(inboxSql, userId, mentionBatchSize + 1, offset);
    return {
      mentions: rows.slice(0, mentionBatchSize).map(({ author_id, author_name, ...note }) => ({
        ...note, author: { id: author_id, name: author_name },
      })),
      nextOffset: rows.length > mentionBatchSize ? offset + mentionBatchSize : null,
    };
  }

  async function handle(request, response, pathname, searchParams, user) {
    const { method } = request;
    if (pathname === '/api/reader/mentions' && method === 'GET') {
      respondJson(response, 200, await mentionsInbox(searchParams, user.id));
      return true;
    }
    const match = /^\/api\/books\/([^/]+)\/highlights\/([^/]+)\/notes(?:\/([^/]+))?$/.exec(pathname);
    if (!match) return false;
    const [bookId, markId, noteId] = match.slice(1).map(value => value === undefined ? undefined : normalizeId(value));
    if (!noteId && method === 'GET') respondJson(response, 200, await listNotes(bookId, markId, user.id));
    else if (!noteId && method === 'POST') respondJson(response, 201, await createNote(request, bookId, markId, user.id));
    else if (noteId && method === 'PATCH') respondJson(response, 200, await updateNote(request, bookId, markId, noteId, user.id));
    else if (noteId && method === 'DELETE') respondJson(response, 200, await deleteNote(bookId, markId, noteId, user.id));
    else return false;
    return true;
  }

  return { handle, preserveLegacyNote, writeLegacyNote };
}
