const axios = require('axios');

const base = () => process.env.OPENWA_URL?.replace(/\/$/, '');

function headers() {
  const key = process.env.OPENWA_API_KEY;
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (key) h['X-Api-Key'] = key;
  return h;
}

// Cache the active WAHA session
let _session = null;
async function getSession() {
  if (_session) return _session;
  const res = await axios.get(`${base()}/api/sessions`, { headers: headers(), timeout: 10000 });
  const list = Array.isArray(res.data) ? res.data : [];
  // Only cache WORKING sessions — never cache a FAILED one or it persists stale
  _session = list.find(s => s.status === 'WORKING' || s.status === 'ready') || null;
  return _session;
}

function resetSession() { _session = null; }

// Phone ↔ WhatsApp ID helpers
function toWaId(phone) {
  return phone.replace(/^\+/, '').replace(/\s+/g, '') + '@c.us';
}

function fromWaId(waId) {
  return '+' + waId
    .replace(/@c\.us$/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@lid$/, '')
    .replace(/\s+/g, '');
}

// Send a text message via WAHA REST format
async function sendText(phone, text, waChatId, quotedMessageId, sessionName) {
  const session = sessionName ? { name: sessionName } : await getSession();
  const chatId = waChatId || toWaId(phone);
  const body = { chatId, text, session: session?.name || 'default' };
  if (quotedMessageId) body.quotedMessageId = quotedMessageId;
  const res = await axios.post(`${base()}/api/sendText`, body, { headers: headers() });
  return res.data;
}

// Get connection state
async function getStatus() {
  try {
    const session = await getSession().catch(() => null);
    return { connected: session?.status === 'WORKING' || session?.status === 'ready', state: session?.status || 'unknown' };
  } catch {
    return { connected: false, state: null };
  }
}

// Get contact info — WAHA Community: GET /api/contacts?contactId=&session=
async function getContact(contactId) {
  try {
    const session = await getSession();
    const sessionKey = session?.name || session?.id;
    const res = await axios.get(
      `${base()}/api/contacts`,
      { headers: headers(), timeout: 8000, params: { contactId, session: sessionKey } }
    );
    return res.data;
  } catch {
    return null;
  }
}

// Resolve a @lid chatId to a real phone number string like "+19296507660"
async function resolveLid(chatId) {
  try {
    const session = await getSession();
    if (!session) return null;
    const sessionKey = session.name || session.id;
    const lidNumber = chatId.replace(/@lid$/, '');
    const res = await axios.get(
      `${base()}/api/${sessionKey}/lids/${encodeURIComponent(lidNumber)}`,
      { headers: headers(), timeout: 8000 }
    );
    const d = res.data;
    // Response may be { phoneNumber: "19296507660" } or { pn: "19296507660@s.whatsapp.net" }
    if (d?.phoneNumber) return '+' + d.phoneNumber;
    if (d?.pn) return fromWaId(d.pn);
    if (d?.number) return '+' + String(d.number).replace(/^\+/, '');
    return null;
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error(`[waha] resolveLid(${chatId}) error:`, e.message);
    }
    return null;
  }
}

// Fetch a contact's WhatsApp profile picture URL
async function getProfilePic(chatId) {
  try {
    const session = await getSession();
    if (!session) return null;
    const sessionKey = session.name || session.id;
    const res = await axios.get(
      `${base()}/api/${sessionKey}/contacts/profile-picture`,
      { headers: headers(), timeout: 10000, params: { contactId: chatId } }
    );
    const d = res.data;
    if (typeof d === 'string' && d.startsWith('http')) return d;
    return d?.eurl || d?.img || d?.url || null;
  } catch {
    return null;
  }
}

// Get all chats — paginate until WAHA returns fewer than the batch size
async function getAllChats() {
  try {
    const session = await getSession();
    if (!session) return [];
    const sessionKey = session.name || session.id;
    const BATCH = 100;
    let all = [], offset = 0;
    while (true) {
      const res = await axios.get(
        `${base()}/api/${sessionKey}/chats`,
        { headers: headers(), timeout: 30000, params: { limit: BATCH, offset } }
      );
      const page = Array.isArray(res.data) ? res.data : [];
      all = all.concat(page);
      if (page.length < BATCH) break;
      offset += BATCH;
    }
    return all;
  } catch (e) {
    console.error('[waha] getAllChats error:', e.message);
    return [];
  }
}

// Get messages for a chat — WAHA Community: GET /api/{session}/chats/{chatId}/messages
async function getChatMessages(chatId, limit = 500) {
  try {
    const session = await getSession();
    if (!session) return [];
    const sessionKey = session.name || session.id;
    const res = await axios.get(
      `${base()}/api/${sessionKey}/chats/${encodeURIComponent(chatId)}/messages`,
      { headers: headers(), timeout: 30000, params: { limit } }
    );
    const d = res.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.messages)) return d.messages;
    return [];
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error(`[waha] getChatMessages(${chatId}) error:`, e.message);
    }
    return [];
  }
}

// Download media from a WhatsApp message
async function downloadMedia(waMessageId, sessionKey) {
  try {
    const session = sessionKey || (await getSession())?.name;
    if (!session) return null;
    // WAHA NOWEB: GET /api/{session}/messages/{messageId}/download
    const res = await axios.get(
      `${base()}/api/${session}/messages/${encodeURIComponent(waMessageId)}/download`,
      { headers: headers(), timeout: 30000, responseType: 'arraybuffer' }
    );
    const contentType = res.headers['content-type'] || 'application/octet-stream';
    return { data: Buffer.from(res.data), contentType };
  } catch {
    return null;
  }
}

