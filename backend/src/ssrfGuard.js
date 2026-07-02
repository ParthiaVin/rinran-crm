// SSRF guard: used wherever the server opens an outbound connection to a
// user/admin-supplied host (outbound-webhook test + delivery, SMTP test, photo proxy).
// Blocks private / loopback / link-local / reserved targets (incl. the cloud-metadata
// address 169.254.169.254), restricts the scheme to http(s), and — via a connect-time
// DNS lookup on the outbound socket — defeats DNS-rebinding (TOCTOU) bypasses.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');

// True if this IP literal must not be connected to.
function isBlockedIp(ip) {
  if (!ip) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4-mapped IPv6
  if (mapped) ip = mapped[1];

  const kind = net.isIP(ip);
  if (kind === 4) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 10) return true;                           // 10/8 private
    if (a === 127) return true;                          // 127/8 loopback
    if (a === 169 && b === 254) return true;             // 169.254/16 link-local (metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12 private
    if (a === 192 && b === 168) return true;             // 192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64/10 CGNAT
    if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0/24
    if (a >= 224) return true;                           // 224/4 multicast + 240/4 reserved
    return false;
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;          // unspecified / loopback
    if (s.startsWith('fe80')) return true;               // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // ULA fc00::/7
    if (s.startsWith('ff')) return true;                 // multicast
    return false;
  }
  return true; // not a valid IP literal
}

// dns.lookup-compatible fn that fails the resolution if any resolved address is blocked.
// Used as an http/https Agent `lookup`, so the check runs at connect time (anti-rebinding).
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    for (const a of addresses) {
      if (isBlockedIp(a.address)) {
        return callback(Object.assign(new Error('blocked address (SSRF protection)'), { code: 'EBLOCKEDADDR' }));
      }
    }
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// Throw unless `hostname` resolves only to public addresses (upfront, fast-fail check).
async function assertPublicHost(hostname) {
  const host = (hostname || '').replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!host || host.toLowerCase() === 'localhost') throw new Error('host no permitido');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('host no permitido');
    return [{ address: host, family: net.isIP(host) }];
  }
  const addresses = await dns.promises.lookup(host, { all: true });
  if (!addresses.length) throw new Error('host no resoluble');
  for (const a of addresses) if (isBlockedIp(a.address)) throw new Error('host no permitido');
  return addresses;
}

// Throw unless `rawUrl` is an http(s) URL whose host resolves only to public addresses.
async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('URL inválida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('esquema no permitido');
  await assertPublicHost(u.hostname);
  return u;
}

// Fresh axios options that (a) never follow redirects and (b) re-validate the resolved IP
// at socket-connect time. Use together with an upfront assertPublicHttpUrl() call.
function safeAxiosOptions() {
  const httpAgent = new http.Agent({ keepAlive: false });
  httpAgent.createConnection = (options, cb) => net.createConnection({ ...options, lookup: safeLookup }, cb);
  const httpsAgent = new https.Agent({ keepAlive: false });
  httpsAgent.createConnection = (options, cb) => tls.connect({ ...options, lookup: safeLookup }, cb);
  return { maxRedirects: 0, httpAgent, httpsAgent };
}

module.exports = { isBlockedIp, safeLookup, assertPublicHost, assertPublicHttpUrl, safeAxiosOptions };
