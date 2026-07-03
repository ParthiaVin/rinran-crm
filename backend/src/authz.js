// Shared authorization helpers.
//
// The auth middleware only verifies the JWT and sets req.user; per-resource access
// control is enforced here. Roles: 'admin' (full access) and 'agent' (scoped to the
// contacts assigned to them). Legacy users with a null role are treated as admin
// (the login route already resolves role to 'admin' when absent).
const { getDb } = require('./db');

function isAgent(req) {
  return req?.user?.role === 'agent';
}

// True if the caller may act on the given contact row (which must include `assigned_to`).
// Admins: always. Agents: only contacts assigned to them.
function canActOnContact(req, contactRow) {
  return !isAgent(req) || (!!contactRow && contactRow.assigned_to === req.user.id);
}

// Express middleware: require an admin. Use to gate global/shared config endpoints.
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  next();
}

// Express middleware factory: load the contact named by a route param and enforce
// canActOnContact. On success attaches req.contact. Returns 404 if missing, 403 if denied.
// `paramName` defaults to 'id' (use 'contactId' for the nested notes/tags routers).
function requireContactAccess(paramName = 'id') {
  return (req, res, next) => {
    const contact = getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(req.params[paramName]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!canActOnContact(req, contact)) return res.status(403).json({ error: 'No autorizado' });
    req.contact = contact;
    next();
  };
}

module.exports = { isAgent, canActOnContact, requireAdmin, requireContactAccess };
