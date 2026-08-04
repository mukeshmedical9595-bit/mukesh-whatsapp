// Mukesh Medical - persistence layer.
// Uses Postgres (Neon) when DATABASE_URL is set; otherwise falls back to an
// in-memory store so the app keeps working during setup (not persistent).
import pg from "pg";
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || "";
export const pool = connectionString
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;
export const dbEnabled = Boolean(pool);

// ---- Fallback in-memory store (used only when no DATABASE_URL) ----
const mem = { contacts: {} }; // { wa_id: { wa_id, name, booked, human_control, updated, messages:[] } }

export async function initDb() {
  if (!pool) { console.warn("DATABASE_URL not set - running WITHOUT persistence (in-memory)."); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      wa_id           TEXT PRIMARY KEY,
      name            TEXT,
      booked          BOOLEAN NOT NULL DEFAULT FALSE,
      human_control   BOOLEAN NOT NULL DEFAULT FALSE,
      spam            BOOLEAN NOT NULL DEFAULT FALSE,
      note            TEXT,
      address         TEXT,
      needs_human     BOOLEAN NOT NULL DEFAULT FALSE,
      mukcare_paused_until TIMESTAMPTZ,
      last_greeted_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- add columns for databases created before these fields existed
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS spam BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS needs_human BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mukcare_paused_until TIMESTAMPTZ;
    -- KYC / location / list-management fields (idempotent, safe to re-run).
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS name_confirmed  BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_profile_name TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_lat    DOUBLE PRECISION;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_lng    DOUBLE PRECISION;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS alternate_number TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS default_patient TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS archived        BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS unread          BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS non_order_count INT NOT NULL DEFAULT 0;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'whatsapp';
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_whatsapp BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted         BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      wa_msg_id  TEXT UNIQUE,
      wa_id      TEXT NOT NULL REFERENCES contacts(wa_id) ON DELETE CASCADE,
      dir        TEXT NOT NULL,
      type       TEXT,
      body       TEXT,
      status     TEXT,
      bot        BOOLEAN NOT NULL DEFAULT FALSE,
      media_id   BIGINT,
      ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS bot BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id BIGINT;
    CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    -- Prescription images / documents sent by customers, stored with us (cloud).
    CREATE TABLE IF NOT EXISTS media (
      id         BIGSERIAL PRIMARY KEY,
      wa_id      TEXT,
      wa_msg_id  TEXT,
      mime       TEXT,
      data       BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- simple key/value store for app settings (e.g. Train MUKCARE instructions)
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("DB schema ready (Postgres).");
}

export async function upsertContact(waId, name) {
  if (!waId) return;
  if (pool) {
    // Prefer an existing name (which may be the patient name the customer gave
    // us, or an agent edit) over the WhatsApp profile name. Only seed from the
    // incoming profile name when we don't have a name yet.
    await pool.query(
      `INSERT INTO contacts (wa_id, name) VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET
         name = COALESCE(NULLIF(contacts.name,''), NULLIF(EXCLUDED.name,'')),
         updated_at = now()`,
      [waId, name || null]
    );
  } else {
    const c = mem.contacts[waId] || (mem.contacts[waId] = { wa_id: waId, name: waId, booked: false, human_control: false, spam: false, note: null, address: null, needs_human: false, mukcare_paused_until: null, name_confirmed: false, wa_profile_name: null, location_lat: null, location_lng: null, alternate_number: null, default_patient: null, archived: false, unread: false, non_order_count: 0, source: "whatsapp", consent_whatsapp: true, deleted: false, updated: Date.now(), messages: [] });
    if (name && (!c.name || c.name === c.wa_id)) c.name = name; // seed only, don't overwrite a set name
  }
}

// msg: { wa_msg_id, dir, type, body, status, ts(ms) }
// Returns { inserted } - false if this wa_msg_id was already stored (webhook retry).
export async function addMessage(waId, msg, name) {
  if (!waId) return { inserted: false };
  await upsertContact(waId, name);
  if (pool) {
    const r = await pool.query(
      `INSERT INTO messages (wa_msg_id, wa_id, dir, type, body, status, bot, media_id, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (wa_msg_id) DO NOTHING`,
      [msg.wa_msg_id || null, waId, msg.dir, msg.type || null, msg.body || "", msg.status || null,
       Boolean(msg.bot), msg.media_id || null, msg.ts ? new Date(msg.ts) : new Date()]
    );
    await pool.query(`UPDATE contacts SET updated_at = now() WHERE wa_id = $1`, [waId]);
    return { inserted: r.rowCount > 0 };
  } else {
    const c = mem.contacts[waId];
    if (msg.wa_msg_id && c.messages.some(x => x.id === msg.wa_msg_id)) return { inserted: false };
    c.messages.push({ id: msg.wa_msg_id, dir: msg.dir, type: msg.type, text: msg.body, ts: msg.ts || Date.now(), status: msg.status, bot: Boolean(msg.bot), mediaId: msg.media_id || null });
    c.updated = Date.now();
    return { inserted: true };
  }
}

export async function updateStatus(waMsgId, status) {
  if (!waMsgId) return;
  if (pool) {
    await pool.query(`UPDATE messages SET status = $2 WHERE wa_msg_id = $1`, [waMsgId, status]);
  } else {
    for (const c of Object.values(mem.contacts)) {
      const m = c.messages.find(x => x.id === waMsgId);
      if (m) { m.status = status; break; }
    }
  }
}

// Returns conversations in the shape the current frontend expects:
// [{ waId, name, booked, humanControl, messages:[{id,dir,type,text,ts(ms),status}] }]
export async function getConversations() {
  if (pool) {
    const { rows: cs } = await pool.query(
      `SELECT wa_id, name, booked, human_control, spam, note, address, needs_human, archived, unread,
              EXTRACT(EPOCH FROM mukcare_paused_until)*1000 AS mukcare_paused_until,
              EXTRACT(EPOCH FROM created_at)*1000 AS created,
              EXTRACT(EPOCH FROM updated_at)*1000 AS updated
       FROM contacts ORDER BY updated_at DESC`
    );
    const out = [];
    for (const c of cs) {
      const { rows: ms } = await pool.query(
        `SELECT wa_msg_id, dir, type, body, status, bot, media_id,
                EXTRACT(EPOCH FROM ts)*1000 AS ts
         FROM messages WHERE wa_id = $1 ORDER BY ts ASC`,
        [c.wa_id]
      );
      out.push({
        waId: c.wa_id,
        name: c.name || c.wa_id,
        booked: c.booked,
        humanControl: c.human_control,
        spam: c.spam,
        note: c.note || "",
        address: c.address || "",
        needsHuman: c.needs_human,
        archived: c.archived, unread: c.unread,
        pausedUntil: c.mukcare_paused_until ? Number(c.mukcare_paused_until) : null,
        created: Number(c.created),
        updated: Number(c.updated),
        messages: ms.map(m => ({ id: m.wa_msg_id, dir: m.dir, type: m.type, text: m.body, ts: Number(m.ts), status: m.status, bot: m.bot, mediaId: m.media_id }))
      });
    }
    return out;
  } else {
    return Object.values(mem.contacts)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .map(c => ({ waId: c.wa_id, name: c.name, booked: c.booked, humanControl: c.human_control, spam: c.spam, note: c.note || "", address: c.address || "", needsHuman: c.needs_human, archived: c.archived, unread: c.unread, pausedUntil: c.mukcare_paused_until || null, created: c.created || c.updated, updated: c.updated, messages: c.messages }));
  }
}

export async function setContactFlag(waId, field, value) {
  if (!["booked", "human_control", "spam", "needs_human", "archived", "unread"].includes(field)) return;
  if (pool) {
    await pool.query(`UPDATE contacts SET ${field} = $2, updated_at = now() WHERE wa_id = $1`, [waId, value]);
  } else if (mem.contacts[waId]) {
    mem.contacts[waId][field] = value;
  }
}

// Spam guard: bump the consecutive non-order message counter, or reset it to 0.
// Returns the new count so the caller can auto-flag spam past a threshold.
export async function bumpNonOrderCount(waId, reset = false) {
  if (!waId) return 0;
  if (pool) {
    const { rows } = await pool.query(
      reset
        ? `UPDATE contacts SET non_order_count = 0, updated_at = now() WHERE wa_id = $1 RETURNING non_order_count`
        : `UPDATE contacts SET non_order_count = non_order_count + 1, updated_at = now() WHERE wa_id = $1 RETURNING non_order_count`,
      [waId]
    );
    return rows[0]?.non_order_count || 0;
  } else if (mem.contacts[waId]) {
    mem.contacts[waId].non_order_count = reset ? 0 : (mem.contacts[waId].non_order_count || 0) + 1;
    return mem.contacts[waId].non_order_count;
  }
  return 0;
}

// Read several settings at once: getSettings(["upi_id","payment_qr_media_id"]) -> {key:value}.
export async function getSettings(keys = []) {
  const out = {};
  for (const k of keys) { try { out[k] = await getSetting(k); } catch { out[k] = null; } }
  return out;
}

// Pause (or resume) MUKCARE's auto-replies on a single chat.
// untilMs = epoch ms to pause until, or null to resume immediately.
export async function setMukcarePause(waId, untilMs) {
  if (!waId) return;
  if (pool) {
    await pool.query(
      `UPDATE contacts SET mukcare_paused_until = $2, updated_at = now() WHERE wa_id = $1`,
      [waId, untilMs ? new Date(untilMs).toISOString() : null]
    );
  } else if (mem.contacts[waId]) {
    mem.contacts[waId].mukcare_paused_until = untilMs || null;
  }
}

// Update editable profile fields. Accepts: name, note, address, locationLat,
// locationLng, alternateNumber, nameConfirmed, defaultPatient, source,
// archived, unread. Only provided (non-undefined) fields are changed.
export async function updateContact(waId, fields) {
  if (!waId || !fields) return;
  const f = fields;
  if (pool) {
    await pool.query(
      `UPDATE contacts SET
         name             = COALESCE($2, name),
         note             = COALESCE($3, note),
         address          = COALESCE($4, address),
         location_lat     = COALESCE($5, location_lat),
         location_lng     = COALESCE($6, location_lng),
         alternate_number = COALESCE($7, alternate_number),
         name_confirmed   = COALESCE($8, name_confirmed),
         default_patient  = COALESCE($9, default_patient),
         source           = COALESCE($10, source),
         archived         = COALESCE($11, archived),
         unread           = COALESCE($12, unread),
         updated_at = now()
       WHERE wa_id = $1`,
      [waId, f.name ?? null, f.note ?? null, f.address ?? null,
       f.locationLat ?? null, f.locationLng ?? null, f.alternateNumber ?? null,
       f.nameConfirmed ?? null, f.defaultPatient ?? null, f.source ?? null,
       f.archived ?? null, f.unread ?? null]
    );
  } else if (mem.contacts[waId]) {
    const c = mem.contacts[waId];
    if (f.name != null) c.name = f.name;
    if (f.note != null) c.note = f.note;
    if (f.address != null) c.address = f.address;
    if (f.locationLat != null) c.location_lat = f.locationLat;
    if (f.locationLng != null) c.location_lng = f.locationLng;
    if (f.alternateNumber != null) c.alternate_number = f.alternateNumber;
    if (f.nameConfirmed != null) c.name_confirmed = f.nameConfirmed;
    if (f.defaultPatient != null) c.default_patient = f.defaultPatient;
    if (f.source != null) c.source = f.source;
    if (f.archived != null) c.archived = f.archived;
    if (f.unread != null) c.unread = f.unread;
  }
}

// Customer database: list all contacts (no messages) for the Customers tab.
export async function listContacts() {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT wa_id, name, address, note, booked, spam,
              EXTRACT(EPOCH FROM created_at)*1000 AS created,
              EXTRACT(EPOCH FROM updated_at)*1000 AS updated
       FROM contacts ORDER BY updated_at DESC`
    );
    return rows.map(c => ({ waId: c.wa_id, name: c.name || c.wa_id, phone: c.wa_id, address: c.address || "", note: c.note || "", booked: c.booked, spam: c.spam, created: Number(c.created), updated: Number(c.updated) }));
  }
  return Object.values(mem.contacts).sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .map(c => ({ waId: c.wa_id, name: c.name, phone: c.wa_id, address: c.address || "", note: c.note || "", booked: c.booked, spam: c.spam }));
}

// Manually create/update a customer record (walk-in / phone). Keyed by phone.
export async function createCustomer({ phone, name, address, note }) {
  const waId = String(phone || "").replace(/\D/g, "");
  if (!waId) throw new Error("phone required");
  await upsertContact(waId, name);
  await updateContact(waId, { name, address, note });
  return { waId, phone: waId, name, address, note };
}

// Delete a customer and their messages (cascades). Operated by staff from the UI.
export async function deleteContact(waId) {
  if (!waId) return;
  if (pool) { await pool.query(`DELETE FROM contacts WHERE wa_id = $1`, [waId]); }
  else { delete mem.contacts[waId]; }
}

// Most recent image (e.g. prescription) sent by a customer - for the order detail view.
export async function getLatestImageMediaId(waId) {
  if (!waId) return null;
  if (pool) {
    const { rows } = await pool.query(
      `SELECT media_id FROM messages WHERE wa_id=$1 AND type='image' AND media_id IS NOT NULL ORDER BY ts DESC LIMIT 1`,
      [waId]
    );
    return rows[0]?.media_id || null;
  }
  const c = mem.contacts[waId]; if (!c) return null;
  const imgs = c.messages.filter(m => m.type === "image" && m.mediaId);
  return imgs.length ? imgs[imgs.length - 1].mediaId : null;
}

// Fetch a single conversation (flags + full message history) for the AI.
export async function getConversation(waId) {
  if (!waId) return null;
  if (pool) {
    const { rows: cs } = await pool.query(
      `SELECT wa_id, name, booked, human_control, spam, note, address, needs_human,
              name_confirmed, location_lat, location_lng, non_order_count,
              EXTRACT(EPOCH FROM mukcare_paused_until)*1000 AS mukcare_paused_until
       FROM contacts WHERE wa_id = $1`,
      [waId]
    );
    if (!cs[0]) return null;
    const c = cs[0];
    const { rows: ms } = await pool.query(
      `SELECT dir, type, body, status, bot, media_id, EXTRACT(EPOCH FROM ts)*1000 AS ts
       FROM messages WHERE wa_id = $1 ORDER BY ts ASC`,
      [waId]
    );
    return {
      waId: c.wa_id, name: c.name || c.wa_id,
      booked: c.booked, humanControl: c.human_control, spam: c.spam, note: c.note || "", address: c.address || "", needsHuman: c.needs_human,
      nameConfirmed: c.name_confirmed, locationLat: c.location_lat, locationLng: c.location_lng, nonOrderCount: c.non_order_count || 0,
      pausedUntil: c.mukcare_paused_until ? Number(c.mukcare_paused_until) : null,
      messages: ms.map(m => ({ dir: m.dir, type: m.type, text: m.body, ts: Number(m.ts), status: m.status, bot: m.bot, mediaId: m.media_id }))
    };
  }
  const c = mem.contacts[waId];
  if (!c) return null;
  return { waId: c.wa_id, name: c.name, booked: c.booked, humanControl: c.human_control, spam: c.spam, note: c.note || "", address: c.address || "", needsHuman: c.needs_human, nameConfirmed: c.name_confirmed, locationLat: c.location_lat, locationLng: c.location_lng, nonOrderCount: c.non_order_count || 0, pausedUntil: c.mukcare_paused_until || null, messages: c.messages };
}

// ---- Media (prescription images/documents) ----
const memMedia = {}; let memMediaSeq = 1;
export async function saveMedia({ waId, waMsgId, mime, buffer }) {
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO media (wa_id, wa_msg_id, mime, data) VALUES ($1,$2,$3,$4) RETURNING id`,
      [waId || null, waMsgId || null, mime || "application/octet-stream", buffer]
    );
    return rows[0].id;
  }
  const id = memMediaSeq++;
  memMedia[id] = { mime: mime || "application/octet-stream", data: buffer };
  return id;
}
export async function getMedia(id) {
  if (pool) {
    const { rows } = await pool.query(`SELECT mime, data FROM media WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return memMedia[id] || null;
}

// ---- Settings (key/value) ----
const memSettings = {};
export async function getSetting(key) {
  if (pool) {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
    return rows[0]?.value ?? "";
  }
  return memSettings[key] ?? "";
}
export async function setSetting(key, value) {
  if (pool) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value ?? ""]
    );
  } else {
    memSettings[key] = value ?? "";
  }
}
