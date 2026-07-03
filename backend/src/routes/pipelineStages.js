const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

router.get('/', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM pipeline_stages ORDER BY sort_order, id').all());
});

router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const { key, label, color } = req.body;
  if (!key?.trim() || !label?.trim()) return res.status(400).json({ error: 'key y label requeridos' });
  const db = getDb();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM pipeline_stages').get().m;
  try {
    const r = db.prepare('INSERT INTO pipeline_stages (key, label, color, sort_order) VALUES (?, ?, ?, ?)').run(
      key.trim().toLowerCase().replace(/\s+/g, '_'), label.trim(), color || '#6b7280', maxOrder + 1
    );
    res.status(201).json(db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'La clave ya existe' });
    throw e;
  }
});

router.patch('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const { label, color, sort_order } = req.body;
  const fields = [], params = [];
  if (label !== undefined) { fields.push('label = ?'); params.push(label); }
  if (color !== undefined) { fields.push('color = ?'); params.push(color); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(parseInt(sort_order) || 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE pipeline_stages SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const stage = db.prepare('SELECT * FROM pipeline_stages WHERE id = ?').get(req.params.id);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const count = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE pipeline_stage = ?").get(stage.key).n;
  if (count > 0) return res.status(400).json({ error: `Hay ${count} contacto(s) en esta etapa. Muévelos antes de eliminar.` });
  db.prepare('DELETE FROM pipeline_stages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
