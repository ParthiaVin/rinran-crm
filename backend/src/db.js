const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { migrateExistingSecrets } = require('./secretStore');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/rinran.db');

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6366f1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      country_code TEXT,
      country_flag TEXT,
      country_name TEXT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      content TEXT NOT NULL,
      wa_message_id TEXT,
      status TEXT DEFAULT 'sent',
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      total_recipients INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS internal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6366f1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contact_tags (
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (contact_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      field_type TEXT NOT NULL DEFAULT 'text',
      options_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_field_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      field_def_id INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
      value TEXT,
      UNIQUE(contact_id, field_def_id)
    );

    CREATE INDEX IF NOT EXISTS idx_internal_notes_contact ON internal_notes(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags ON contact_tags(contact_id);

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      note TEXT,
      due_at TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      wa_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assignment_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      session TEXT,
      payload TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_contact ON reminders(contact_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, done);
    CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON webhook_log(received_at);

    CREATE TABLE IF NOT EXISTS auto_reply_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_value TEXT,
      response TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      attachment_url TEXT,
      attachment_filename TEXT,
      attachment_mimetype TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saved_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      wa_message_id TEXT,
      sent_at TEXT,
      UNIQUE(broadcast_id, contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_message_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_category ON contacts(category_id);
    CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_contact ON activity_log(contact_id);
    CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_waid ON broadcast_recipients(wa_message_id);
  `);

  // Migrations for existing DBs
  try { db.exec('ALTER TABLE contacts ADD COLUMN wa_chat_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE contacts ADD COLUMN profile_pic_url TEXT'); } catch {}
  try { db.exec('ALTER TABLE categories ADD COLUMN wa_label_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_url TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_type TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_filename TEXT'); } catch {}
  try { db.exec('ALTER TABLE broadcasts ADD COLUMN media_url TEXT'); } catch {}
  try { db.exec('ALTER TABLE broadcasts ADD COLUMN media_type TEXT'); } catch {}
  try { db.exec('ALTER TABLE broadcasts ADD COLUMN media_filename TEXT'); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN pipeline_stage TEXT DEFAULT 'nuevo'"); } catch {}
  try { db.exec('ALTER TABLE contacts ADD COLUMN assigned_to INTEGER'); } catch {}
  try { db.exec('ALTER TABLE contacts ADD COLUMN wa_session TEXT'); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN conv_status TEXT DEFAULT 'open'"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'"); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_content TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_wa_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE broadcasts ADD COLUMN scheduled_at TEXT'); } catch {}
  try { db.exec("ALTER TABLE broadcasts ADD COLUMN pipeline_stage TEXT"); } catch {}
  try { db.exec("ALTER TABLE broadcasts ADD COLUMN tag_id INTEGER"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN is_deleted INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN two_fa_secret TEXT"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN two_fa_enabled INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE broadcasts ADD COLUMN status TEXT DEFAULT 'completed'"); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT 'message.inbound',
      secret TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT DEFAULT 'read',
      created_by INTEGER NOT NULL,
      last_used_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6b7280',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Seed default stages if table is empty
  const stageCount = db.prepare('SELECT COUNT(*) as n FROM pipeline_stages').get().n;
  if (stageCount === 0) {
    const defaults = [
      ['nuevo',       'Nuevo',       '#6b7280', 0],
      ['contactado',  'Contactado',  '#3b82f6', 1],
      ['en_progreso', 'En progreso', '#f59e0b', 2],
      ['propuesta',   'Propuesta',   '#8b5cf6', 3],
      ['ganado',      'Ganado',      '#10b981', 4],
      ['perdido',     'Perdido',     '#ef4444', 5],
    ];
    for (const [key, label, color, sort_order] of defaults) {
      db.prepare('INSERT OR IGNORE INTO pipeline_stages (key, label, color, sort_order) VALUES (?, ?, ?, ?)').run(key, label, color, sort_order);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      keys_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      emoji TEXT DEFAULT '',
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const scriptCount = db.prepare('SELECT COUNT(*) as n FROM scripts').get().n;
  if (scriptCount === 0) {
    const seedScripts = [
      ['script', 'Opening Message', '',        '¡Hola, un placer! Aquí RinRan Music 🎵 ¿Tienes un video en YouTube que quieras promocionar, o estás buscando algo más completo? Mándame el link o cuéntame tu meta y vemos cómo se puede 🔥', 0],
      ['script', 'Trial Close', '',             'Por lo que me dices, te recomiendo el plan [NOMBRE PLAN de $PRECIO] — te da entre [RANGO]. ¿Vamos por ese o quieres ver el siguiente nivel? A la orden.', 1],
      ['script', 'Soft Close → Payment Link', '', 'Bendito sea, vamos con ese 🔥. Te mando el link de Stripe ahora mismo y arrancamos en cuanto se confirme. ¿Me pasas tu correo para el recibo?', 2],
      ['script', 'Hard Close (Hesitating)', '', 'Te entiendo, hermano. Una cosa real: para que la campaña esté lista para tu fecha necesito acordar mínimo 1 semana antes. Si me confirmas hoy te separo el slot — mañana ya no se puede garantizar. ¿Cómo lo ves?', 3],
      ['script', 'Payment Link Message', '',   'Aquí va tu link seguro de Stripe 👉 [LINK]. En cuanto se confirme, arrancamos la campaña 🔊. Cualquier duda me escribes por aquí mismo, un placer.', 4],
      ['script', 'Payment Confirmed', '',       '¡Pago confirmado! 🔥📈 Ya empezamos a trabajar tu campaña. Te mando reporte de avance en [X días]. Bienvenido a la familia RinRan 🎵, un placer.', 5],
      ['script', 'Wait Script (Escalating)', '', 'Un momento por favor — voy a conectarte directamente con Jarxiel para atenderte como mereces. Te responde en máximo 15 minutos, un placer.', 6],
      ['script', 'Follow-up #1 · 24h', '',     'Hey, un placer otra vez 🎵. Solo confirmar que el slot para tu campaña sigue disponible. ¿Cómo vas con la decisión?', 7],
      ['objection', '"Está muy caro."', '💸',  'Te entiendo, hermano. Pero mira los números: el plan POBRE de $150 te da entre 20,000 y 40,000 views — eso es bendito el costo por view más bajo del mercado. ¿Vamos con ese o quieres ver el de $300 que da 40K–80K? A la orden.', 0],
      ['objection', '"Lo pienso y te aviso."', '🤔', 'Tranquilo, un placer hablar contigo. Solo recuerda: las campañas se acuerdan mín. 1 semana antes del estreno (Google Ads) o 2 días (Externo). ¿Cuándo es tu estreno? Te separo el slot sin compromiso.', 1],
      ['objection', '"¿Hay garantías?"', '🛡️', 'Garantizamos el rango de views de cada paquete (ej. plan Estándar $1,350 te da 180K–360K). Lo que no garantizamos al 100% es retención. Pero el rango sí lo entregamos, más claro imposible.', 2],
      ['objection', '"Mi primo lo hace gratis."', '👤', 'Bien que tengas apoyo. Pero pregúntale: ¿esos views suman horas para monetizar? ¿Cuentan para tendencias? Lo nuestro es Google Ads oficial y tráfico web real — no bots — y por eso entras a charts en RD, Colombia, Panamá y más.', 3],
      ['objection', '"¿Puedo pagar a plazos?"', '📅', 'Buena pregunta — los planes de pago los maneja directamente Jarxiel. Te conecto con él ahora mismo para que vean los términos. [ESCALAR]', 4],
      ['objection', '"¿Funciona si mi video tiene contenido fuerte?"', '🎬', 'Para Google Ads necesitamos contenido limpio. Si tu video es explícito te recomiendo Tráfico Web Externo — esos views sí cuentan para tendencias y monetización, empieza desde $150 con 7,500 views. Bendito sea, igual te llega 🔥', 5],
      ['objection', '"¿En qué países trabajan?"', '🌎', 'Latinoamérica completa: RD 🇩🇴, México 🇲🇽, Colombia 🇨🇴, Chile 🇨🇱, Panamá 🇵🇦, Honduras 🇭🇳, El Salvador 🇸🇻 y más. Tú eliges los países objetivo y nosotros segmentamos.', 6],
      ['objection', '"¿Cuánto demora ver resultados?"', '⏱️', 'Charts: el día acordado. Suscriptores: 1 semana / cada 1,000. Monetización 4,000h: aprox 20 días. RIAA Gold: 3 a 9 meses. Las campañas de views empiezan el día que acordamos.', 7],
      ['objection', '"¿Puedes manejar varios artistas?" (Manager)', '🎯', 'Sí, manejamos managers con 1 a 5 artistas simultáneamente. Eso ya entra en modelo MENSUAL — te conecto con Jarxiel para armar el retainer a tu medida. [ESCALAR]', 8],
      ['objection', '"Tengo un podcast/programa, ¿también?"', '🎙️', 'Claro, trabajamos con plataformas multimedia, podcasts y streamers que quieren subir suscriptores. Eso es modelo MENSUAL desde $3,000. Te conecto con Jarxiel. [ESCALAR]', 9],
      ['do', 'PIDE el link del video de YouTube ANTES de cotizar.', '', '', 0],
      ['do', 'PREGUNTA si es contenido limpio o explícito.', '', '', 1],
      ['do', 'IDENTIFICA el perfil: Artista / Manager / Multimedia.', '', '', 2],
      ['do', 'CONFIRMA si quiere campaña única o mensual.', '', '', 3],
      ['do', 'AVISA mín. 1 semana antes del estreno (Google Ads) o 2 días (Externo).', '', '', 4],
      ['do', 'RECUERDA que el video de 4K horas NO se borra.', '', '', 5],
      ['do', 'SUGIERE Luminate cuando hablen de Disco de Oro.', '', '', 6],
      ['do', 'CIERRA con "un placer" o "a la orden". Todo positivo.', '', '', 7],
      ['dont', 'NO prometer Disco de Oro garantizado — solo estrategia.', '', '', 0],
      ['dont', 'NO prometer # exacto de views — solo el RANGO.', '', '', 1],
      ['dont', 'NO ofrecer Google Ads para videos explícitos.', '', '', 2],
      ['dont', 'NO cotizar mensualidades sin Jarxiel.', '', '', 3],
      ['dont', 'NO dar descuentos > 10% sin aprobación.', '', '', 4],
      ['dont', 'NO decir que el video de 4,000h se puede BORRAR.', '', '', 5],
      ['dont', 'NO discutir reembolsos ni temas legales — escalar.', '', '', 6],
      ['dont', 'NO usar "maldito" ni lenguaje negativo — NUNCA, ni en broma.', '', '', 7],
    ];
    for (const [category, title, emoji, content, sort_order] of seedScripts) {
      db.prepare('INSERT INTO scripts (category, title, emoji, content, sort_order) VALUES (?, ?, ?, ?, ?)').run(category, title, emoji, content, sort_order);
    }
    console.log('[db] Scripts seeded with default RinRan content');
  }

  const existingCats = db.prepare('SELECT COUNT(*) as n FROM categories').get();
  if (existingCats.n === 0) {
    db.prepare("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)").run('Lead', '#f59e0b');
    db.prepare("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)").run('Cliente', '#10b981');
    db.prepare("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)").run('VIP', '#8b5cf6');
    db.prepare("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)").run('Inactivo', '#6b7280');
  }

  const existingUsers = db.prepare('SELECT COUNT(*) as n FROM users').get();
  if (existingUsers.n === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@rinran.com';
    // Never seed a known default password. If ADMIN_PASSWORD is unset, generate a strong
    // random one and print it once so the operator can log in and change it.
    let password = process.env.ADMIN_PASSWORD;
    const generated = !password;
    if (generated) password = require('crypto').randomBytes(12).toString('base64url');
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)").run(email, hash, 'Admin');
    console.log(`[db] Admin user created: ${email}`);
    if (generated) {
      console.log(`[db] ⚠ Generated random admin password (set ADMIN_PASSWORD to control it): ${password}`);
    }
  }

  // Encrypt any pre-existing plaintext secrets at rest (idempotent).
  migrateExistingSecrets(db);
}

// Close the cached handle (used by the DB-restore flow before swapping the file).
function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

module.exports = { getDb, closeDb, DB_PATH };
