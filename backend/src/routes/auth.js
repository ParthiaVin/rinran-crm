const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { getDb } = require('../db');
const authMiddleware = require('../middleware/auth');
const { encrypt, decrypt } = require('../secretStore');

const secret = () => process.env.JWT_SECRET || 'rinran-secret-change-me';

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password, totp_code } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  // If 2FA enabled, require TOTP code
  if (user.two_fa_enabled && user.two_fa_secret) {
    if (!totp_code) {
      return res.status(200).json({ requires_2fa: true });
    }
    authenticator.options = { window: 1 };
    if (!authenticator.verify({ token: String(totp_code), secret: decrypt(user.two_fa_secret) })) {
      return res.status(401).json({ error: 'Código 2FA incorrecto' });
    }
  }

  const role = user.role || 'admin';
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role },
    secret(),
    { expiresIn: '30d' }
  );

  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role } });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const user = getDb().prepare('SELECT id, email, name, role, two_fa_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password y new_password requeridos' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ ok: true });
});

// GET /api/auth/2fa/setup — generate TOTP secret + otpauth URL + QR data URI
router.get('/2fa/setup', authMiddleware, async (req, res) => {
  const secret2fa = authenticator.generateSecret();
  const user = getDb().prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  const otpauthUrl = authenticator.keyuri(user.email, 'Rinran CRM', secret2fa);
  getDb().prepare('UPDATE users SET two_fa_secret = ? WHERE id = ?').run(encrypt(secret2fa), req.user.id);
  try {
    const QRCode = require('qrcode');
    const qr_data_url = await QRCode.toDataURL(otpauthUrl);
    res.json({ secret: secret2fa, otpauth_url: otpauthUrl, qr_data_url });
  } catch {
    res.json({ secret: secret2fa, otpauth_url: otpauthUrl });
  }
});

// POST /api/auth/2fa/enable — verify code then enable
router.post('/2fa/enable', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.two_fa_secret) return res.status(400).json({ error: 'Run /2fa/setup first' });
  authenticator.options = { window: 1 };
  if (!authenticator.verify({ token: String(code), secret: decrypt(user.two_fa_secret) })) {
    return res.status(401).json({ error: 'Código incorrecto' });
  }
  getDb().prepare('UPDATE users SET two_fa_enabled = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true, enabled: true });
});

// POST /api/auth/2fa/disable
router.post('/2fa/disable', authMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  getDb().prepare('UPDATE users SET two_fa_enabled = 0, two_fa_secret = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true, enabled: false });
});

module.exports = router;
