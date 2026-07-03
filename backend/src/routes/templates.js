const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAdmin } = require('../authz');

router.get('/', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM templates ORDER BY name').all());
});

router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'name and content required' });
  const r = db.prepare('INSERT INTO templates (name, content) VALUES (?, ?)').run(name, content);
  res.status(201).json(db.prepare('SELECT * FROM templates WHERE id = ?').get(r.lastInsertRowid));
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, content } = req.body;
  const fields = [], params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (content !== undefined) { fields.push('content = ?'); params.push(content); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE templates SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
