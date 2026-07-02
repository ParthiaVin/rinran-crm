const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const { sendText, sendFile, sendVoice, sendLocation, sendSeen, sendTyping, downloadMedia, toWaId } = require('../whatsapp');
const { fireOutboundWebhooks } = require('../outboundWebhooks');
const { canActOnContact, isAgent } = require('../authz');

const uploadsDir = path.join(__dirname, '../../../data/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const BACKEND_INTERNAL = process.env.BACKEND_INTERNAL_URL || 'http://backend:4000';

function saveUpload(base64data, originalFilename) {
  const ext = path.extname(originalFilename) || '.bin';
  const base = path.basename(originalFilename, ext).replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const filename = `msg_${Date.now()}_${base}${ext}`;
  const buf = Buffer.from(base64data, 'base64');
  if (buf.length > 64 * 1024 * 1024) throw new Error('File too large (max 64MB)');
  fs.writeFileSync(path.join(uploadsDir, filename), buf);
  return filename;
}

// POST /messages/send — single text message with optional quote
router.post('/send', async (req, res) => {
  const db = getDb();
  const { contact_id, message, reply_to_id } = req.body;
  if (!contact_id || !message) return res.status(400).json({ error: 'contact_id and message required' });

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });

  const interpolate = txt => (txt || '').replace(/\{\{nombre\}\}/g, contact.name || contact.phone).replace(/\{\{telefono\}\}/g, contact.phone);
  const finalMessage = interpolate(message);

  // If replying, fetch the original WA message ID
  let quotedWaId = null;
  let replyContent = null;
  if (reply_to_id) {
    const orig = db.prepare('SELECT * FROM messages WHERE id = ?').get(reply_to_id);
    if (orig) { quotedWaId = orig.wa_message_id; replyContent = orig.content; }
  }

  let wa_message_id = null;
  let status = 'sent';

  try {
    const result = await sendText(contact.phone, finalMessage, contact.wa_chat_id, quotedWaId || undefined);
    wa_message_id = result?.id ?? result?.response?.id?._serialized ?? null;
  } catch (e) {
    status = 'failed';
    console.error('[messages] sendText error:', e.response?.data || e.message);
  }

  const row = db.prepare(`
    INSERT INTO messages (contact_id, direction, content, wa_message_id, status, reply_to_id, reply_to_content, reply_to_wa_id)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?)
  `).run(contact_id, finalMessage, wa_message_id, status, reply_to_id || null, replyContent || null, quotedWaId || null);

  // Auto-open conv_status when we send a message
  db.prepare("UPDATE contacts SET conv_status = 'open', updated_at = datetime('now') WHERE id = ? AND conv_status = 'closed'").run(contact_id);

  setImmediate(() => fireOutboundWebhooks(db, 'message.outbound', { contact: { id: contact.id, name: contact.name, phone: contact.phone }, message: finalMessage }));

  res.json({ id: row.lastInsertRowid, status, wa_message_id });
});

// POST /messages/send-file — single file message
router.post('/send-file', async (req, res) => {
  const db = getDb();
  const { contact_id, data, filename, mimetype, caption } = req.body;
  if (!contact_id || !data || !filename || !mimetype) {
    return res.status(400).json({ error: 'contact_id, data, filename, mimetype required' });
  }

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });

  let savedFilename;
  try {
    savedFilename = saveUpload(data, filename);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const localUrl = `/uploads/${savedFilename}`;
  const waUrl = `${BACKEND_INTERNAL}/uploads/${savedFilename}`;
  const content = caption || filename;
  const chatId = contact.wa_chat_id || toWaId(contact.phone);

  let wa_message_id = null;
  let status = 'sent';

  try {
    const result = await sendFile(chatId, { url: waUrl, filename, mimetype, caption });
    wa_message_id = result?.id ?? result?.response?.id?._serialized ?? null;
  } catch (e) {
    status = 'failed';
    console.error('[messages] sendFile error:', e.response?.data || e.message);
  }

  const row = db.prepare(`
    INSERT INTO messages (contact_id, direction, content, wa_message_id, status, media_url, media_type, media_filename)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?)
  `).run(contact_id, content, wa_message_id, status, localUrl, mimetype, filename);

  setImmediate(() => fireOutboundWebhooks(db, 'message.outbound', { contact: { id: contact.id, name: contact.name, phone: contact.phone }, message: content, media_url: localUrl, media_type: mimetype }));

  res.json({ id: row.lastInsertRowid, status, wa_message_id, media_url: localUrl });
});

