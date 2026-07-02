const express = require('express');
const router = express.Router();
const express_ref = express;
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { getDb, closeDb } = require('../db');
const { assertPublicHost, assertPublicHttpUrl, safeAxiosOptions } = require('../ssrfGuard');
const { encrypt, decrypt } = require('../secretStore');

const DEFAULTS = {
  company_name: 'Rinran CRM',
  timezone: 'America/New_York',
  business_hours_start: '09:00',
  business_hours_end: '18:00',
  sla_hours: '4',
  webhook_url: '',
};

function getAll(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = { ...DEFAULTS };
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}

// GET /settings
router.get('/', (req, res) => {
  res.json(getAll(getDb()));
});

// PUT /settings
router.put('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const allowed = ['company_name', 'timezone', 'business_hours_start', 'business_hours_end', 'sla_hours', 'webhook_url'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(req.body[key]));
    }
  }
  res.json(getAll(db));
});

// POST /settings/change-password
router.post('/change-password', (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password y new_password requeridos' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ ok: true });
});

// POST /settings/webhook — configure WAHA webhook
router.post('/webhook', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const settings = getAll(db);
  const webhookUrl = req.body.webhook_url || settings.webhook_url;
  if (!webhookUrl) return res.status(400).json({ error: 'webhook_url required' });

  const WAHA_URL = process.env.OPENWA_URL?.replace(/\/$/, '') || 'http://waha:3000';
  const WAHA_KEY = process.env.OPENWA_API_KEY || '';
  try {
    const sessRes = await axios.get(`${WAHA_URL}/api/sessions`, { headers: { 'X-Api-Key': WAHA_KEY }, timeout: 10000 });
    const sessions = Array.isArray(sessRes.data) ? sessRes.data : [];
    const active = sessions.find(s => s.status === 'WORKING') || sessions[0];
    if (!active) return res.status(400).json({ error: 'No active session found' });

    await axios.put(`${WAHA_URL}/api/sessions/${active.name}`, {
      config: {
        webhooks: [{ url: webhookUrl, events: ['message', 'message.ack'], enabled: true }],
        noweb: { store: { enabled: true, fullSync: true } },
      }
    }, { headers: { 'X-Api-Key': WAHA_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_url', webhookUrl);
    res.json({ ok: true, session: active.name, webhook_url: webhookUrl });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Custom field definitions (admin only)
router.get('/custom-fields', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM custom_field_definitions ORDER BY sort_order, id').all());
});

router.post('/custom-fields', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const { name, field_type = 'text', options, sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = db.prepare('INSERT INTO custom_field_definitions (name, field_type, options_json, sort_order) VALUES (?, ?, ?, ?)').run(name, field_type, options ? JSON.stringify(options) : null, sort_order);
    res.status(201).json(db.prepare('SELECT * FROM custom_field_definitions WHERE id = ?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Field name already exists' });
    throw e;
  }
});

router.delete('/custom-fields/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  getDb().prepare('DELETE FROM custom_field_definitions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Assignment rules (admin only)
router.get('/assignment-rules', (req, res) => {
  const rules = getDb().prepare(`
    SELECT ar.*, cat.name as category_name, u.name as agent_name
    FROM assignment_rules ar
    LEFT JOIN categories cat ON ar.category_id = cat.id
    JOIN users u ON ar.agent_id = u.id
    ORDER BY ar.sort_order, ar.id
  `).all();
  res.json(rules);
});

router.post('/assignment-rules', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const { name, category_id, agent_id, sort_order = 0 } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  const r = db.prepare('INSERT INTO assignment_rules (name, category_id, agent_id, sort_order) VALUES (?, ?, ?, ?)').run(name || '', category_id || null, agent_id, sort_order);
  res.status(201).json(db.prepare(`SELECT ar.*, cat.name as category_name, u.name as agent_name FROM assignment_rules ar LEFT JOIN categories cat ON ar.category_id = cat.id JOIN users u ON ar.agent_id = u.id WHERE ar.id = ?`).get(r.lastInsertRowid));
});

router.patch('/assignment-rules/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const { is_active } = req.body;
  if (is_active !== undefined) getDb().prepare('UPDATE assignment_rules SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/assignment-rules/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  getDb().prepare('DELETE FROM assignment_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Backup / Restore ──────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/rinran.db');

router.get('/backup', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'Base de datos no encontrada' });
  // Flush the WAL into the main file so the streamed backup is complete/consistent.
  try { getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="rinran-backup-${date}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(DB_PATH).pipe(res);
});

router.post('/restore', express_ref.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.toString('ascii', 0, 6) !== 'SQLite') {
    return res.status(400).json({ error: 'Archivo no válido. Debe ser una base de datos SQLite.' });
  }
  const tmpPath = DB_PATH + '.restore_tmp';
  fs.writeFileSync(tmpPath, buf);

  // Validate it is a real SQLite DB with this app's schema — not just the magic bytes.
  try {
    const { DatabaseSync } = require('node:sqlite');
    const test = new DatabaseSync(tmpPath);
    const tables = test.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    test.close();
    const required = ['users', 'contacts', 'messages', 'settings'];
    if (!required.every(t => tables.includes(t))) {
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpPath + s); } catch {} }
      return res.status(400).json({ error: 'La base de datos no tiene el esquema esperado.' });
    }
  } catch {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpPath + s); } catch {} }
    return res.status(400).json({ error: 'Archivo SQLite inválido o corrupto.' });
  }

  // Swap safely: close the live handle and clear stale WAL/SHM so the new DB isn't corrupted.
  closeDb();
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + s); } catch {} }
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(tmpPath + s); } catch {} }
  fs.renameSync(tmpPath, DB_PATH);
  res.json({ ok: true, message: 'Base de datos restaurada. Reinicia el servidor para aplicar los cambios.' });
});

