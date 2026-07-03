const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { parsePhone } = require('../phoneUtils');
const { getChatLabels, setChatLabels, toWaId } = require('../whatsapp');

function logActivity(db, contactId, userId, action, detail) {
  try {
    db.prepare('INSERT INTO activity_log (contact_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(contactId, userId || null, action, detail || null);
  } catch {}
}

// Authorization: agents may only act on contacts assigned to them; admins act on all.
// `contactRow` must include `assigned_to`. Read/list paths already scope agents this way,
// but the by-id and bulk mutation/delete paths did not — allowing any agent to modify or
// permanently delete contacts (and cascade-wipe messages/notes/reminders/etc.) they don't own.
function canActOn(req, contactRow) {
  return req.user.role !== 'agent' || contactRow.assigned_to === req.user.id;
}

// GET /contacts
router.get('/', (req, res) => {
  const db = getDb();
  const { category_id, status, search, pipeline_stage, assigned_to, conv_status } = req.query;
  // Sanitize pagination: non-numeric / zero / negative values would otherwise
  // produce NaN (SQLite "datatype mismatch" 500) or a negative offset.
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  let where = ['c.is_deleted != 1'];
  const params = [];

  // Agents only see their assigned contacts
  if (req.user.role === 'agent') {
    where.push('c.assigned_to = ?');
    params.push(req.user.id);
  } else if (assigned_to) {
    where.push('c.assigned_to = ?');
    params.push(assigned_to);
  }

  if (category_id) { where.push('c.category_id = ?'); params.push(category_id); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (pipeline_stage) { where.push('c.pipeline_stage = ?'); params.push(pipeline_stage); }
  if (conv_status) { where.push('c.conv_status = ?'); params.push(conv_status); }
  if (search) {
    where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.notes LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as n FROM contacts c WHERE ${whereClause}`).get(...params).n;
  const contacts = db.prepare(`
    SELECT c.*, cat.name as category_name, cat.color as category_color,
           u.name as assigned_name,
           (SELECT GROUP_CONCAT(t.name || ':' || t.color || ':' || t.id, '|')
            FROM contact_tags ct JOIN tags t ON ct.tag_id = t.id
            WHERE ct.contact_id = c.id) as tags_raw
    FROM contacts c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY c.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const parsed = contacts.map(c => ({
    ...c,
    tags: c.tags_raw ? c.tags_raw.split('|').map(t => { const [name, color, id] = t.split(':'); return { id: parseInt(id), name, color }; }) : [],
    tags_raw: undefined,
  }));

  res.json({ contacts: parsed, total, page, limit });
});

// GET /contacts/export — CSV export
router.get('/export', (req, res) => {
  const db = getDb();
  const { category_id, status, search, pipeline_stage, conv_status, tag_id } = req.query;
  let where = ['c.is_deleted != 1'];
  const params = [];
  if (req.user.role === 'agent') { where.push('c.assigned_to = ?'); params.push(req.user.id); }
  if (category_id) { where.push('c.category_id = ?'); params.push(category_id); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (pipeline_stage) { where.push('c.pipeline_stage = ?'); params.push(pipeline_stage); }
  if (conv_status) { where.push('c.conv_status = ?'); params.push(conv_status); }
  if (search) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  let joinTag = '';
  if (tag_id) {
    joinTag = 'JOIN contact_tags ct ON ct.contact_id = c.id AND ct.tag_id = ?';
    params.unshift(tag_id);
  }

  const contacts = db.prepare(`
    SELECT c.name, c.phone, c.country_name, cat.name as category, c.pipeline_stage,
           c.conv_status, c.notes, c.status, c.source, c.created_at
    FROM contacts c LEFT JOIN categories cat ON c.category_id = cat.id
    ${joinTag}
    WHERE ${where.join(' AND ')}
    ORDER BY c.name
  `).all(...params);

  const header = 'nombre,telefono,pais,categoria,pipeline,estado_conv,notas,estado,fuente,creado_en';
  const esc = v => `"${(v || '').toString().replace(/"/g, '""')}"`;
  const rows = contacts.map(c =>
    [c.name, c.phone, c.country_name, c.category, c.pipeline_stage, c.conv_status, c.notes, c.status, c.source, c.created_at]
      .map(esc).join(',')
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contactos.csv"');
  res.send('﻿' + [header, ...rows].join('\r\n'));
});

// GET /contacts/duplicates — find potential duplicate contacts
router.get('/duplicates', (req, res) => {
  const db = getDb();
  // Find contacts with the same name (case-insensitive, trimmed)
  const dupes = db.prepare(`
    SELECT c1.id as id1, c1.name as name1, c1.phone as phone1, c1.source as source1,
           c2.id as id2, c2.name as name2, c2.phone as phone2, c2.source as source2
    FROM contacts c1
    JOIN contacts c2 ON c1.id < c2.id
      AND (LOWER(TRIM(c1.name)) = LOWER(TRIM(c2.name))
        OR REPLACE(REPLACE(REPLACE(c1.phone, '+', ''), '-', ''), ' ', '') = REPLACE(REPLACE(REPLACE(c2.phone, '+', ''), '-', ''), ' ', ''))
    LIMIT 50
  `).all();
  res.json(dupes);
});

// POST /contacts/merge — merge two contacts (keep keepId, delete mergeId)
router.post('/merge', (req, res) => {
  const db = getDb();
  const { keep_id, merge_id } = req.body;
  // Compare by value, not strict ===, so {keep_id:1, merge_id:"1"} (same row) is rejected
  // instead of deleting the "kept" contact.
  if (!keep_id || !merge_id || String(keep_id) === String(merge_id)) {
    return res.status(400).json({ error: 'keep_id and merge_id required and must differ' });
  }
  const keep = db.prepare('SELECT * FROM contacts WHERE id = ?').get(keep_id);
  const merge = db.prepare('SELECT * FROM contacts WHERE id = ?').get(merge_id);
  if (!keep || !merge) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOn(req, keep) || !canActOn(req, merge)) return res.status(403).json({ error: 'No autorizado' });

  // Run the multi-step merge atomically — a mid-way failure must not leave orphaned rows.
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE messages SET contact_id = ? WHERE contact_id = ?').run(keep_id, merge_id);
    db.prepare('UPDATE activity_log SET contact_id = ? WHERE contact_id = ?').run(keep_id, merge_id);
    if (!keep.wa_chat_id && merge.wa_chat_id) {
      db.prepare('UPDATE contacts SET wa_chat_id = ?, wa_session = ? WHERE id = ?').run(merge.wa_chat_id, merge.wa_session, keep_id);
    }
    db.prepare('DELETE FROM contacts WHERE id = ?').run(merge_id);
    logActivity(db, keep_id, req.user.id, 'merged', `Fusionado con ${merge.name} (${merge.phone})`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[contacts] merge error:', e.message);
    return res.status(500).json({ error: 'No se pudo fusionar' });
  }
  res.json({ ok: true, kept: keep_id, deleted: merge_id });
});

// POST /contacts/bulk — bulk actions on multiple contacts
router.post('/bulk', (req, res) => {
  const db = getDb();
  const { ids, action, value } = req.body;
  if (!Array.isArray(ids) || !ids.length || !action) return res.status(400).json({ error: 'ids[] and action required' });

  const placeholders = ids.map(() => '?').join(',');
  const ts = `datetime('now')`;
  // Agents may only affect contacts assigned to them; admins affect all.
  const ownClause = req.user.role === 'agent' ? ' AND assigned_to = ?' : '';
  const ownArg = req.user.role === 'agent' ? [req.user.id] : [];

  let info;
  if (action === 'assign_category') {
    info = db.prepare(`UPDATE contacts SET category_id = ?, updated_at = ${ts} WHERE id IN (${placeholders})${ownClause}`).run(value || null, ...ids, ...ownArg);
  } else if (action === 'assign_agent') {
    info = db.prepare(`UPDATE contacts SET assigned_to = ?, updated_at = ${ts} WHERE id IN (${placeholders})${ownClause}`).run(value || null, ...ids, ...ownArg);
  } else if (action === 'set_pipeline') {
    info = db.prepare(`UPDATE contacts SET pipeline_stage = ?, updated_at = ${ts} WHERE id IN (${placeholders})${ownClause}`).run(value ?? null, ...ids, ...ownArg);
  } else if (action === 'set_conv_status') {
    info = db.prepare(`UPDATE contacts SET conv_status = ?, updated_at = ${ts} WHERE id IN (${placeholders})${ownClause}`).run(value ?? null, ...ids, ...ownArg);
  } else if (action === 'delete') {
    info = db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})${ownClause}`).run(...ids, ...ownArg);
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  ids.forEach(cid => logActivity(db, cid, req.user.id, `bulk_${action}`, value));
  res.json({ ok: true, affected: info.changes });
});

// GET /contacts/:id/export-chat — download conversation as TXT
router.get('/:id/export-chat', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT name, phone, assigned_to FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  if (!canActOn(req, contact)) return res.status(403).json({ error: 'No autorizado' });
  const messages = db.prepare('SELECT direction, content, sent_at FROM messages WHERE contact_id = ? ORDER BY sent_at ASC').all(req.params.id);
  const lines = [`Conversación con ${contact.name} (${contact.phone})`, `Exportado: ${new Date().toLocaleString('es')}`, '='.repeat(60), ''];
  for (const m of messages) {
    const ts = new Date(m.sent_at.replace(' ', 'T') + 'Z').toLocaleString('es');
    const who = m.direction === 'inbound' ? contact.name : 'Yo';
    lines.push(`[${ts}] ${who}: ${m.content}`);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="chat_${contact.phone}.txt"`);
  res.send(lines.join('\n'));
});

// GET /contacts/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const contact = db.prepare(`
    SELECT c.*, cat.name as category_name, cat.color as category_color,
           u.name as assigned_name
    FROM contacts c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOn(req, contact)) return res.status(403).json({ error: 'No autorizado' });

  const messages = db.prepare(
    'SELECT * FROM messages WHERE contact_id = ? ORDER BY sent_at DESC LIMIT 200'
  ).all(req.params.id);

  const activity = db.prepare(`
    SELECT a.*, u.name as user_name FROM activity_log a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.contact_id = ? ORDER BY a.created_at DESC LIMIT 50
  `).all(req.params.id);

  const tags = db.prepare(`
    SELECT t.* FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? ORDER BY t.name
  `).all(req.params.id);

  const customFields = db.prepare(`
    SELECT d.id as field_def_id, d.name, d.field_type, d.options_json, d.sort_order, v.value
    FROM custom_field_definitions d
    LEFT JOIN custom_field_values v ON v.field_def_id = d.id AND v.contact_id = ?
    ORDER BY d.sort_order, d.id
  `).all(req.params.id);

  const broadcasts = db.prepare(`
    SELECT b.id, b.name, b.message, b.created_at, br.status as recipient_status, br.sent_at as recipient_sent_at
    FROM broadcast_recipients br
    JOIN broadcasts b ON br.broadcast_id = b.id
    WHERE br.contact_id = ?
    ORDER BY b.created_at DESC
    LIMIT 20
  `).all(req.params.id);

  res.json({ ...contact, messages, activity, tags, customFields, broadcasts });
});

