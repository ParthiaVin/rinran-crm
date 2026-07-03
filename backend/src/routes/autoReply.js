const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { requireAdmin } = require('../authz');

const uploadsDir = path.join(__dirname, '../../../data/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function saveAttachment(base64data, filename) {
  const buf = Buffer.from(base64data, 'base64');
  const safe = `autoreply_${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  fs.writeFileSync(path.join(uploadsDir, safe), buf);
  return `/uploads/${safe}`;
}

function deleteAttachment(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  try { fs.unlinkSync(path.join(uploadsDir, path.basename(url))); } catch {}
}

router.get('/', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM auto_reply_rules ORDER BY id').all());
});

router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, trigger_type, trigger_value, response, file } = req.body;
  if (!name || !trigger_type) return res.status(400).json({ error: 'name, trigger_type required' });
  if (!response && !file) return res.status(400).json({ error: 'response or file required' });

  let attachment_url = null, attachment_filename = null, attachment_mimetype = null;
  if (file?.data && file?.filename && file?.mimetype) {
    attachment_url = saveAttachment(file.data, file.filename);
    attachment_filename = file.filename;
    attachment_mimetype = file.mimetype;
  }

  const r = db.prepare(
    'INSERT INTO auto_reply_rules (name, trigger_type, trigger_value, response, attachment_url, attachment_filename, attachment_mimetype) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, trigger_type, trigger_value || null, response || '', attachment_url, attachment_filename, attachment_mimetype);
  res.status(201).json(db.prepare('SELECT * FROM auto_reply_rules WHERE id = ?').get(r.lastInsertRowid));
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, trigger_type, trigger_value, response, is_active, file, remove_attachment } = req.body;
  const fields = [], params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (trigger_type !== undefined) { fields.push('trigger_type = ?'); params.push(trigger_type); }
  if (trigger_value !== undefined) { fields.push('trigger_value = ?'); params.push(trigger_value); }
  if (response !== undefined) { fields.push('response = ?'); params.push(response); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active ? 1 : 0); }

  if (remove_attachment) {
    const existing = db.prepare('SELECT attachment_url FROM auto_reply_rules WHERE id = ?').get(req.params.id);
    deleteAttachment(existing?.attachment_url);
    fields.push('attachment_url = ?'); params.push(null);
    fields.push('attachment_filename = ?'); params.push(null);
    fields.push('attachment_mimetype = ?'); params.push(null);
  } else if (file?.data && file?.filename && file?.mimetype) {
    const existing = db.prepare('SELECT attachment_url FROM auto_reply_rules WHERE id = ?').get(req.params.id);
    deleteAttachment(existing?.attachment_url);
    const attachment_url = saveAttachment(file.data, file.filename);
    fields.push('attachment_url = ?'); params.push(attachment_url);
    fields.push('attachment_filename = ?'); params.push(file.filename);
    fields.push('attachment_mimetype = ?'); params.push(file.mimetype);
  }

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE auto_reply_rules SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM auto_reply_rules WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT attachment_url FROM auto_reply_rules WHERE id = ?').get(req.params.id);
  deleteAttachment(rule?.attachment_url);
  db.prepare('DELETE FROM auto_reply_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
