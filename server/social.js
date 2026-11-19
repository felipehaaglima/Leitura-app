import { randomUUID } from 'node:crypto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileBatchSize = 24;
const groupBatchSize = 40;
const circleBooksSql = `
  SELECT id, owner_id FROM books WHERE id = ?
  UNION ALL
  SELECT b.id, b.owner_id FROM book_origins AS o JOIN books AS b ON b.id = o.book_id WHERE o.circle_id = ?
`;
const circleExistsSql = `
  (
    EXISTS (SELECT 1 FROM books AS peer WHERE peer.id = g.circle_id AND peer.owner_id <> m.user_id)
    OR EXISTS (
      SELECT 1 FROM book_origins AS o JOIN books AS peer ON peer.id = o.book_id
      WHERE o.circle_id = g.circle_id AND peer.owner_id <> m.user_id
    )
  )
`;

export function createSocialAPI({ storage, readJson, respondJson, HttpError }) {
  const bookLock = storage.postgres ? ' FOR KEY SHARE OF b' : '';
  const unavailable = () => new HttpError(404, 'Este recurso não está disponível.');
  const groupUnavailable = () => new HttpError(409, 'O grupo precisa de duas pessoas com o mesmo livro.');

  function getId(value) {
    if (typeof value !== 'string' || !uuidPattern.test(value)) {
      throw new HttpError(400, 'Identificador inválido.');
    }
    return value.toLowerCase();
  }

  function numberParam(value, limit) {
    if (!/^\d{1,8}$/.test(value) || Number(value) > limit) {
      throw new HttpError(400, 'Posição inválida.');
    }
    return Number(value);
  }

  async function getDecision(request) {
    const { accept } = await readJson(request);
    if (typeof accept !== 'boolean') throw new HttpError(400, 'Informe se você aceita o pedido.');
    return accept;
  }

  function friendship(connection, first, second) {
    const [left, right] = [first, second].sort();
    return connection.get(`
      SELECT id, requested_by, status FROM social_friendships WHERE left_user_id = ? AND right_user_id = ?
    `, left, right);
  }

  async function requireFriend(connection, first, second) {
    if ((await friendship(connection, first, second))?.status !== 'accepted') throw unavailable();
  }

  function bookInfo(connection, bookId, lock = false) {
    return connection.get(`
      SELECT b.id, b.owner_id, COALESCE(o.circle_id, b.id) AS circle_id
      FROM books AS b LEFT JOIN book_origins AS o ON o.book_id = b.id
      WHERE b.id = ?${lock ? bookLock : ''}
    `, bookId);
  }

  async function ownBook(connection, bookId, userId, lock = false) {
    const book = await bookInfo(connection, bookId, lock);
    if (book?.owner_id !== userId) throw unavailable();
    return book;
  }

  async function lockCircle(connection, circleId) {
    if (storage.postgres) await connection.get('SELECT pg_advisory_xact_lock(794223039, hashtext(?))', circleId);
  }

  function ownedCopy(connection, circleId, userId) {
    return connection.get(`SELECT id FROM (${circleBooksSql}) AS copies WHERE owner_id = ? ORDER BY id LIMIT 1`,
      circleId, circleId, userId);
  }

  function anotherCopy(connection, circleId, userId) {
    return connection.get(`SELECT id FROM (${circleBooksSql}) AS copies WHERE owner_id <> ? LIMIT 1`,
      circleId, circleId, userId);
  }

  async function copySummary(connection, bookId) {
    const row = await connection.get(`
      SELECT id, title, page_count AS "pageCount", current_page AS "currentPage", current_block, current_offset
      FROM books WHERE id = ?
    `, bookId);
    if (!row) return undefined;
    const { current_block, current_offset, ...book } = row;
    return { ...book, anchor: { block: current_block, offset: current_offset } };
  }

  async function readSocial(user) {
    const [friendRows, shareRows, invites] = await Promise.all([
      storage.all(`
        SELECT f.id, f.requested_by, f.status, u.id AS user_id, u.name
        FROM social_friendships AS f JOIN users AS u
          ON u.id = CASE WHEN f.left_user_id = ? THEN f.right_user_id ELSE f.left_user_id END
        WHERE f.left_user_id = ? OR f.right_user_id = ? ORDER BY u.name, u.id
      `, user.id, user.id, user.id),
      storage.all(`
        SELECT s.id, s.owner_id, u.id AS user_id, u.name, b.id AS book_id, b.title
        FROM social_share_requests AS s JOIN books AS b ON b.id = s.book_id
        JOIN users AS u ON u.id = CASE WHEN s.owner_id = ? THEN s.requester_id ELSE s.owner_id END
        WHERE (s.owner_id = ? OR s.requester_id = ?) AND s.status = 'pending'
        ORDER BY b.title, s.id
      `, user.id, user.id, user.id),
      storage.all(`
        SELECT g.id, b.id AS "bookId", b.title, u.id AS inviter_id, u.name AS inviter_name
        FROM reading_group_members AS m JOIN reading_groups AS g ON g.id = m.group_id
        JOIN books AS b ON b.id = m.book_id JOIN users AS u ON u.id = m.invited_by
        WHERE m.user_id = ? AND m.status = 'invited' AND ${circleExistsSql}
        ORDER BY b.title, g.id
      `, user.id),
    ]);
    return {
      friends: friendRows.filter(row => row.status === 'accepted').map(row => ({ id: row.user_id, name: row.name })),
      friendRequests: friendRows.filter(row => row.status === 'pending').map(row => ({
        id: row.id, incoming: row.requested_by !== user.id, user: { id: row.user_id, name: row.name },
      })),
      shareRequests: shareRows.map(row => ({
        id: row.id, incoming: row.owner_id === user.id, user: { id: row.user_id, name: row.name },
        book: { id: row.book_id, title: row.title },
      })),
      groupInvites: invites.map(({ inviter_id, inviter_name, ...invite }) => ({
        ...invite, invitedBy: { id: inviter_id, name: inviter_name },
      })),
    };
  }

  async function requestFriend(request, user) {
    const target = getId((await readJson(request)).id);
    if (target === user.id) throw new HttpError(400, 'Use o código de outra pessoa.');
    return storage.transaction(async (connection) => {
      if (!await connection.get('SELECT id FROM users WHERE id = ?', target)) throw unavailable();
      const [left, right] = [user.id, target].sort();
      await connection.run(`
        INSERT INTO social_friendships (id, left_user_id, right_user_id, requested_by, status)
        VALUES (?, ?, ?, ?, 'pending') ON CONFLICT (left_user_id, right_user_id) DO NOTHING
      `, randomUUID(), left, right, user.id);
      return { id: (await friendship(connection, user.id, target)).id };
    });
  }

  async function decideFriend(request, id, user) {
    const accept = await getDecision(request);
    await storage.transaction(async (connection) => {
      const row = await connection.get(`
        SELECT requested_by, status FROM social_friendships
        WHERE id = ? AND (left_user_id = ? OR right_user_id = ?)${storage.forUpdate}
      `, id, user.id, user.id);
      if (!row) throw unavailable();
      if (accept && row.requested_by === user.id) throw new HttpError(403, 'A outra pessoa precisa aceitar este pedido.');
      if (row.status === 'accepted') {
        if (!accept) throw new HttpError(409, 'Este pedido já foi aceito.');
        return;
      }
      if (accept) await connection.run("UPDATE social_friendships SET status = 'accepted' WHERE id = ?", id);
      else await connection.run('DELETE FROM social_friendships WHERE id = ?', id);
    });
    return { ok: true };
  }

  async function readProfile(id, search, user) {
    await requireFriend(storage, user.id, id);
    const offset = numberParam(search.get('offset') ?? '0', 10_000_000);
    const person = await storage.get('SELECT id, name FROM users WHERE id = ?', id);
    if (!person) throw unavailable();
    const rows = await storage.all(`
      SELECT b.id, b.title, b.page_count AS "pageCount", b.current_page AS "currentPage",
             recommender.id AS from_id, recommender.name AS from_name,
             CASE WHEN EXISTS (
               SELECT 1 FROM books AS own LEFT JOIN book_origins AS oo ON oo.book_id = own.id
               WHERE own.owner_id = ? AND COALESCE(oo.circle_id, own.id) = COALESCE(o.circle_id, b.id)
             ) THEN 'copied' WHEN EXISTS (
               SELECT 1 FROM social_share_requests AS s
               WHERE s.book_id = b.id AND s.requester_id = ? AND s.status = 'pending'
             ) THEN 'requested' ELSE 'available' END AS "shareStatus"
      FROM books AS b LEFT JOIN book_origins AS o ON o.book_id = b.id
      LEFT JOIN users AS recommender ON recommender.id = o.from_user_id
      WHERE b.owner_id = ? ORDER BY b.updated_at DESC, b.id LIMIT ? OFFSET ?
    `, user.id, user.id, id, profileBatchSize + 1, offset);
    return {
      user: person,
      books: rows.slice(0, profileBatchSize).map(({ from_id, from_name, ...book }) => ({
        ...book, recommendedBy: from_id ? { id: from_id, name: from_name } : null,
      })),
      nextOffset: rows.length > profileBatchSize ? offset + profileBatchSize : null,
    };
  }

  async function requestShare(request, user) {
    const bookId = getId((await readJson(request)).bookId);
    return storage.transaction(async (connection) => {
      const source = await bookInfo(connection, bookId);
      if (!source || source.owner_id === user.id) throw unavailable();
      await requireFriend(connection, user.id, source.owner_id);
      await lockCircle(connection, source.circle_id);
      await ownBook(connection, bookId, source.owner_id, true);
      const previous = await connection.get(`
        SELECT id, status, copy_id FROM social_share_requests WHERE book_id = ? AND requester_id = ?
      `, bookId, user.id);
      if (previous && (previous.status === 'pending' || previous.copy_id)) return { id: previous.id };
      if (await ownedCopy(connection, source.circle_id, user.id)) {
        throw new HttpError(409, 'Você já tem uma cópia deste livro.');
      }
      if (previous) await connection.run('DELETE FROM social_share_requests WHERE id = ?', previous.id);
      const id = randomUUID();
      await connection.run(`
        INSERT INTO social_share_requests (id, book_id, owner_id, requester_id, status) VALUES (?, ?, ?, ?, 'pending')
      `, id, bookId, source.owner_id, user.id);
      return { id };
    });
  }

  async function inviteMember(connection, groupId, member, invitedBy) {
    await connection.run(`
      INSERT INTO reading_group_members (group_id, user_id, book_id, invited_by, status)
      VALUES (?, ?, ?, ?, 'invited') ON CONFLICT (group_id, user_id) DO NOTHING
    `, groupId, member.owner_id, member.id, invitedBy);
  }

  async function decideShare(request, id, user) {
    const accept = await getDecision(request);
    return storage.transaction(async (connection) => {
      const lookup = 'FROM social_share_requests WHERE id = ? AND (owner_id = ? OR requester_id = ?)';
      const initial = await connection.get(`SELECT book_id ${lookup}`, id, user.id, user.id);
      if (!initial) throw unavailable();
      const source = await bookInfo(connection, initial.book_id);
      if (!source) throw unavailable();
      await lockCircle(connection, source.circle_id);
      await ownBook(connection, source.id, source.owner_id, true);
      const row = await connection.get(`SELECT owner_id, requester_id, status, copy_id ${lookup}${storage.forUpdate}`,
        id, user.id, user.id);
      if (!row) throw unavailable();
      if (accept && row.owner_id !== user.id) throw new HttpError(403, 'A outra pessoa precisa aceitar este pedido.');
      if (row.status === 'accepted') {
        if (!accept) throw new HttpError(409, 'Este pedido já foi aceito.');
        const book = row.copy_id ? await copySummary(connection, row.copy_id) : undefined;
        if (!book) throw unavailable();
        return { book };
      }
      if (!accept) {
        await connection.run('DELETE FROM social_share_requests WHERE id = ?', id);
        return { ok: true };
      }

      await requireFriend(connection, row.requester_id, source.owner_id);
      const previous = await ownedCopy(connection, source.circle_id, row.requester_id);
      const retained = previous && await bookInfo(connection, previous.id, true);
      let copyId = retained?.id;
      if (!copyId) {
        copyId = randomUUID();
        const now = new Date().toISOString();
        await connection.run(`
          INSERT INTO books (id, owner_id, title, thumbnail, pages_json, page_count, created_at, updated_at)
          SELECT ?, ?, title, thumbnail, pages_json, page_count, ?, ? FROM books WHERE id = ? AND owner_id = ?
        `, copyId, row.requester_id, now, now, source.id, source.owner_id);
        await connection.run('INSERT INTO book_origins (book_id, circle_id, from_user_id) VALUES (?, ?, ?)',
          copyId, source.circle_id, user.id);
        const group = await connection.get('SELECT id FROM reading_groups WHERE circle_id = ?', source.circle_id);
        if (group) await inviteMember(connection, group.id, { owner_id: row.requester_id, id: copyId }, user.id);
      }
      await connection.run("UPDATE social_share_requests SET status = 'accepted', copy_id = ? WHERE id = ?", copyId, id);
      return { book: await copySummary(connection, copyId) };
    });
  }

  async function canShareHighlight(bookId, userId, connection = storage) {
    return Boolean(await connection.get(`
      SELECT m.group_id FROM reading_group_members AS m JOIN reading_groups AS g ON g.id = m.group_id
      JOIN books AS b ON b.id = m.book_id
      WHERE m.book_id = ? AND m.user_id = ? AND b.owner_id = m.user_id AND m.status = 'active' AND ${circleExistsSql}
    `, bookId, userId));
  }

  async function readGroup(bookId, search, user) {
    const book = await ownBook(storage, bookId, user.id);
    const page = numberParam(search.get('page') ?? '0', 1_999);
    const offset = numberParam(search.get('offset') ?? '0', 10_000_000);
    const empty = { members: [], highlights: [], nextOffset: null };
    if (!await anotherCopy(storage, book.circle_id, user.id)) return { status: 'unavailable', ...empty };
    const group = await storage.get(`
      SELECT g.id, m.status FROM reading_groups AS g LEFT JOIN reading_group_members AS m
        ON m.group_id = g.id AND m.user_id = ? AND m.book_id = ?
      WHERE g.circle_id = ?
    `, user.id, bookId, book.circle_id);
    if (group?.status === 'invited') return { status: 'invited', id: group.id, ...empty };
    if (group?.status !== 'active') return { status: 'none', ...empty };

    const membership = `
      EXISTS (SELECT 1 FROM reading_group_members AS own
              WHERE own.group_id = m.group_id AND own.user_id = ? AND own.book_id = ? AND own.status = 'active')
    `;
    const [members, highlights] = await Promise.all([
      storage.all(`
        SELECT u.id, u.name, b.current_page AS "currentPage", b.current_block, b.current_offset
        FROM reading_group_members AS m JOIN users AS u ON u.id = m.user_id JOIN books AS b ON b.id = m.book_id
        WHERE m.group_id = ? AND m.status = 'active' AND ${membership} ORDER BY u.name, u.id
      `, group.id, user.id, bookId),
      storage.all(`
        SELECT h.id, h.page, h.block, h."start", h."end", h.text, h.color, d.note,
               u.id AS author_id, u.name AS author_name
        FROM reading_group_members AS m JOIN users AS u ON u.id = m.user_id
        JOIN highlights AS h ON h.book_id = m.book_id JOIN highlight_details AS d ON d.highlight_id = h.id
        WHERE m.group_id = ? AND m.status = 'active' AND h.page = ? AND d.scope = 'group' AND ${membership}
        ORDER BY h.block, h."start", h.id LIMIT ? OFFSET ?
      `, group.id, page, user.id, bookId, groupBatchSize + 1, offset),
    ]);
    return {
      status: 'active', id: group.id,
      members: members.map(({ current_block, current_offset, ...member }) => ({
        ...member, anchor: { block: current_block, offset: current_offset },
      })),
      highlights: highlights.slice(0, groupBatchSize).map(({ author_id, author_name, ...highlight }) => ({
        ...highlight, author: { id: author_id, name: author_name },
      })),
      nextOffset: highlights.length > groupBatchSize ? offset + groupBatchSize : null,
    };
  }

  async function startGroup(bookId, user) {
    return storage.transaction(async (connection) => {
      const book = await ownBook(connection, bookId, user.id);
      await lockCircle(connection, book.circle_id);
      await ownBook(connection, bookId, user.id, true);
      const peers = await connection.all(`
        SELECT b.id, b.owner_id FROM books AS b
        WHERE b.owner_id <> ? AND (b.id = ? OR b.id IN (SELECT book_id FROM book_origins WHERE circle_id = ?))
        ORDER BY b.id${bookLock}
      `, user.id, book.circle_id, book.circle_id);
      if (!peers.length) throw groupUnavailable();
      let group = await connection.get('SELECT id FROM reading_groups WHERE circle_id = ?', book.circle_id);
      if (!group) {
        group = { id: randomUUID() };
        await connection.run('INSERT INTO reading_groups (id, circle_id, created_by) VALUES (?, ?, ?)',
          group.id, book.circle_id, user.id);
      }
      await connection.run(`
        INSERT INTO reading_group_members (group_id, user_id, book_id, invited_by, status)
        VALUES (?, ?, ?, NULL, 'active') ON CONFLICT (group_id, user_id)
        DO UPDATE SET status = 'active', book_id = excluded.book_id
      `, group.id, user.id, bookId);
      for (const peer of peers) await inviteMember(connection, group.id, peer, user.id);
      return { ok: true, id: group.id };
    });
  }

  async function decideGroup(request, groupId, user) {
    const accept = await getDecision(request);
    await storage.transaction(async (connection) => {
      const initial = await connection.get('SELECT book_id FROM reading_group_members WHERE group_id = ? AND user_id = ?',
        groupId, user.id);
      if (!initial) throw unavailable();
      const book = await ownBook(connection, initial.book_id, user.id);
      await lockCircle(connection, book.circle_id);
      await ownBook(connection, book.id, user.id, true);
      const member = await connection.get(`
        SELECT status FROM reading_group_members WHERE group_id = ? AND user_id = ? AND book_id = ?${storage.forUpdate}
      `, groupId, user.id, book.id);
      if (!member) throw unavailable();
      if (accept) {
        if (!['invited', 'active'].includes(member.status)) throw unavailable();
        if (!await anotherCopy(connection, book.circle_id, user.id)) throw groupUnavailable();
        await connection.run("UPDATE reading_group_members SET status = 'active' WHERE group_id = ? AND user_id = ?", groupId, user.id);
      } else if (['invited', 'active'].includes(member.status)) {
        const status = member.status === 'active' ? 'left' : 'declined';
        await connection.run('UPDATE reading_group_members SET status = ? WHERE group_id = ? AND user_id = ?',
          status, groupId, user.id);
      }
    });
    return { ok: true };
  }

  async function handle(request, response, pathname, searchParams, user) {
    const { method } = request;
    let result;
    if (pathname === '/api/social' && method === 'GET') result = await readSocial(user);
    else if (pathname === '/api/social/friends' && method === 'POST') result = await requestFriend(request, user);
    else if (pathname === '/api/social/shares' && method === 'POST') result = await requestShare(request, user);
    else {
      const match = /^\/api\/social\/(friends|shares|users|books|groups)\/([^/]+)(\/group)?$/.exec(pathname);
      if (!match) return false;
      const [, resource, value, groupSuffix] = match;
      if (resource === 'books' && groupSuffix && method === 'GET') result = await readGroup(getId(value), searchParams, user);
      else if (resource === 'books' && groupSuffix && method === 'POST') result = await startGroup(getId(value), user);
      else if (groupSuffix) return false;
      else if (resource === 'users' && method === 'GET') result = await readProfile(getId(value), searchParams, user);
      else if (resource === 'friends' && method === 'PATCH') result = await decideFriend(request, getId(value), user);
      else if (resource === 'shares' && method === 'PATCH') result = await decideShare(request, getId(value), user);
      else if (resource === 'groups' && method === 'PATCH') result = await decideGroup(request, getId(value), user);
      else return false;
    }
    respondJson(response, 200, result);
    return true;
  }

  return { handle, canShareHighlight };
}
