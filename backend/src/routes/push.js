const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { getDb } = require('../db');
const { encrypt, decrypt } = require('../secretStore');

let vapidReady = false;

function ensureVapid() {
  if (vapidReady) return;
  const db = getDb();
  let pub = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()?.value;
  let priv = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'vapid_private_key'").get()?.value);
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_public_key', pub);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vapid_private_key', encrypt(priv));
    console.log('[push] Generated new VAPID keys');
  }
  webpush.setVapidDetails('mailto:admin@rinran.com', pub, priv);
  vapidReady = true;
}

// GET /push/vapid-key
router.get('/vapid-key', (req, res) => {
  ensureVapid();
  const pub = getDb().prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()?.value;
  res.json({ publicKey: pub });
});

// POST /push/subscribe
router.post('/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'endpoint and keys required' });
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, keys_json) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json
    `).run(req.user.id, endpoint, JSON.stringify(keys));
  } catch (e) {
    // Older SQLite without ON CONFLICT DO UPDATE — fallback
    try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint); } catch {}
    db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, keys_json) VALUES (?, ?, ?)').run(req.user.id, endpoint, JSON.stringify(keys));
  }
  res.json({ ok: true });
});

// DELETE /push/subscribe
router.delete('/subscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true });
});

// Send push to a specific user
async function pushToUser(userId, title, body, data = {}) {
  ensureVapid();
  const db = getDb();
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const sub of subs) {
    try {
      const keys = JSON.parse(sub.keys_json);
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys },
        JSON.stringify({ title, body, data })
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription expired — remove it
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
}

// Broadcast push to all subscribed users
async function pushToAll(title, body, data = {}) {
  ensureVapid();
  const db = getDb();
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  for (const sub of subs) {
    try {
      const keys = JSON.parse(sub.keys_json);
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys },
        JSON.stringify({ title, body, data })
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
}

module.exports = { router, pushToUser, pushToAll };