// POST /messages/send-voice — record + send voice note
router.post('/send-voice', async (req, res) => {
  const db = getDb();
  const { contact_id, data, mimetype } = req.body;
  if (!contact_id || !data || !mimetype) return res.status(400).json({ error: 'contact_id, data, mimetype required' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });

  const fs2 = require('fs');
  const { execSync } = require('child_process');
  const ts = Date.now();

  // Save raw audio from browser
  const rawExt = mimetype.includes('ogg') ? '.ogg' : mimetype.includes('webm') ? '.webm' : mimetype.includes('mp4') ? '.m4a' : '.bin';
  const rawFile = path.join(uploadsDir, `voice_raw_${ts}${rawExt}`);
  fs2.writeFileSync(rawFile, Buffer.from(data, 'base64'));

  // Convert to OGG/Opus for WhatsApp compatibility (works on all platforms)
  const oggFile = path.join(uploadsDir, `voice_${ts}.ogg`);
  let finalFile = rawFile, finalMime = mimetype, finalExt = rawExt;
  try {
    execSync(`ffmpeg -y -i "${rawFile}" -c:a libopus -b:a 32k -ar 16000 -ac 1 "${oggFile}" 2>/dev/null`, { timeout: 20000 });
    fs2.unlinkSync(rawFile);
    finalFile = oggFile;
    finalMime = 'audio/ogg; codecs=opus';
    finalExt = '.ogg';
    console.log(`[voice] converted to OGG/Opus: ${path.basename(oggFile)}`);
  } catch (e) {
    // ffmpeg unavailable or failed — send raw file
    console.warn('[voice] ffmpeg conversion failed, sending raw:', e.message);
    if (fs2.existsSync(oggFile)) fs2.unlinkSync(oggFile);
  }

  const filename = path.basename(finalFile);
  const localUrl = `/uploads/${filename}`;
  const waUrl = `${BACKEND_INTERNAL}/uploads/${filename}`;
  const chatId = contact.wa_chat_id || toWaId(contact.phone);

  let wa_message_id = null, status = 'sent';
  try {
    const result = await sendVoice(chatId, { url: waUrl, filename, mimetype: finalMime });
    wa_message_id = result?.key?.id ?? result?.id ?? result?.response?.id?._serialized ?? null;
    console.log(`[voice] sent to ${chatId}, wa_id: ${wa_message_id}`);
  } catch (e) { status = 'failed'; console.error('[messages] sendVoice error:', e.response?.data || e.message); }

  const row = db.prepare(`INSERT INTO messages (contact_id, direction, content, wa_message_id, status, media_url, media_type, media_filename) VALUES (?, 'outbound', '[Audio]', ?, ?, ?, ?, ?)`)
    .run(contact_id, wa_message_id, status, localUrl, finalMime, filename);
  setImmediate(() => fireOutboundWebhooks(db, 'message.outbound', { contact: { id: contact.id, name: contact.name, phone: contact.phone }, message: '[Audio]', media_url: localUrl }));
  res.json({ id: row.lastInsertRowid, status, wa_message_id, media_url: localUrl });
});

// POST /messages/send-location — share GPS coordinates
router.post('/send-location', async (req, res) => {
  const db = getDb();
  const { contact_id, latitude, longitude, title } = req.body;
  if (!contact_id || latitude == null || longitude == null) return res.status(400).json({ error: 'contact_id, latitude, longitude required' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });

  const chatId = contact.wa_chat_id || toWaId(contact.phone);
  const label = title || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  let wa_message_id = null, status = 'sent';
  try {
    const result = await sendLocation(chatId, latitude, longitude, title || '');
    wa_message_id = result?.id ?? result?.response?.id?._serialized ?? null;
  } catch (e) { status = 'failed'; console.error('[messages] sendLocation error:', e.response?.data || e.message); }

  const row = db.prepare(`INSERT INTO messages (contact_id, direction, content, wa_message_id, status) VALUES (?, 'outbound', ?, ?, ?)`)
    .run(contact_id, `📍 ${label}`, wa_message_id, status);
  setImmediate(() => fireOutboundWebhooks(db, 'message.outbound', { contact: { id: contact.id, name: contact.name, phone: contact.phone }, message: `📍 ${label}` }));
  res.json({ id: row.lastInsertRowid, status, wa_message_id });
});