// POST /contacts
router.post('/', (req, res) => {
  const db = getDb();
  const { name, phone, category_id, notes, source } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const parsed = parsePhone(phone);
  try {
    const result = db.prepare(`
      INSERT INTO contacts (name, phone, country_code, country_flag, country_name, category_id, notes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, parsed.phone, parsed.country_code, parsed.country_flag, parsed.country_name,
           category_id || null, notes || null, source || 'manual');
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
    logActivity(db, contact.id, req.user.id, 'created', `Manual — ${parsed.phone}`);
    res.status(201).json(contact);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Phone already exists' });
    throw e;
  }
});

// POST /contacts/import — CSV import
router.post('/import', (req, res) => {
  const db = getDb();
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv required' });

  const lines = csv.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'CSV needs header row + at least one data row' });

  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/["\s﻿]/g, ''));
  const nameIdx = header.findIndex(h => ['nombre','name'].includes(h));
  const phoneIdx = header.findIndex(h => ['telefono','phone','tel'].includes(h));
  if (nameIdx < 0 || phoneIdx < 0) {
    return res.status(400).json({ error: 'CSV must have "nombre" and "telefono" columns' });
  }
  const notesIdx = header.findIndex(h => ['notas','notes'].includes(h));
  const catIdx = header.findIndex(h => ['categoria','category'].includes(h));
  const stageIdx = header.findIndex(h => ['pipeline'].includes(h));

  let imported = 0, skipped = 0, errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = cols[nameIdx]?.trim();
    const phone = cols[phoneIdx]?.trim();
    if (!name || !phone) { skipped++; continue; }

    let category_id = null;
    if (catIdx >= 0 && cols[catIdx]) {
      const cat = db.prepare('SELECT id FROM categories WHERE name LIKE ?').get(`%${cols[catIdx].trim()}%`);
      if (cat) category_id = cat.id;
    }

    const pipeline_stage = stageIdx >= 0 && cols[stageIdx] ? cols[stageIdx].trim() : 'nuevo';

    try {
      const parsed = parsePhone(phone);
      const r = db.prepare(`
        INSERT INTO contacts (name, phone, country_code, country_flag, country_name, category_id, notes, source, pipeline_stage)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'csv', ?)
      `).run(name, parsed.phone, parsed.country_code, parsed.country_flag, parsed.country_name,
             category_id, notesIdx >= 0 ? (cols[notesIdx] || null) : null, pipeline_stage);
      imported++;
    } catch (e) {
      if (e.message.includes('UNIQUE')) skipped++;
      else errors.push(`Fila ${i + 1}: ${e.message}`);
    }
  }

  res.json({ imported, skipped, errors: errors.slice(0, 10) });
});

function parseCsvLine(line) {
  const cols = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      cols.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  cols.push(cur);
  return cols;
}

// PATCH /contacts/:id
router.patch('/:id', (req, res) => {
  const db = getDb();
  const { name, category_id, notes, status, pipeline_stage, assigned_to, conv_status } = req.body;
  const fields = [], params = [];

  const old = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  if (!canActOn(req, old)) return res.status(403).json({ error: 'No autorizado' });

  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (category_id !== undefined) { fields.push('category_id = ?'); params.push(category_id || null); }
  if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (pipeline_stage !== undefined) { fields.push('pipeline_stage = ?'); params.push(pipeline_stage); }
  if (assigned_to !== undefined) { fields.push('assigned_to = ?'); params.push(assigned_to || null); }
  if (conv_status !== undefined) { fields.push('conv_status = ?'); params.push(conv_status); }

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare(`
    SELECT c.*, cat.name as category_name, cat.color as category_color, u.name as assigned_name
    FROM contacts c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ?
  `).get(req.params.id);
  res.json(updated);

  // Activity log
  if (pipeline_stage !== undefined && pipeline_stage !== old.pipeline_stage) {
    logActivity(db, old.id, req.user.id, 'stage_changed', `${old.pipeline_stage} → ${pipeline_stage}`);
  }
  if (assigned_to !== undefined && assigned_to !== old.assigned_to) {
    const agent = assigned_to ? db.prepare('SELECT name FROM users WHERE id = ?').get(assigned_to) : null;
    logActivity(db, old.id, req.user.id, 'assigned', agent ? `Asignado a ${agent.name}` : 'Sin asignar');
  }
  if (category_id !== undefined && category_id !== old.category_id) {
    const cat = category_id ? db.prepare('SELECT name FROM categories WHERE id = ?').get(category_id) : null;
    logActivity(db, old.id, req.user.id, 'category_changed', cat ? `Categoría: ${cat.name}` : 'Sin categoría');
  }
  if (conv_status !== undefined && conv_status !== old.conv_status) {
    logActivity(db, old.id, req.user.id, 'conv_status_changed', conv_status);
  }

  // Apply assignment rule when category changes and contact has no agent
  if (category_id !== undefined && category_id && !old.assigned_to && !('assigned_to' in req.body)) {
    setImmediate(() => {
      try {
        const rule = db.prepare("SELECT * FROM assignment_rules WHERE is_active = 1 AND category_id = ? ORDER BY sort_order, id LIMIT 1").get(category_id);
        if (rule) {
          db.prepare("UPDATE contacts SET assigned_to = ? WHERE id = ?").run(rule.agent_id, old.id);
          logActivity(db, old.id, null, 'assigned', `Auto-asignado por regla de categoría`);
        }
      } catch {}
    });
  }

  // Push category change to WhatsApp labels (fire-and-forget)
  if ('category_id' in req.body && (updated.wa_chat_id || updated.phone)) {
    setImmediate(async () => {
      try {
          // Use wa_chat_id directly (including @lid — WAHA labels API accepts it).
        // Fall back to phone@c.us only when wa_chat_id is missing entirely.
        let chatId = updated.wa_chat_id || toWaId(updated.phone);
        const allWaLinked = db.prepare('SELECT wa_label_id FROM categories WHERE wa_label_id IS NOT NULL').all()
          .map(r => r.wa_label_id);
        const currentLabels = await getChatLabels(chatId);
        const keepLabels = currentLabels
          .filter(l => !allWaLinked.includes(String(l.id)))
          .map(l => String(l.id));
        if (req.body.category_id) {
          const cat = db.prepare('SELECT wa_label_id FROM categories WHERE id = ?').get(req.body.category_id);
          if (cat?.wa_label_id) keepLabels.push(cat.wa_label_id);
        }
        await setChatLabels(chatId, keepLabels);
        console.log(`[contacts] WA label sync → ${chatId}: [${keepLabels.join(',')}]`);
      } catch (e) {
        console.error('[contacts] WA label sync error:', e.message);
      }
    });
  }
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT assigned_to FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  if (!canActOn(req, contact)) return res.status(403).json({ error: 'No autorizado' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