// ── SMTP ──────────────────────────────────────────────────────────────────────
const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_enabled'];

router.get('/smtp', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${SMTP_KEYS.map(() => '?').join(',')})`)
    .all(...SMTP_KEYS);
  const result = { smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_from: '', smtp_enabled: '0' };
  rows.forEach(r => { result[r.key] = r.value; });
  res.json({ ...result, smtp_pass: result.smtp_pass ? '••••••' : '' });
});

router.put('/smtp', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const db = getDb();
  const allowed = SMTP_KEYS;
  for (const key of allowed) {
    if (req.body[key] !== undefined && !(key === 'smtp_pass' && req.body[key] === '••••••')) {
      const value = key === 'smtp_pass' ? encrypt(String(req.body[key])) : String(req.body[key]);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
  res.json({ ok: true });
});

router.post('/smtp/test', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to (email destino) requerido' });
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${SMTP_KEYS.map(() => '?').join(',')})`)
    .all(...SMTP_KEYS);
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  if (!cfg.smtp_host) return res.status(400).json({ error: 'SMTP no configurado' });
  // SSRF guard: reject internal/private SMTP targets, and pin the connection to the
  // resolved public IP (with SNI = original host) so DNS can't rebind to an internal host.
  let pinnedHost;
  try {
    const addrs = await assertPublicHost(cfg.smtp_host);
    pinnedHost = addrs[0].address;
  } catch {
    return res.status(400).json({ error: 'Host SMTP no permitido' });
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: pinnedHost, port: parseInt(cfg.smtp_port) || 587,
      secure: parseInt(cfg.smtp_port) === 465,
      auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: decrypt(cfg.smtp_pass) } : undefined,
      tls: { servername: cfg.smtp_host },
      connectionTimeout: 10000, greetingTimeout: 10000,
    });
    await transporter.sendMail({
      from: cfg.smtp_from || cfg.smtp_user,
      to,
      subject: 'Test email — Rinran CRM',
      text: 'Este es un mensaje de prueba enviado desde Rinran CRM.',
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[smtp] test error:', e.message);
    res.status(502).json({ error: 'No se pudo enviar el correo de prueba. Revisa la configuración SMTP.' });
  }
});

// ── Outbound Webhooks ─────────────────────────────────────────────────────────
router.get('/outbound-webhooks', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  res.json(getDb().prepare('SELECT id, name, url, events, is_active, created_at FROM outbound_webhooks ORDER BY id').all());
});

router.post('/outbound-webhooks', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const { name, url, events = 'message.inbound', secret } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name y url requeridos' });
  const db = getDb();
  const r = db.prepare('INSERT INTO outbound_webhooks (name, url, events, secret) VALUES (?, ?, ?, ?)')
    .run(name, url, events, secret ? encrypt(secret) : null);
  res.status(201).json(db.prepare('SELECT id, name, url, events, is_active, created_at FROM outbound_webhooks WHERE id = ?').get(r.lastInsertRowid));
});

router.patch('/outbound-webhooks/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const { is_active } = req.body;
  getDb().prepare('UPDATE outbound_webhooks SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/outbound-webhooks/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  getDb().prepare('DELETE FROM outbound_webhooks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/outbound-webhooks/:id/test', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const hook = getDb().prepare('SELECT * FROM outbound_webhooks WHERE id = ?').get(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Webhook no encontrado' });
  const payload = { event: 'test', timestamp: new Date().toISOString(), source: 'rinran-crm', message: 'Prueba de conexión' };
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-Rinran-Event': 'test' };
  if (hook.secret) {
    const crypto = require('crypto');
    headers['X-Rinran-Signature'] = 'sha256=' + crypto.createHmac('sha256', decrypt(hook.secret)).update(body).digest('hex');
  }
  try {
    await assertPublicHttpUrl(hook.url);
  } catch {
    return res.status(400).json({ ok: false, error: 'URL no permitida' });
  }
  try {
    const r = await axios.post(hook.url, payload, { headers, timeout: 8000, ...safeAxiosOptions() });
    res.json({ ok: true, status: r.status });
  } catch (e) {
    // Keep the target's own HTTP status (useful, low-risk); hide raw connection errors (SSRF oracle).
    res.status(502).json({ ok: false, error: e.response ? `HTTP ${e.response.status}` : 'Error de conexión' });
  }
});

// ── API Keys ──────────────────────────────────────────────────────────────────
router.get('/api-keys', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  // Any admin can see/manage all keys (avoids a revocation gap between admins).
  res.json(getDb().prepare('SELECT id, name, key_prefix, scopes, is_active, last_used_at, created_at FROM api_keys ORDER BY id DESC').all());
});

router.post('/api-keys', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  const { name, scopes = 'read' } = req.body;
  if (!name) return res.status(400).json({ error: 'name requerido' });
  const rawKey = 'rk_' + crypto.randomBytes(24).toString('hex');
  const prefix = rawKey.slice(0, 10);
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const db = getDb();
  const r = db.prepare('INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(name, prefix, hash, scopes, req.user.id);
  const row = db.prepare('SELECT id, name, key_prefix, scopes, is_active, last_used_at, created_at FROM api_keys WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ ...row, key: rawKey });
});

router.delete('/api-keys/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
