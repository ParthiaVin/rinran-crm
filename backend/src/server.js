require('dotenv').config();

// --- Security: never sign/verify JWTs with a known, committed secret. ---
// If JWT_SECRET is missing or a well-known default, generate a strong random
// secret for this process and warn loudly instead of trusting a public constant.
{
  const crypto = require('crypto');
  const WEAK = new Set(['rinran-secret-change-me', 'cambia-esto-por-un-secreto-seguro', 'changeme', 'secret', '']);
  if (!process.env.JWT_SECRET || WEAK.has(process.env.JWT_SECRET.trim())) {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('[SECURITY] JWT_SECRET is unset or a known default — generated a random secret for THIS run only.');
    console.warn('[SECURITY] Existing sessions will be invalid after a restart. Set a strong JWT_SECRET (e.g. `openssl rand -hex 32`).');
  }
}

const express = require('express');
// Patches Express so rejected promises from `async` route handlers are forwarded to the
// error-handling middleware instead of hanging the request forever (Express 4 limitation).
// Must be required before any routers/route modules are created.
require('express-async-errors');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
const auth = require('./middleware/auth');

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(morgan('dev'));

// --- Body-size limits: a huge base64 body must not be buffered on public/normal routes ---
// (the old global 1400mb limit let an anonymous client OOM the server with one request).
// Tight for auth (tiny payloads); bounded-but-generous for the WhatsApp webhook (may inline
// media); large only on authenticated media-upload routes (auth runs BEFORE the big parser).
app.use('/api/auth', express.json({ limit: '64kb' }));
// Capture the raw body for the webhook so its HMAC signature can be verified below.
app.use('/webhook', express.json({ limit: '60mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(
  ['/api/messages/send-file', '/api/messages/send-voice', '/api/messages/broadcast', '/api/auto-reply'],
  auth,
  express.json({ limit: '110mb' })
);
app.use(express.json({ limit: '12mb' }));

// Verify the WAHA webhook's HMAC signature so the public /webhook route isn't anonymous.
// Enforced only when WEBHOOK_HMAC_SECRET is set (and WAHA is configured with the same key);
// otherwise the route stays open but a one-time warning is logged.
const WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || '';
let _webhookOpenWarned = false;
function verifyWebhookHmac(req, res, next) {
  if (!WEBHOOK_HMAC_SECRET) {
    if (!_webhookOpenWarned) {
      _webhookOpenWarned = true;
      console.warn('[SECURITY] WEBHOOK_HMAC_SECRET is not set — the public /webhook route is UNAUTHENTICATED.');
      console.warn('[SECURITY] Set WEBHOOK_HMAC_SECRET and configure WAHA webhook hmac.key with the same value.');
    }
    return next();
  }
  const provided = req.get('X-Webhook-Hmac');
  const algo = (req.get('X-Webhook-Hmac-Algorithm') || 'sha512').toLowerCase();
  if (!provided || !req.rawBody) return res.status(401).json({ error: 'invalid signature' });
  let expected;
  try { expected = crypto.createHmac(algo, WEBHOOK_HMAC_SECRET).update(req.rawBody).digest('hex'); }
  catch { return res.status(401).json({ error: 'invalid signature' }); }
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  next();
}

// Public routes
app.use('/api/auth', require('./routes/auth'));
app.use('/webhook', verifyWebhookHmac, require('./routes/webhook'));
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

const { getDb } = require('./db');
const axios = require('axios');

// Photo proxy
app.get('/api/contacts/:id/photo', async (req, res) => {
  try {
    const contact = getDb().prepare('SELECT profile_pic_url FROM contacts WHERE id = ?').get(req.params.id);
    if (!contact?.profile_pic_url) return res.status(404).end();
    if (contact.profile_pic_url.startsWith('/uploads/')) return res.redirect(contact.profile_pic_url);
    const imgRes = await axios.get(contact.profile_pic_url, { responseType: 'stream', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    imgRes.data.pipe(res);
  } catch { res.status(404).end(); }
});

app.post('/api/contacts/:id/photo', auth, (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'image required' });
  const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'invalid image format' });
  const ext = match[1].split('/')[1].replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'image too large (max 5MB)' });
  const filename = `contact_${req.params.id}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  const url = `/uploads/${filename}`;
  getDb().prepare("UPDATE contacts SET profile_pic_url = ?, updated_at = datetime('now') WHERE id = ?").run(url, req.params.id);
  res.json({ url });
});

// Protected routes
const { router: messagesRouter, fireBroadcast } = require('./routes/messages');
app.use('/api/sync',          auth, require('./routes/sync'));
app.use('/api/contacts',      auth, require('./routes/contacts'));
app.use('/api/categories',    auth, require('./routes/categories'));
app.use('/api/messages',      auth, messagesRouter);
app.use('/api/stats',         auth, require('./routes/stats'));
app.use('/api/inbox',         auth, require('./routes/inbox'));
app.use('/api/status',        auth, require('./routes/status'));
app.use('/api/templates',     auth, require('./routes/templates'));
app.use('/api/team',          auth, require('./routes/users'));
app.use('/api/auto-reply',    auth, require('./routes/autoReply'));
app.use('/api/saved-filters', auth, require('./routes/savedFilters'));
app.use('/api/settings',      auth, require('./routes/settings'));
app.use('/api/tags',          auth, require('./routes/tags'));
app.use('/api/contacts/:contactId/notes', auth, require('./routes/internalNotes'));
app.use('/api/reminders',     auth, require('./routes/reminders'));
app.use('/api/scripts',         auth, require('./routes/scripts'));
app.use('/api/webhook-log',     auth, require('./routes/webhookLog'));
app.use('/api/pipeline-stages', auth, require('./routes/pipelineStages'));

const { router: pushRouter, pushToUser, pushToAll } = require('./routes/push');
app.use('/api/push',          auth, pushRouter);

// SSE — real-time push (auth via query param token for EventSource)
const { sseRouter } = require('./routes/sse');
app.get('/api/sse', (req, res) => {
  // Validate token from query string (EventSource can't set headers)
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try {
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    req.user = jwt.verify(token, secret);
    sseRouter(req, res);
  } catch { res.status(401).end(); }
});

// WAHA sessions proxy
const WAHA_URL = process.env.OPENWA_URL?.replace(/\/$/, '') || 'http://waha:3000';
const WAHA_KEY = process.env.OPENWA_API_KEY || '';
const wahaHdr = () => ({ 'X-Api-Key': WAHA_KEY, Accept: 'application/json' });
const SELF_WEBHOOK = process.env.WEBHOOK_URL || 'http://backend:4000/webhook';

// WAHA health/version
app.get('/api/wa/info', auth, async (req, res) => {
  try {
    const r = await axios.get(`${WAHA_URL}/api/version`, { headers: wahaHdr(), timeout: 5000 });
    res.json({
      url: WAHA_URL,
      health: r.data,   // non-null means server is reachable
      version: r.data,
      webhook_url: SELF_WEBHOOK,
    });
  } catch (e) {
    res.json({ url: WAHA_URL, health: null, version: null, webhook_url: SELF_WEBHOOK });
  }
});

app.get('/api/wa/sessions', auth, async (req, res) => {
  try { res.json((await axios.get(`${WAHA_URL}/api/sessions`, { headers: wahaHdr(), timeout: 10000 })).data); }
  catch { res.json([]); }
});

// GET single session (includes config with webhook)
app.get('/api/wa/sessions/:name', auth, async (req, res) => {
  try {
    const r = await axios.get(`${WAHA_URL}/api/sessions/${req.params.name}`, { headers: wahaHdr(), timeout: 10000 });
    res.json(r.data);
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});

// Create session (optionally auto-configure webhook); falls back to PUT if already exists
app.post('/api/wa/sessions', auth, async (req, res) => {
  const { name, auto_webhook = true, ...rest } = req.body;
  const config = {
    noweb: { store: { enabled: true, fullSync: true } },
    ...(auto_webhook ? {
      webhooks: [{ url: SELF_WEBHOOK, events: ['message', 'message.ack', 'session.status'], enabled: true, ...(WEBHOOK_HMAC_SECRET ? { hmac: { key: WEBHOOK_HMAC_SECRET } } : {}) }]
    } : {}),
    ...rest.config,
  };
  try {
    const r = await axios.post(`${WAHA_URL}/api/sessions`, { name, config }, { headers: { ...wahaHdr(), 'Content-Type': 'application/json' }, timeout: 10000 });
    res.status(r.status).json(r.data);
  } catch (e) {
    // WAHA returns 422 when session already exists — update config via PUT instead
    const status = e.response?.status;
    const msg = JSON.stringify(e.response?.data || '');
    if (status === 422 && msg.includes('already exists')) {
      try {
        const r2 = await axios.put(`${WAHA_URL}/api/sessions/${name}`, { config }, { headers: { ...wahaHdr(), 'Content-Type': 'application/json' }, timeout: 10000 });
        return res.status(r2.status).json(r2.data);
      } catch (e2) { return res.status(e2.response?.status || 500).json(e2.response?.data || { error: e2.message }); }
    }
    res.status(status || 500).json(e.response?.data || { error: e.message });
  }
});

// Update session config (webhook, events, etc.)
app.put('/api/wa/sessions/:name', auth, async (req, res) => {
  try {
    const r = await axios.put(`${WAHA_URL}/api/sessions/${req.params.name}`, req.body, { headers: { ...wahaHdr(), 'Content-Type': 'application/json' }, timeout: 10000 });
    res.status(r.status).json(r.data);
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});

app.post('/api/wa/sessions/:name/:action', auth, async (req, res) => {
  try {
    const r = await axios.post(`${WAHA_URL}/api/sessions/${req.params.name}/${req.params.action}`, {}, { headers: wahaHdr(), timeout: 15000 });
    res.status(r.status).json(r.data);
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});
app.delete('/api/wa/sessions/:name', auth, async (req, res) => {
  try {
    const r = await axios.delete(`${WAHA_URL}/api/sessions/${req.params.name}`, { headers: wahaHdr(), timeout: 10000 });
    res.status(r.status).json(r.data || { ok: true });
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});

// QR — returns { value, image } where image is a data URI (no external service)
app.get('/api/wa/sessions/:name/qr', auth, async (req, res) => {
  try {
    const r = await axios.get(`${WAHA_URL}/api/${req.params.name}/auth/qr`, { headers: wahaHdr(), timeout: 10000 });
    const data = r.data;
    if (data?.value) {
      try {
        const QRCode = require('qrcode');
        data.image = await QRCode.toDataURL(data.value);
      } catch {}
    }
    res.json(data);
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});

// Check if a phone number is registered on WhatsApp
app.get('/api/wa/check-number', auth, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const { checkNumber } = require('./whatsapp');
    const result = await checkNumber(phone);
    res.json(result);
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});

// Configure webhook on an existing session
app.post('/api/wa/sessions/:name/webhook', auth, async (req, res) => {
  const webhookUrl = req.body.webhook_url || SELF_WEBHOOK;
  try {
    const r = await axios.put(`${WAHA_URL}/api/sessions/${req.params.name}`, {
      config: {
        webhooks: [{ url: webhookUrl, events: ['message', 'message.ack', 'session.status'], enabled: true, ...(WEBHOOK_HMAC_SECRET ? { hmac: { key: WEBHOOK_HMAC_SECRET } } : {}) }],
        noweb: { store: { enabled: true, fullSync: true } },
      }
    }, { headers: { ...wahaHdr(), 'Content-Type': 'application/json' }, timeout: 10000 });
    // Also persist in settings
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_url', webhookUrl);
    res.status(r.status).json({ ok: true, session: req.params.name, webhook_url: webhookUrl });
  } catch (e) { res.status(e.response?.status || 500).json(e.response?.data || { error: e.message }); }
});

// Reminder scheduler — emit SSE + Web Push + email when reminders come due
const { broadcast: sseEmit, sendToUser: sseSendToUser } = require('./routes/sse');
const { sendReminderEmail } = require('./emailService');
// Migrations
try { getDb().exec("ALTER TABLE reminders ADD COLUMN notified_at TEXT"); } catch {}
try { getDb().exec("ALTER TABLE reminders ADD COLUMN wa_message TEXT"); } catch {}
try { getDb().exec("ALTER TABLE auto_reply_rules ADD COLUMN attachment_url TEXT"); } catch {}
try { getDb().exec("ALTER TABLE auto_reply_rules ADD COLUMN attachment_filename TEXT"); } catch {}
try { getDb().exec("ALTER TABLE auto_reply_rules ADD COLUMN attachment_mimetype TEXT"); } catch {}
// Make response optional (allow empty when attachment is set)
try { getDb().exec("UPDATE auto_reply_rules SET response = '' WHERE response IS NULL"); } catch {}
setInterval(async () => {
  try {
    const db = getDb();
    const due = db.prepare("SELECT r.*, c.name as contact_name FROM reminders r JOIN contacts c ON r.contact_id = c.id WHERE r.done = 0 AND r.due_at <= datetime('now') AND r.notified_at IS NULL").all();
    for (const r of due) {
      console.log(`[reminder] Disparando: "${r.title}" → usuario ${r.user_id} (contacto: ${r.contact_name})`);
      db.prepare("UPDATE reminders SET notified_at = datetime('now') WHERE id = ?").run(r.id);
      sseSendToUser(r.user_id, 'reminder', { id: r.id, title: r.title, contact_id: r.contact_id, contact_name: r.contact_name });
      try {
        await pushToUser(r.user_id, `Recordatorio: ${r.title}`, r.contact_name, { type: 'reminder', contact_id: r.contact_id });
      } catch {}
      try {
        if (r.user_id) {
          const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(r.user_id);
          if (userRow?.email) sendReminderEmail(userRow.email, r.title, r.contact_name).catch(() => {});
        }
      } catch {}
      // Send WhatsApp message to contact if configured
      if (r.wa_message) {
        try {
          const contact = db.prepare('SELECT phone, wa_chat_id FROM contacts WHERE id = ?').get(r.contact_id);
          if (contact?.phone) {
            const msg = r.wa_message.replace(/\{\{nombre\}\}/g, r.contact_name).replace(/\{\{titulo\}\}/g, r.title);
            await sendText(contact.phone, msg, contact.wa_chat_id);
            db.prepare("INSERT INTO messages (contact_id, direction, content, status) VALUES (?, 'outbound', ?, 'sent')").run(r.contact_id, msg);
            console.log(`[reminder] WhatsApp enviado a ${contact.phone}: "${msg.slice(0, 60)}"`);
          }
        } catch (e) {
          console.error(`[reminder] Error enviando WhatsApp:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[reminder] Scheduler error:', e.message);
  }
}, 30000);

