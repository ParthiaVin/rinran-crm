const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { parsePhone } = require('../phoneUtils');
const { getAllChats, getChatMessages, fromWaId, resolveLid, getContact, getProfilePic, getLabels, getLabelChats } = require('../whatsapp');
const { requireAdmin } = require('../authz');

const MEDIA_LABELS = {
  image: '[Foto]',
  video: '[Video]',
  audio: '[Audio]',
  voice: '[Audio]',
  ptt: '[Audio]',
  document: '[Archivo]',
  sticker: '[Sticker]',
};

const state = { running: false, lastSync: null, imported: { contacts: 0, messages: 0 }, error: null };

router.get('/', (req, res) => res.json(state));

router.post('/', requireAdmin, async (req, res) => {
  if (state.running) return res.json({ ok: false, message: 'Sync already in progress' });
  state.running = true;
  state.error = null;
  state.imported = { contacts: 0, messages: 0 };
  res.json({ ok: true, message: 'Sync started' });
  // Webhook is already configured via WAHA env vars; no need to reconfigure on every sync.
  runSync().catch(e => {
    state.error = e.message;
    state.running = false;
    console.error('[sync] Fatal:', e.message);
  });
});

// Resolve any chatId (including @lid) to a clean phone string like "+19296507660".
// Returns null for @lid contacts that cannot be resolved to a real number,
// so callers can skip them instead of creating contacts with unusable LID numbers.
async function resolvePhone(chatId) {
  if (chatId.endsWith('@lid')) {
    const real = await resolveLid(chatId);
    if (real) return real;
    // Fallback: try contacts API
    const info = await getContact(chatId);
    if (info?.number) return '+' + info.number;
    if (info?.id?.user) return '+' + info.id.user;
    return null; // unresolvable LID — skip this chat
  }
  return fromWaId(chatId);
}

async function syncLabels(db) {
  const SYSTEM_LABEL_IDS = new Set(['1', '2', '3']);

  // Try to upsert new labels from WAHA (optional — session may not have app state yet)
  const waLabels = await getLabels();
  if (waLabels.length) {
    for (const label of waLabels) {
      const labelId = String(label.id);
      if (SYSTEM_LABEL_IDS.has(labelId)) continue;
      const labelName = label.name.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
      const existing = db.prepare('SELECT id FROM categories WHERE wa_label_id = ?').get(labelId);
      if (!existing) {
        const byName = db.prepare('SELECT id FROM categories WHERE name = ?').get(labelName);
        if (byName) {
          db.prepare('UPDATE categories SET wa_label_id = ? WHERE id = ?').run(labelId, byName.id);
        } else {
          db.prepare('INSERT INTO categories (name, color, wa_label_id) VALUES (?, ?, ?)')
            .run(labelName, label.colorHex || '#6366f1', labelId);
        }
      } else {
        const existingFull = db.prepare('SELECT id, name FROM categories WHERE wa_label_id = ?').get(labelId);
        const cleanName = existingFull.name.replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
        if (cleanName !== existingFull.name) {
          db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(cleanName, existingFull.id);
        }
      }
    }
    console.log(`[sync] ${waLabels.length} WA labels upserted from WAHA`);
  } else {
    console.log('[sync] getLabels() returned [] (app state not synced yet) — using DB categories');
  }

  // Build phone → category id map using DB categories that have wa_label_id.
  // This works even when getLabels() is empty, as long as categories were imported before.
  const dbCategories = db.prepare('SELECT id, wa_label_id FROM categories WHERE wa_label_id IS NOT NULL').all();
  const phoneCategoryMap = {};

  for (const cat of dbCategories) {
    const labelChats = await getLabelChats(cat.wa_label_id);
    if (!labelChats.length) continue;
    for (const lc of labelChats) {
      const cid = lc.id || lc.chatId;
      if (!cid || cid.endsWith('@g.us') || cid.endsWith('@broadcast')) continue;
      let phoneKey = null;
      const phone = await resolvePhone(cid);
      if (phone) {
        phoneKey = parsePhone(phone).phone;
      } else if (cid.endsWith('@lid')) {
        const stored = db.prepare('SELECT phone FROM contacts WHERE wa_chat_id = ?').get(cid);
        if (stored) phoneKey = stored.phone;
      }
      if (phoneKey && !phoneCategoryMap[phoneKey]) {
        phoneCategoryMap[phoneKey] = cat.id;
      }
    }
  }
  console.log(`[sync] phoneCategoryMap: ${Object.keys(phoneCategoryMap).length} contacts with labels`);
  return phoneCategoryMap;
}

