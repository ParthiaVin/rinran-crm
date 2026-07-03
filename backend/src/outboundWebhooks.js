const axios = require('axios');
const crypto = require('crypto');
const { assertPublicHttpUrl, safeAxiosOptions } = require('./ssrfGuard');
const { decrypt } = require('./secretStore');

async function fireOutboundWebhooks(db, eventType, payload) {
  try {
    const hooks = db.prepare(
      "SELECT * FROM outbound_webhooks WHERE is_active = 1 AND (events = ? OR events LIKE ? OR events LIKE ? OR events LIKE ?)"
    ).all(eventType, `${eventType},%`, `%,${eventType}`, `%,${eventType},%`);

    for (const hook of hooks) {
      try {
        await assertPublicHttpUrl(hook.url); // SSRF guard: never deliver to internal/private targets
        const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data: payload });
        const headers = { 'Content-Type': 'application/json' };
        if (hook.secret) {
          headers['X-Rinran-Signature'] = 'sha256=' + crypto.createHmac('sha256', decrypt(hook.secret)).update(body).digest('hex');
        }
        await axios.post(hook.url, JSON.parse(body), { headers, timeout: 10000, ...safeAxiosOptions() });
      } catch {}
    }
  } catch {}
}

module.exports = { fireOutboundWebhooks };