// Broadcast scheduler — check every 60s for scheduled broadcasts ready to fire
setInterval(async () => {
  try {
    const db = getDb();
    const due = db.prepare("SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= datetime('now')").all();
    for (const { id } of due) {
      console.log(`[scheduler] Firing scheduled broadcast #${id}`);
      await fireBroadcast(db, id);
    }
  } catch (e) {
    console.error('[scheduler] Error:', e.message);
  }
}, 60000);

// WAHA session watchdog — auto-restart on recoverable failures only.
// Uses time-based backoff: if a session fails again within 3 min of the last restart,
// back off exponentially (up to 10 min) instead of hammering WhatsApp.
const { resetSession, configureWebhook, sendText } = require('./whatsapp');
let watchdogFailCount = 0;
let watchdogLastRestart = 0;
const SELF_WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://backend:4000/webhook';

// Fix session config (fullSync=false) once the session is WORKING
let configApplied = false;
setInterval(async () => {
  try {
    const r = await axios.get(`${WAHA_URL}/api/sessions`, { headers: wahaHdr(), timeout: 5000 });
    const session = Array.isArray(r.data) ? r.data[0] : null;
    if (!session) return;
    resetSession(); // always flush cache so getSession() re-queries fresh

    if (session.status === 'WORKING') {
      watchdogFailCount = 0;
      // Ensure fullSync:false on first WORKING after (re)start
      if (!configApplied) {
        configApplied = true;
        configureWebhook(SELF_WEBHOOK_URL).catch(() => {});
      }
      return;
    }

    configApplied = false; // reset so we re-apply after next recovery

    if (session.status === 'FAILED') {
      const logs = await axios.get(`${WAHA_URL}/api/${session.name}/logs`, { headers: wahaHdr(), timeout: 5000 })
        .then(l => JSON.stringify(l.data)).catch(() => '');

      if (logs.includes('device_removed')) {
        try { sseEmit('session.status', { status: 'FAILED', reason: 'device_removed' }); } catch {}
        return;
      }
      if (logs.includes('QR refs attempts ended')) {
        try { sseEmit('session.status', { status: 'FAILED', reason: 'qr_timeout' }); } catch {}
        return;
      }

      // Time-based backoff: sessions that fail quickly after restart need longer cooldown
      const backoffMs = Math.min(10 * 60 * 1000, (watchdogFailCount + 1) * 2 * 60 * 1000); // 2, 4, 6, …10 min
      const sinceLastRestart = Date.now() - watchdogLastRestart;
      if (sinceLastRestart < backoffMs) {
        console.log(`[watchdog] FAILED — in backoff (${Math.round((backoffMs - sinceLastRestart) / 1000)}s remaining)`);
        return;
      }

      watchdogFailCount++;
      console.log(`[watchdog] FAILED — restarting (attempt #${watchdogFailCount})`);
      watchdogLastRestart = Date.now();
      await axios.post(`${WAHA_URL}/api/sessions/${session.name}/restart`, {}, { headers: { ...wahaHdr(), 'Content-Type': 'application/json' }, timeout: 10000 }).catch(() => {});
    }
  } catch {}
}, 30000);

// --- Central error handler: turn uncaught throws and body-parser errors (bad JSON,
// payload-too-large) into clean JSON responses without leaking stack traces.
// Note: Express 4 does not route async-handler rejections here — those still need
// per-handler try/catch or an async wrapper (tracked separately). ---
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, '—', err.message);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err.message || 'Error') });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Rinran CRM backend running on port ${PORT}`));
