const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAdmin } = require('../authz');

router.get('/', (req, res) => {
  const { category } = req.query;
  const db = getDb();
  const where = category ? 'WHERE category = ?' : '';
  const params = category ? [category] : [];
  res.json(db.prepare(`SELECT * FROM scripts ${where} ORDER BY category, sort_order, id`).all(...params));
});

router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { category, title, emoji, content, sort_order } = req.body;
  if (!category || !title) return res.status(400).json({ error: 'category, title required' });
  const r = db.prepare('INSERT INTO scripts (category, title, emoji, content, sort_order) VALUES (?, ?, ?, ?, ?)').run(category, title, emoji || '', content || '', sort_order ?? 99);
  res.status(201).json(db.prepare('SELECT * FROM scripts WHERE id = ?').get(r.lastInsertRowid));
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { title, emoji, content, sort_order } = req.body;
  const fields = [], params = [];
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (emoji !== undefined) { fields.push('emoji = ?'); params.push(emoji); }
  if (content !== undefined) { fields.push('content = ?'); params.push(content); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(sort_order); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE scripts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
