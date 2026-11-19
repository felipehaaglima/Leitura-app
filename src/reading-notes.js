export function localHighlightNotes(mark) {
  if (!mark) throw new Error('Destaque não encontrado.')
  const notes = mark.notes ?? []
  if (!mark.note || notes.some(note => note.id === mark.id)) return notes
  return [{
    id: mark.id, text: mark.note, scope: 'private', mentions: [],
    createdAt: mark.createdAt, updatedAt: mark.createdAt,
  }, ...notes]
}

export function writeLocalNote(mark, id, data) {
  const notes = localHighlightNotes(mark)
  const existing = id && notes.find(note => note.id === id)
  if (id && !existing) throw new Error('Nota não encontrada.')
  const text = String(data.text ?? existing?.text ?? '').trim()
  if (!text || text.length > 2000) throw new Error('Escreva uma nota de até 2.000 caracteres.')
  const now = new Date().toISOString()
  const note = {
    id: id || crypto.randomUUID(),
    text,
    scope: 'private',
    mentions: [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return { note, changes: { note: '', notes: id ? notes.map(item => item.id === id ? note : item) : [...notes, note] } }
}

export function deleteLocalNote(mark, id) {
  return { note: '', notes: localHighlightNotes(mark).filter(note => note.id !== id) }
}