async function runSync() {
  const db = getDb();
  console.log('[sync] Starting WAHA history sync...');

  try {
    const phoneCategoryMap = await syncLabels(db);
    const chats = await getAllChats();
    const individual = chats.filter(c => !c.isGroup);
    console.log(`[sync] ${chats.length} total chats, ${individual.length} individual`);

    for (const chat of individual) {
      try {
        const chatId = chat.id;
        if (!chatId) continue;

        const phone = await resolvePhone(chatId);
        if (!phone) {
          // @lid that WAHA can't resolve — still apply category to any existing DB contact
          if (chatId.endsWith('@lid')) {
            const existing = db.prepare('SELECT id, phone, category_id FROM contacts WHERE wa_chat_id = ?').get(chatId);
            if (existing) {
              const waCategoryId = phoneCategoryMap[existing.phone];
              if (waCategoryId && existing.category_id !== waCategoryId) {
                db.prepare('UPDATE contacts SET category_id = ? WHERE id = ?').run(waCategoryId, existing.id);
                console.log(`[sync] LID contact ${existing.phone} → category ${waCategoryId}`);
              }
            }
          }
          continue;
        }
        const parsed = parsePhone(phone);

        // Prefer chat.name; fall back to pushName from contacts API; last resort: phone
        let name = chat.name || '';
        if (!name) {
          const info = await getContact(chatId);
          name = info?.pushname || info?.name || '';
        }
        if (!name) name = parsed.phone;

        // Look up contact by real phone first, then fall back to wa_chat_id
        // (catches existing contacts that were stored with LID-based phone numbers)
        let contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(parsed.phone);

        if (!contact) {
          contact = db.prepare('SELECT * FROM contacts WHERE wa_chat_id = ?').get(chatId);
          if (contact) {
            // Update stale LID-based phone to the real phone number
            db.prepare('UPDATE contacts SET phone = ?, country_code = ?, country_flag = ?, country_name = ? WHERE id = ?')
              .run(parsed.phone, parsed.country_code, parsed.country_flag, parsed.country_name, contact.id);
            contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
            console.log(`[sync] Updated LID contact → ${parsed.phone} (${name})`);
          }
        }

        if (!contact) {
          const r = db.prepare(`
            INSERT INTO contacts (name, phone, country_code, country_flag, country_name, source, wa_chat_id)
            VALUES (?, ?, ?, ?, ?, 'whatsapp', ?)
          `).run(name, parsed.phone, parsed.country_code, parsed.country_flag, parsed.country_name, chatId);
          contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
          state.imported.contacts++;
        } else {
          if (!contact.wa_chat_id) {
            db.prepare('UPDATE contacts SET wa_chat_id = ? WHERE id = ?').run(chatId, contact.id);
          }
          // Update name if it still looks like a phone number and we have a better one
          const nameIsPhone = /^\+[\d\s\(\)\-\.]+$/.test(contact.name.trim()) || contact.name.startsWith('WhatsApp ');
          const betterName = name !== parsed.phone ? name : null;
          if (nameIsPhone && betterName) {
            db.prepare("UPDATE contacts SET name = ?, updated_at = datetime('now') WHERE id = ?").run(betterName, contact.id);
            contact = { ...contact, name: betterName };
          }
        }

        // Sync WA label → CRM category (keyed by phone to handle @lid vs @s.whatsapp.net mismatch)
        const waCategoryId = phoneCategoryMap[parsed.phone];
        if (waCategoryId && contact.category_id !== waCategoryId) {
          db.prepare('UPDATE contacts SET category_id = ? WHERE id = ?').run(waCategoryId, contact.id);
          contact = { ...contact, category_id: waCategoryId };
          console.log(`[sync] ${parsed.phone} → category ${waCategoryId}`);
        }

        // Fetch profile picture (refresh on every sync so URLs don't expire)
        const picUrl = await getProfilePic(chatId);
        if (picUrl) {
          db.prepare('UPDATE contacts SET profile_pic_url = ? WHERE id = ?').run(picUrl, contact.id);
        }

        const messages = await getChatMessages(chatId);
        let saved = 0;

        for (const msg of messages) {
          let text = msg.body || msg.content || msg.text || '';

          if (!text.trim()) {
            if (!msg.hasMedia) continue;
            text = MEDIA_LABELS[msg.type] || '[Archivo]';
          }

          const waId = msg.waMessageId || msg.id?._serialized || msg.id;
          if (!waId) continue;

          const dup = db.prepare('SELECT id FROM messages WHERE wa_message_id = ?').get(waId);
          if (dup) continue;

          const direction = msg.fromMe ? 'outbound' : 'inbound';
          // History is already-seen: outbound → 'sent', inbound → 'read'.
          // Only genuinely new inbound messages (via the webhook) are 'received'/unread,
          // so a history sync must not inflate the inbox unread badge.
          const status = msg.fromMe ? 'sent' : 'read';
          const ts = msg.timestamp
            ? new Date(msg.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)
            : null;

          // For outbound messages, check if our broadcast already saved this message without a wa_message_id.
          // If so, update the existing row instead of inserting a duplicate (which would lack media_url).
          if (direction === 'outbound') {
            const existing = db.prepare(
              "SELECT id FROM messages WHERE contact_id = ? AND direction = 'outbound' AND content = ? AND wa_message_id IS NULL LIMIT 1"
            ).get(contact.id, text);
            if (existing) {
              db.prepare('UPDATE messages SET wa_message_id = ?, status = ? WHERE id = ?')
                .run(waId, 'sent', existing.id);
              state.imported.messages++;
              saved++;
              continue;
            }
          }

          db.prepare(`
            INSERT INTO messages (contact_id, direction, content, wa_message_id, status, sent_at)
            VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
          `).run(contact.id, direction, text, waId, status, ts);

          state.imported.messages++;
          saved++;
        }

        if (saved > 0) {
          console.log(`[sync] ${parsed.phone} (${name}): ${saved} messages`);
        }
      } catch (e) {
        console.error('[sync] Error on chat:', e.message);
      }
    }

    state.lastSync = new Date().toISOString();
    console.log(`[sync] Done — ${state.imported.contacts} contacts, ${state.imported.messages} messages`);
  } finally {
    state.running = false;
  }
}

