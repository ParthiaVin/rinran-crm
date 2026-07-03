// Encrypts sensitive values at rest (SMTP password, 2FA secrets, outbound-webhook
// secrets, VAPID private key) so a leaked DB / backup file is not a leak of secrets.
//
// Key source (in order): SECRETS_KEY env var, else an auto-generated key persisted at
// data/.secret-key (0600) — which is NOT included in the DB backup, so the backup alone
// is useless. decrypt() passes through legacy plaintext, so this is fully backward-compatible.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
let _key = null;

function keyFilePath() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/rinran.db');
  return path.join(path.dirname(dbPath), '.secret-key');
}

function getKey() {
  if (_key) return _key;
  if (process.env.SECRETS_KEY) {
    _key = crypto.scryptSync(process.env.SECRETS_KEY, 'rinran-secret-store-v1', 32);
    return _key;
  }
  const kf = keyFilePath();
  try {
    if (fs.existsSync(kf)) {
      const buf = Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'base64');
      if (buf.length === 32) { _key = buf; return _key; }
    }
  } catch {}
  _key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(kf), { recursive: true });
    fs.writeFileSync(kf, _key.toString('base64'), { mode: 0o600 });
    try { fs.chmodSync(kf, 0o600); } catch {}
  } catch (e) {
    console.warn('[secrets] could not persist key file — secrets will not survive restart:', e.message);
  }
  return _key;
}

function isEncrypted(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '' || isEncrypted(plaintext)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(stored) {
  if (stored == null || !isEncrypted(stored)) return stored; // legacy plaintext or null/empty
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[secrets] decrypt failed (wrong SECRETS_KEY / .secret-key?):', e.message);
    return null;
  }
}

// One-time, idempotent migration: encrypt any existing plaintext secrets.
function migrateExistingSecrets(db) {
  try {
    for (const key of ['smtp_pass', 'vapid_private_key']) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (row?.value && !isEncrypted(row.value)) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(encrypt(row.value), key);
      }
    }
    for (const r of db.prepare('SELECT id, secret FROM outbound_webhooks WHERE secret IS NOT NULL AND secret != \'\'').all()) {
      if (!isEncrypted(r.secret)) db.prepare('UPDATE outbound_webhooks SET secret = ? WHERE id = ?').run(encrypt(r.secret), r.id);
    }
    for (const r of db.prepare('SELECT id, two_fa_secret FROM users WHERE two_fa_secret IS NOT NULL AND two_fa_secret != \'\'').all()) {
      if (!isEncrypted(r.two_fa_secret)) db.prepare('UPDATE users SET two_fa_secret = ? WHERE id = ?').run(encrypt(r.two_fa_secret), r.id);
    }
  } catch (e) {
    console.error('[secrets] migration error:', e.message);
  }
}

module.exports = { encrypt, decrypt, isEncrypted, migrateExistingSecrets };
