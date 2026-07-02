const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../db');
const { requireContactAccess } = require('../authz');

// Every notes route is scoped to a contact — enforce the caller may access that contact.
router.use(requireContactAccess('contactId'));

// GET /contacts/:contactId/notes
router.get('/', (req, res) => {
  const notes = getDb().prepare(`
    SELECT n.*, u.name as user_name FROM internal_notes n
    LEFT JOIN users u ON n.user_id = u.id
    WHERE n.contact_id = ? ORDER BY n.created_at DESC
  `).all(req.params.contactId);
  res.json(notes);
});

// POST /contacts/:contactId/notes
router.post('/', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content required' });
  const db = getDb();
  const r = db.prepare('INSERT INTO internal_notes (contact_id, user_id, content) VALUES (?, ?, ?)').run(req.params.contactId, req.user.id, content.trim());
  const note = db.prepare(`SELECT n.*, u.name as user_name FROM internal_notes n LEFT JOIN users u ON n.user_id = u.id WHERE n.id = ?`).get(r.lastInsertRowid);
  res.status(201).json(note);
});

// DELETE /contacts/:contactId/notes/:id
router.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM internal_notes WHERE id = ? AND contact_id = ?').run(req.params.id, req.params.contactId);
  res.json({ ok: true });
});

module.exports = router;