// GET /sync/phonebook — import contacts from WAHA's contact list
router.get('/phonebook', requireAdmin, async (req, res) => {
  try {
    const { getSession } = require('../whatsapp');
    const axios = require('axios');
    const WAHA_URL = process.env.OPENWA_URL?.replace(/\/$/, '') || 'http://waha:3000';
    const WAHA_KEY = process.env.OPENWA_API_KEY || '';
    const session = await getSession();
    if (!session) return res.status(503).json({ error: 'No WAHA session active' });
    const r = await axios.get(`${WAHA_URL}/api/${session.name}/contacts`, {
      headers: { 'X-Api-Key': WAHA_KEY, Accept: 'application/json' },
      timeout: 30000,
    });
    const raw = Array.isArray(r.data) ? r.data : [];
    const db = getDb();
    let imported = 0, skipped = 0;
    for (const wc of raw) {
      const rawId = wc.id || wc.id?._serialized || '';
      if (!rawId || rawId.endsWith('@g.us') || rawId.endsWith('@broadcast')) continue;
      const phone = fromWaId(rawId);
      const name = wc.name || wc.pushname || wc.notify || `WhatsApp ${phone}`;
      const parsed = parsePhone(phone);
      try {
        db.prepare(`
          INSERT INTO contacts (name, phone, country_code, country_flag, country_name, source, wa_chat_id, wa_session)
          VALUES (?, ?, ?, ?, ?, 'whatsapp', ?, ?)
        `).run(name, parsed.phone, parsed.country_code, parsed.country_flag, parsed.country_name, rawId, session.name);
        imported++;
      } catch { skipped++; }
    }
    res.json({ imported, skipped, total: raw.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