// Send a file via WAHA
async function sendFile(chatId, fileObj) {
  const session = await getSession();
  const mime = fileObj.mimetype || '';
  // Use type-specific endpoints so WhatsApp renders media natively (not as a document)
  let endpoint = '/api/sendFile';
  if (mime.startsWith('image/')) endpoint = '/api/sendImage';
  else if (mime.startsWith('video/')) endpoint = '/api/sendVideo';
  const res = await axios.post(`${base()}${endpoint}`, {
    chatId,
    file: { url: fileObj.url, filename: fileObj.filename, mimetype: fileObj.mimetype },
    session: session?.name || 'default',
    caption: fileObj.caption || undefined,
  }, { headers: headers(), timeout: 60000 });
  return res.data;
}

// Send a voice note via WAHA (shows as voice player in WhatsApp, not file attachment)
async function sendVoice(chatId, fileObj) {
  const session = await getSession();
  const res = await axios.post(`${base()}/api/sendVoice`, {
    chatId,
    file: { url: fileObj.url, filename: fileObj.filename, mimetype: fileObj.mimetype },
    session: session?.name || 'default',
  }, { headers: headers(), timeout: 60000 });
  return res.data;
}

// Send GPS location
async function sendLocation(chatId, latitude, longitude, title) {
  const session = await getSession();
  const res = await axios.post(`${base()}/api/sendLocation`, {
    chatId, latitude, longitude, title: title || '',
    session: session?.name || 'default',
  }, { headers: headers(), timeout: 10000 });
  return res.data;
}

// Mark chat as read (sends seen receipt to contact)
async function sendSeen(phone, waChatId) {
  const session = await getSession();
  const chatId = waChatId || toWaId(phone);
  await axios.post(`${base()}/api/sendSeen`, {
    chatId, session: session?.name || 'default',
  }, { headers: headers(), timeout: 10000 });
}

// Start or stop typing indicator
async function sendTyping(phone, waChatId, active) {
  const session = await getSession();
  const chatId = waChatId || toWaId(phone);
  const endpoint = active ? 'startTyping' : 'stopTyping';
  await axios.post(`${base()}/api/${endpoint}`, {
    chatId, session: session?.name || 'default',
  }, { headers: headers(), timeout: 10000 });
}

// Check if a phone number has WhatsApp
async function checkNumber(phone) {
  const session = await getSession();
  const sessionKey = session?.name || 'default';
  const normalized = phone.replace(/^\+/, '').replace(/\s+/g, '');
  const res = await axios.get(`${base()}/api/contacts/check-exists`, {
    headers: headers(), timeout: 10000,
    params: { phone: normalized, session: sessionKey },
  });
  return res.data;
}

// Get all WhatsApp labels
async function getLabels() {
  try {
    const session = await getSession();
    if (!session) return [];
    const sessionKey = session.name || session.id;
    const res = await axios.get(`${base()}/api/${sessionKey}/labels`, { headers: headers(), timeout: 10000 });
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    console.error('[waha] getLabels error:', e.message);
    return [];
  }
}

// Get chats assigned to a specific label
async function getLabelChats(labelId) {
  try {
    const session = await getSession();
    if (!session) return [];
    const sessionKey = session.name || session.id;
    const res = await axios.get(
      `${base()}/api/${sessionKey}/labels/${encodeURIComponent(labelId)}/chats`,
      { headers: headers(), timeout: 10000 }
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

// Get labels assigned to a specific chat
async function getChatLabels(chatId) {
  try {
    const session = await getSession();
    if (!session) return [];
    const sessionKey = session.name || session.id;
    const res = await axios.get(
      `${base()}/api/${sessionKey}/labels/chats/${encodeURIComponent(chatId)}`,
      { headers: headers(), timeout: 10000 }
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

// Set labels for a chat (replaces all existing labels)
async function setChatLabels(chatId, labelIds) {
  try {
    const session = await getSession();
    if (!session) return false;
    const sessionKey = session.name || session.id;
    await axios.put(
      `${base()}/api/${sessionKey}/labels/chats/${encodeURIComponent(chatId)}`,
      { labels: labelIds.map(id => ({ id: String(id) })) },
      { headers: headers(), timeout: 30000 }
    );
    return true;
  } catch (e) {
    console.error('[waha] setChatLabels error:', e.message);
    return false;
  }
}

// Configure webhook + NOWEB store for the active session
async function configureWebhook(webhookUrl) {
  try {
    const session = await getSession();
    if (!session) return false;
    const sessionKey = session.name || session.id;
    await axios.put(`${base()}/api/sessions/${sessionKey}`, {
      config: {
        webhooks: [{ url: webhookUrl, events: ['message', 'message.ack'], enabled: true, ...(process.env.WEBHOOK_HMAC_SECRET ? { hmac: { key: process.env.WEBHOOK_HMAC_SECRET } } : {}) }],
        noweb: { store: { enabled: true, fullSync: true } },
      }
    }, { headers: headers(), timeout: 10000 });
    console.log(`[waha] Webhook + store configured → ${webhookUrl}`);
    return true;
  } catch (e) {
    console.error('[waha] configureWebhook error:', e.message);
    return false;
  }
}

module.exports = { sendText, sendFile, sendVoice, sendLocation, sendSeen, sendTyping, checkNumber, downloadMedia, getStatus, toWaId, fromWaId, getContact, resolveLid, getProfilePic, getAllChats, getChatMessages, getSession, resetSession, configureWebhook, getLabels, getLabelChats, getChatLabels, setChatLabels };
