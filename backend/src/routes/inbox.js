const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireContactAccess } = require('../authz');

// GET /inbox — conversations sorted by last message, with unread count + SLA flag
router.get('/', (req, res) => {
  const db = getDb();
  const { search, conv_status, assigned_to, page = 1, limit = 40 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = ['c.is_deleted != 1', 'EXISTS (SELECT 1 FROM messages WHERE contact_id = c.id)'];
  const params = [];

  // Role-based filtering
  if (req.user.role === 'agent') {
    where.push('c.assigned_to = ?');
    params.push(req.user.id);
  } else if (assigned_to) {
    where.push('c.assigned_to = ?');
    params.push(assigned_to);
  }

  if (conv_status) {
    where.push('c.conv_status = ?');
    params.push(conv_status);
  }

  if (search) {
    where.push('(c.name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  // SLA hours from settings (default 4)
  const slaRow = db.prepare("SELECT value FROM settings WHERE key = 'sla_hours'").get();
  const slaHours = parseFloat(slaRow?.value || '4');

  const conversations = db.prepare(`
    SELECT
      c.id,
      c.name,
      c.phone,
      c.country_flag,
      c.country_name,
      c.profile_pic_url,
      c.status,
      c.conv_status,
      c.assigned_to,
      cat.name  AS category_name,
      cat.color AS category_color,
      u.name    AS assigned_name,
      last_msg.content    AS last_message,
      last_msg.direction  AS last_direction,
      last_msg.sent_at    AS last_message_at,
      (
        SELECT COUNT(*) FROM messages m2
        WHERE m2.contact_id = c.id
          AND m2.direction = 'inbound'
          AND m2.status = 'received'
      ) AS unread_count,
      (
        SELECT sent_at FROM messages m3
        WHERE m3.contact_id = c.id AND m3.direction = 'inbound'
        ORDER BY m3.sent_at DESC LIMIT 1
      ) AS last_inbound_at,
      (
        SELECT sent_at FROM messages m4
        WHERE m4.contact_id = c.id AND m4.direction = 'outbound'
        ORDER BY m4.sent_at DESC LIMIT 1
      ) AS last_outbound_at
    FROM contacts c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN users u ON c.assigned_to = u.id
    LEFT JOIN (
      SELECT contact_id, content, direction, sent_at,
             ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY sent_at DESC) AS rn
      FROM messages
    ) last_msg ON last_msg.contact_id = c.id AND last_msg.rn = 1
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(last_msg.sent_at, c.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  const total = db.prepare(`
    SELECT COUNT(*) as n FROM contacts c WHERE ${where.join(' AND ')}
  `).get(...params).n;

  // Compute SLA breach: last inbound has no outbound response and is older than slaHours
  const now = Date.now();
  const result = conversations.map(c => {
    let sla_breach = false;
    if (c.conv_status !== 'closed' && c.last_inbound_at) {
      const lastIn = new Date(c.last_inbound_at + 'Z').getTime();
      const lastOut = c.last_outbound_at ? new Date(c.last_outbound_at + 'Z').getTime() : 0;
      const pendingMs = (lastIn > lastOut) ? (now - lastIn) : 0;
      sla_breach = pendingMs > slaHours * 3600 * 1000;
    }
    return { ...c, sla_breach };
  });

  res.json({ conversations: result, total, page: parseInt(page), limit: parseInt(limit) });
});

// PATCH /inbox/:contact_id/read — mark all inbound messages as read
router.patch('/:contact_id/read', requireContactAccess('contact_id'), (req, res) => {
  const db = getDb();
  db.prepare(`
    UPDATE messages SET status = 'read'
    WHERE contact_id = ? AND direction = 'inbound' AND status = 'received'
  `).run(req.params.contact_id);
  res.json({ ok: true });
});

// PATCH /inbox/:contact_id/unread — mark last inbound message as unread
router.patch('/:contact_id/unread', requireContactAccess('contact_id'), (req, res) => {
  const db = getDb();
  const last = db.prepare(
    "SELECT id FROM messages WHERE contact_id = ? AND direction = 'inbound' ORDER BY sent_at DESC LIMIT 1"
  ).get(req.params.contact_id);
  if (last) {
    db.prepare("UPDATE messages SET status = 'received' WHERE id = ?").run(last.id);
  }
  res.json({ ok: true });
});

module.exports = router;
