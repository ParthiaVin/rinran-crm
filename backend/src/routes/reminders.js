const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// GET /reminders?contact_id=&done=
router.get('/', (req, res) => {
  const db = getDb();
  const { contact_id, done } = req.query;
  let where = ['1=1'];
  const params = [];
  if (req.user.role === 'agent') { where.push('r.user_id = ?'); params.push(req.user.id); }
  if (contact_id) { where.push('r.contact_id = ?'); params.push(contact_id); }
  if (done !== undefined) { where.push('r.done = ?'); params.push(done === '1' ? 1 : 0); }
  const reminders = db.prepare(`
    SELECT r.*, c.name as contact_name, c.phone as contact_phone, u.name as user_name
    FROM reminders r
    JOIN contacts c ON r.contact_id = c.id
    LEFT JOIN users u ON r.user_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY r.done ASC, r.due_at ASC
  `).all(...params);
  res.json(reminders);
});

// POST /reminders
router.post('/', (req, res) => {
  const db = getDb();
  const { contact_id, title, note, due_at, wa_message } = req.body;
  if (!contact_id || !title || !due_at) return res.status(400).json({ error: 'contact_id, title, due_at required' });
  const r = db.prepare('INSERT INTO reminders (contact_id, user_id, title, note, due_at, wa_message) VALUES (?, ?, ?, ?, ?, ?)').run(contact_id, req.user.id, title, note || null, due_at, wa_message || null);
  res.status(201).json(db.prepare(`
    SELECT r.*, c.name as contact_name, c.phone as contact_phone
    FROM reminders r JOIN contacts c ON r.contact_id = c.id WHERE r.id = ?
  `).get(r.lastInsertRowid));
});

// A reminder may only be modified by its owner or an admin.
function ownsReminder(req, res, next) {
  const row = getDb().prepare('SELECT user_id FROM reminders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
  next();
}

// PATCH /reminders/:id
router.patch('/:id', ownsReminder, (req, res) => {
  const db = getDb();
  const { done, title, note, due_at, wa_message } = req.body;
  const fields = [], params = [];
  if (done !== undefined) { fields.push('done = ?'); params.push(done ? 1 : 0); }
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (note !== undefined) { fields.push('note = ?'); params.push(note); }
  if (due_at !== undefined) {
    fields.push('due_at = ?'); params.push(due_at);
    // Reset notified_at so the scheduler fires again at the new time
    fields.push('notified_at = ?'); params.push(null);
  }
  if (wa_message !== undefined) { fields.push('wa_message = ?'); params.push(wa_message || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id));
});

// DELETE /reminders/:id
router.delete('/:id', ownsReminder, (req, res) => {
  getDb().prepare('DELETE FROM reminders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
