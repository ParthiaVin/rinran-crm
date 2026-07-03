const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAdmin, requireContactAccess } = require('../authz');

// GET /tags
router.get('/', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM tags ORDER BY name').all());
});

// POST /tags
router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, color = '#6366f1' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color);
    res.status(201).json(db.prepare('SELECT * FROM tags WHERE id = ?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Tag already exists' });
    throw e;
  }
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, color } = req.body;
  const fields = [], params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (color !== undefined) { fields.push('color = ?'); params.push(color); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /tags/contact/:contactId
router.get('/contact/:contactId', requireContactAccess('contactId'), (req, res) => {
  const tags = getDb().prepare(`
    SELECT t.* FROM tags t
    JOIN contact_tags ct ON ct.tag_id = t.id
    WHERE ct.contact_id = ?
    ORDER BY t.name
  `).all(req.params.contactId);
  res.json(tags);
});

// POST /tags/contact/:contactId — assign tag
router.post('/contact/:contactId', requireContactAccess('contactId'), (req, res) => {
  const { tag_id } = req.body;
  if (!tag_id) return res.status(400).json({ error: 'tag_id required' });
  try {
    getDb().prepare('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)').run(req.params.contactId, tag_id);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Invalid tag_id' }); }
});

// DELETE /tags/contact/:contactId/:tagId — remove tag
router.delete('/contact/:contactId/:tagId', requireContactAccess('contactId'), (req, res) => {
  getDb().prepare('DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?').run(req.params.contactId, req.params.tagId);
  res.json({ ok: true });
});

// GET /tags/contact/:contactId/custom-fields — get custom field values
router.get('/contact/:contactId/custom-fields', requireContactAccess('contactId'), (req, res) => {
  const values = getDb().prepare(`
    SELECT d.id as field_def_id, d.name, d.field_type, d.options_json, d.sort_order,
           v.value
    FROM custom_field_definitions d
    LEFT JOIN custom_field_values v ON v.field_def_id = d.id AND v.contact_id = ?
    ORDER BY d.sort_order, d.id
  `).all(req.params.contactId);
  res.json(values);
});

// PUT /tags/contact/:contactId/custom-fields — upsert custom field values
router.put('/contact/:contactId/custom-fields', requireContactAccess('contactId'), (req, res) => {
  const db = getDb();
  const { values } = req.body; // [{ field_def_id, value }]
  if (!Array.isArray(values)) return res.status(400).json({ error: 'values[] required' });
  for (const { field_def_id, value } of values) {
    if (value === '' || value === null || value === undefined) {
      db.prepare('DELETE FROM custom_field_values WHERE contact_id = ? AND field_def_id = ?').run(req.params.contactId, field_def_id);
    } else {
      db.prepare('INSERT OR REPLACE INTO custom_field_values (contact_id, field_def_id, value) VALUES (?, ?, ?)').run(req.params.contactId, field_def_id, String(value));
    }
  }
  res.json({ ok: true });
});

module.exports = router;