// POST /messages/send-seen — mark chat as read in WhatsApp
router.post('/send-seen', async (req, res) => {
  const db = getDb();
  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });
  try {
    await sendSeen(contact.phone, contact.wa_chat_id);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

// POST /messages/typing — send typing indicator
router.post('/typing', async (req, res) => {
  const db = getDb();
  const { contact_id, active } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });
  try {
    await sendTyping(contact.phone, contact.wa_chat_id, !!active);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

// POST /messages/broadcast — bulk send (immediate or scheduled)
router.post('/broadcast', async (req, res) => {
  const db = getDb();
  const { name, message, category_id, pipeline_stage, tag_id, file, scheduled_at } = req.body;
  if (!message && !file) return res.status(400).json({ error: 'message or file required' });

  let contactQuery = "SELECT c.* FROM contacts c WHERE c.status = 'active'";
  const contactParams = [];
  if (category_id) { contactQuery += ' AND c.category_id = ?'; contactParams.push(category_id); }
  if (pipeline_stage) { contactQuery += ' AND c.pipeline_stage = ?'; contactParams.push(pipeline_stage); }
  if (tag_id) { contactQuery += ' AND EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)'; contactParams.push(tag_id); }
  const contacts = db.prepare(contactQuery).all(...contactParams);

  let broadcastFileUrl = null, broadcastFilename = null, broadcastMimetype = null;
  if (file) {
    try {
      const saved = saveUpload(file.data, file.filename);
      broadcastFileUrl = `/uploads/${saved}`;
      broadcastFilename = file.filename;
      broadcastMimetype = file.mimetype;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const broadcastStatus = scheduled_at ? 'scheduled' : 'sending';
  const broadcastRow = db.prepare(`
    INSERT INTO broadcasts (name, message, category_id, pipeline_stage, tag_id, total_recipients, status, media_url, media_type, media_filename, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name || 'Broadcast', message || '', category_id || null, pipeline_stage || null, tag_id || null,
         contacts.length, broadcastStatus, broadcastFileUrl, broadcastMimetype, broadcastFilename, scheduled_at || null);
  const broadcastId = broadcastRow.lastInsertRowid;

  // Pre-create recipient rows
  for (const contact of contacts) {
    try {
      db.prepare('INSERT OR IGNORE INTO broadcast_recipients (broadcast_id, contact_id) VALUES (?, ?)').run(broadcastId, contact.id);
    } catch {}
  }

  res.json({ broadcast_id: broadcastId, total: contacts.length, scheduled: !!scheduled_at });

  if (scheduled_at) return; // Will be sent by scheduler

  await fireBroadcast(db, broadcastId);
});

// Exported for scheduler
async function fireBroadcast(db, broadcastId) {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId);
  if (!broadcast) return;

  let contactQuery = "SELECT c.* FROM contacts c WHERE c.status = 'active'";
  const contactParams = [];
  if (broadcast.category_id) { contactQuery += ' AND c.category_id = ?'; contactParams.push(broadcast.category_id); }
  if (broadcast.pipeline_stage) { contactQuery += ' AND c.pipeline_stage = ?'; contactParams.push(broadcast.pipeline_stage); }
  if (broadcast.tag_id) { contactQuery += ' AND EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)'; contactParams.push(broadcast.tag_id); }
  const contacts = db.prepare(contactQuery).all(...contactParams);

  db.prepare("UPDATE broadcasts SET status = 'sending' WHERE id = ?").run(broadcastId);

  let sent = 0, failed = 0;
  for (const contact of contacts) {
    try {
      const chatId = contact.wa_chat_id || toWaId(contact.phone);
      let wa_message_id = null;

      const interpolate = txt => (txt || '').replace(/\{\{nombre\}\}/g, contact.name || contact.phone);
      if (broadcast.media_url) {
        const waUrl = `${BACKEND_INTERNAL}${broadcast.media_url}`;
        const caption = interpolate(broadcast.message);
        const result = await sendFile(chatId, {
          url: waUrl, filename: broadcast.media_filename, mimetype: broadcast.media_type,
          caption: caption || undefined,
        });
        wa_message_id = result?.id ?? result?.response?.id?._serialized ?? null;
        db.prepare(`
          INSERT INTO messages (contact_id, direction, content, wa_message_id, status, media_url, media_type, media_filename)
          VALUES (?, 'outbound', ?, ?, 'sent', ?, ?, ?)
        `).run(contact.id, caption || broadcast.media_filename, wa_message_id, broadcast.media_url, broadcast.media_type, broadcast.media_filename);
      } else {
        const text = interpolate(broadcast.message);
        const result = await sendText(contact.phone, text, contact.wa_chat_id);
        wa_message_id = result?.id ?? result?.response?.id?._serialized ?? null;
        db.prepare('INSERT INTO messages (contact_id, direction, content, wa_message_id, status) VALUES (?, \'outbound\', ?, ?, \'sent\')').run(contact.id, text, wa_message_id);
      }

      db.prepare('UPDATE broadcast_recipients SET status = ?, wa_message_id = ?, sent_at = datetime(\'now\') WHERE broadcast_id = ? AND contact_id = ?')
        .run('sent', wa_message_id, broadcastId, contact.id);
      sent++;
    } catch {
      const content = broadcast.media_url ? (broadcast.message || broadcast.media_filename) : broadcast.message;
      db.prepare('INSERT INTO messages (contact_id, direction, content, status) VALUES (?, \'outbound\', ?, \'failed\')').run(contact.id, content);
      db.prepare('UPDATE broadcast_recipients SET status = ? WHERE broadcast_id = ? AND contact_id = ?').run('failed', broadcastId, contact.id);
      failed++;
    }
    db.prepare('UPDATE broadcasts SET sent_count = ?, failed_count = ? WHERE id = ?').run(sent, failed, broadcastId);
  }

  db.prepare("UPDATE broadcasts SET status = 'completed', sent_at = datetime('now') WHERE id = ?").run(broadcastId);
}

// POST /messages/:id/download-media
router.post('/:id/download-media', async (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const msgContact = db.prepare('SELECT assigned_to FROM contacts WHERE id = ?').get(msg.contact_id);
  if (!canActOnContact(req, msgContact)) return res.status(403).json({ error: 'No autorizado' });
  if (!msg.wa_message_id) return res.status(400).json({ error: 'No WhatsApp message ID' });
  if (msg.media_url) return res.json({ media_url: msg.media_url, media_type: msg.media_type });

  // Try to find media URL from webhook log payload.
  // Payloads may be truncated (invalid JSON), so use LIKE first then try full parse,
  // with a regex fallback to extract the URL from the raw string.
  let mediaUrl = null, mimetype = null, origFilename = null;
  try {
    const waId = msg.wa_message_id;
    const msgIdPart = waId.split('_').pop(); // e.g. 3AB38CB86EFA47D6F5F6
    const log = db.prepare(
      "SELECT payload FROM webhook_log WHERE payload LIKE ? ORDER BY id DESC LIMIT 1"
    ).get(`%${msgIdPart}%`);
    if (log) {
      try {
        const p = JSON.parse(log.payload);
        const m = (p?.payload || p?.data)?.media;
        if (m?.url) { mediaUrl = m.url.replace('http://localhost:3000', 'http://waha:3000'); mimetype = m.mimetype; origFilename = m.filename; }
      } catch {
        // Truncated JSON — extract url with regex
        const urlMatch = log.payload.match(/"url"\s*:\s*"(http:\/\/[^"]+)"/);
        const mimeMatch = log.payload.match(/"mimetype"\s*:\s*"([^"]+)"/);
        if (urlMatch) { mediaUrl = urlMatch[1].replace('http://localhost:3000', 'http://waha:3000'); }
        if (mimeMatch) { mimetype = mimeMatch[1]; }
      }
    }
  } catch {}

  let result = null;
  if (mediaUrl) {
    try {
      const wahaHeaders = {};
      if (process.env.OPENWA_API_KEY) wahaHeaders['X-Api-Key'] = process.env.OPENWA_API_KEY;
      const resp = await require('axios').get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000, headers: wahaHeaders });
      result = { data: Buffer.from(resp.data), contentType: mimetype || resp.headers['content-type'] || 'application/octet-stream' };
    } catch {}
  }
  if (!result) result = await downloadMedia(msg.wa_message_id);
  if (!result) return res.status(404).json({ error: 'Media not available' });

  const ext = (result.contentType.split('/')[1] || 'bin').split(';')[0];
  const safeName = origFilename ? origFilename.replace(/[^a-zA-Z0-9._-]/g, '_') : '';
  const filename = `media_${msg.id}${safeName ? '_' + safeName : '.' + ext}`;
  const localUrl = `/uploads/${filename}`;
  fs.writeFileSync(path.join(uploadsDir, filename), result.data);

  db.prepare('UPDATE messages SET media_url = ?, media_type = ?, media_filename = ? WHERE id = ?')
    .run(localUrl, result.contentType, origFilename || filename, msg.id);

  res.json({ media_url: localUrl, media_type: result.contentType });
});

// GET /messages/broadcasts
router.get('/broadcasts', (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  let extra = '';
  const params = [];
  if (from) { extra += ' AND date(b.created_at) >= ?'; params.push(from); }
  if (to)   { extra += ' AND date(b.created_at) <= ?'; params.push(to); }
  const broadcasts = db.prepare(`
    SELECT b.*, cat.name as category_name,
      (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND status = 'delivered') as delivered_count,
      (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND status = 'read') as read_count
    FROM broadcasts b
    LEFT JOIN categories cat ON b.category_id = cat.id
    WHERE 1=1 ${extra}
    ORDER BY b.created_at DESC LIMIT 100
  `).all(...params);
  res.json(broadcasts);
});

// PATCH /messages/broadcasts/:id — cancel or reschedule
router.patch('/broadcasts/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const b = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status !== 'scheduled') return res.status(400).json({ error: 'Solo broadcasts programados pueden modificarse' });
  const { status, scheduled_at } = req.body;
  if (status === 'cancelled') {
    db.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  } else if (scheduled_at) {
    db.prepare('UPDATE broadcasts SET scheduled_at = ? WHERE id = ?').run(scheduled_at, req.params.id);
  }
  res.json(db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id));
});

// GET /messages/broadcasts/:id/recipients
router.get('/broadcasts/:id/recipients', (req, res) => {
  const db = getDb();
  const recipients = db.prepare(`
    SELECT br.*, c.name, c.phone FROM broadcast_recipients br
    JOIN contacts c ON br.contact_id = c.id
    WHERE br.broadcast_id = ?
    ORDER BY br.id
  `).all(req.params.id);
  res.json(recipients);
});

// GET /messages/search — global search across messages
router.get('/search', (req, res) => {
  const db = getDb();
  const { q } = req.query;
  if (!q?.trim()) return res.json([]);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 30)); // clamp: non-numeric would bind NaN (500)

  // Agents may only search within conversations assigned to them.
  const scope = isAgent(req) ? 'AND c.assigned_to = ?' : '';
  const params = isAgent(req) ? [`%${q}%`, req.user.id, limit] : [`%${q}%`, limit];
  const results = db.prepare(`
    SELECT m.id, m.contact_id, m.direction, m.content, m.sent_at, m.media_type,
           c.name as contact_name, c.phone as contact_phone
    FROM messages m
    JOIN contacts c ON m.contact_id = c.id
    WHERE m.content LIKE ? ${scope}
    ORDER BY m.sent_at DESC
    LIMIT ?
  `).all(...params);

  res.json(results);
});

// POST /messages/quick-send — send to any phone without needing a saved contact
router.post('/quick-send', async (req, res) => {
  const db = getDb();
  const { phone, message, session_name } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  const { parsePhone } = require('../phoneUtils');
  const { toWaId } = require('../whatsapp');
  const parsed = parsePhone(phone);
  const chatId = toWaId(parsed.phone);
  let status = 'sent', wa_message_id = null;
  try {
    const result = await sendText(parsed.phone, message, chatId, undefined, session_name);
    wa_message_id = result?.id ?? result?.response?.id?._serialized ?? null;
  } catch (e) {
    status = 'failed';
    console.error('[messages] quick-send error:', e.response?.data || e.message);
  }
  res.json({ ok: true, phone: parsed.phone, status, wa_message_id });
});

module.exports = { router, fireBroadcast };
