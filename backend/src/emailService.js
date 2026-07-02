const { getDb } = require('./db');
const { decrypt } = require('./secretStore');

async function getSmtpTransporter() {
  const nodemailer = require('nodemailer');
  const db = getDb();
  const keys = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_enabled'];
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys);
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });

  if (!cfg.smtp_host || cfg.smtp_enabled !== '1') return null;

  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port: parseInt(cfg.smtp_port) || 587,
    secure: parseInt(cfg.smtp_port) === 465,
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: decrypt(cfg.smtp_pass) } : undefined,
  });
}

async function sendEmail(to, subject, html) {
  try {
    const transporter = await getSmtpTransporter();
    if (!transporter) return false;
    const db = getDb();
    const fromRow = db.prepare("SELECT value FROM settings WHERE key = 'smtp_from'").get();
    const userRow = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get();
    const from = fromRow?.value || userRow?.value || 'noreply@rinran.com';
    await transporter.sendMail({ from, to, subject, html });
    return true;
  } catch (e) {
    console.error('[email] Error:', e.message);
    return false;
  }
}

async function sendReminderEmail(to, title, contactName) {
  return sendEmail(
    to,
    `Recordatorio: ${title}`,
    `<p>Tienes un recordatorio pendiente:</p>
     <h2>${title}</h2>
     <p>Contacto: <strong>${contactName}</strong></p>
     <p>Ingresa al CRM para ver los detalles.</p>`
  );
}

async function sendWelcomeEmail(to, name, password) {
  const db = getDb();
  const companyRow = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  const company = companyRow?.value || 'Rinran CRM';
  return sendEmail(
    to,
    `Bienvenido a ${company}`,
    `<p>Hola ${name},</p>
     <p>Tu cuenta en <strong>${company}</strong> fue creada.</p>
     <p>Email: <strong>${to}</strong><br>Contraseña temporal: <strong>${password}</strong></p>
     <p>Te recomendamos cambiar tu contraseña al ingresar.</p>`
  );
}

module.exports = { sendEmail, sendReminderEmail, sendWelcomeEmail };
