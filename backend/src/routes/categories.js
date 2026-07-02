const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { getLabels, getLabelChats } = require('../whatsapp');
const { requireAdmin } = require('../authz');

router.get('/', (req, res) => {
  const db = getDb();
  const categories = db.prepare(`
    SELECT cat.*, COUNT(c.id) as contact_count
    FROM categories cat
    LEFT JOIN contacts c ON c.category_id = cat.id
    GROUP BY cat.id ORDER BY cat.name
  `).all();
  res.json(categories);
});

// GET /categories/wa-labels — fetch WhatsApp labels for linking
router.get('/wa-labels', async (req, res) => {
  const labels = await getLabels();
  res.json(labels);
});

// POST /categories/sync-from-wa — pull WA labels → create/update CRM categories → assign to contacts
router.post('/sync-from-wa', requireAdmin, async (req, res) => {
  const db = getDb();
  const SYSTEM_LABEL_IDS = new Set(['1', '2', '3']);
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // Step 1: upsert WA labels as CRM categories
  const waLabels = await getLabels();
  let categoriesCreated = 0, categoriesLinked = 0;

  if (!waLabels.length) {
    return res.json({ ok: false, message: 'No se encontraron labels en WhatsApp. Verifica que la sesión esté activa.' });
  }

  for (const label of waLabels) {
    const labelId = String(label.id);
    if (SYSTEM_LABEL_IDS.has(labelId)) continue;
    const labelName = (label.name || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
    if (!labelName) continue;

    const existing = db.prepare('SELECT id FROM categories WHERE wa_label_id = ?').get(labelId);
    if (!existing) {
      const byName = db.prepare('SELECT id FROM categories WHERE name = ?').get(labelName);
      if (byName) {
        db.prepare('UPDATE categories SET wa_label_id = ? WHERE id = ?').run(labelId, byName.id);
        categoriesLinked++;
      } else {
        db.prepare('INSERT INTO categories (name, color, wa_label_id) VALUES (?, ?, ?)').run(labelName, label.colorHex || '#6366f1', labelId);
        categoriesCreated++;
      }
    }
  }
  console.log(`[categories] sync-from-wa: ${categoriesCreated} created, ${categoriesLinked} linked`);

  // Step 2: for each linked category, get its WA chats and update contacts' category_id
  const linkedCats = db.prepare('SELECT id, wa_label_id FROM categories WHERE wa_label_id IS NOT NULL').all();
  let contactsUpdated = 0;

  for (const cat of linkedCats) {
    try {
      await delay(300);
      const chats = await getLabelChats(cat.wa_label_id);
      for (const chat of chats) {
        const chatId = chat.id || chat.chatId;
        if (!chatId || chatId.endsWith('@g.us') || chatId.endsWith('@broadcast')) continue;

        // Find contact by wa_chat_id or phone
        let contact = db.prepare('SELECT id, category_id FROM contacts WHERE wa_chat_id = ?').get(chatId);
        if (!contact) {
          // strip @s.whatsapp.net or @c.us to get phone
          const phone = chatId.replace(/@.*$/, '').replace(/\D/g, '');
          if (phone) {
            contact = db.prepare("SELECT id, category_id FROM contacts WHERE phone LIKE ?").get(`%${phone}`);
          }
        }
        if (contact && contact.category_id !== cat.id) {
          db.prepare('UPDATE contacts SET category_id = ? WHERE id = ?').run(cat.id, contact.id);
          contactsUpdated++;
        }
      }
    } catch (e) {
      console.error(`[categories] sync-from-wa label ${cat.wa_label_id}:`, e.message);
    }
  }

  console.log(`[categories] sync-from-wa done: ${contactsUpdated} contacts updated`);
  res.json({
    ok: true,
    categoriesCreated,
    categoriesLinked,
    contactsUpdated,
    total: linkedCats.length,
  });
});

router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(name, color || '#6366f1');
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Category already exists' });
    throw e;
  }
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, color, wa_label_id } = req.body;
  const fields = [], params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (color !== undefined) { fields.push('color = ?'); params.push(color); }
  if (wa_label_id !== undefined) { fields.push('wa_label_id = ?'); params.push(wa_label_id || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
