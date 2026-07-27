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
      last_greeted_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      wa_msg_id  TEXT UNIQUE,
      wa_id      TEXT NOT NULL REFERENCES contacts(wa_id) ON DELETE CASCADE,
      dir        TEXT NOT NULL,
      type       TEXT,
      body       TEXT,
      status     TEXT,
      ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  `);
  console.log("DB schema ready (Postgres).");
}

export async function upsertContact(waId, name) {
  if (!waId) return;
  if (pool) {
    await pool.query(
      `INSERT INTO contacts (wa_id, name) VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET
         name = COALESCE(NULLIF(EXCLUDED.name,''), contacts.name),
         updated_at = now()`,
      [waId, name || null]
    );
  } else {
    const c = mem.contacts[waId] || (mem.contacts[waId] = { wa_id: waId, name: waId, booked: false, human_control: false, updated: Date.now(), messages: [] });
    if (name) c.name = name;
  }
}

// msg: { wa_msg_id, dir, type, body, status, ts(ms) }
export async function addMessage(waId, msg, name) {
  if (!waId) return;
  await upsertContact(waId, name);
  if (pool) {
    await pool.query(
      `INSERT INTO messages (wa_msg_id, wa_id, dir, type, body, status, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (wa_msg_id) DO NOTHING`,
      [msg.wa_msg_id || null, waId, msg.dir, msg.type || null, msg.body || "", msg.status || null,
       msg.ts ? new Date(msg.ts) : new Date()]
    );
    await pool.query(`UPDATE contacts SET updated_at = now() WHERE wa_id = $1`, [waId]);
  } else {
    const c = mem.contacts[waId];
    c.messages.push({ id: msg.wa_msg_id, dir: msg.dir, type: msg.type, text: msg.body, ts: msg.ts || Date.now(), status: msg.status });
    c.updated = Date.now();
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
      `SELECT wa_id, name, booked, human_control,
              EXTRACT(EPOCH FROM updated_at)*1000 AS updated
       FROM contacts ORDER BY updated_at DESC`
    );
    const out = [];
    for (const c of cs) {
      const { rows: ms } = await pool.query(
        `SELECT wa_msg_id, dir, type, body, status,
                EXTRACT(EPOCH FROM ts)*1000 AS ts
         FROM messages WHERE wa_id = $1 ORDER BY ts ASC`,
        [c.wa_id]
      );
      out.push({
        waId: c.wa_id,
        name: c.name || c.wa_id,
        booked: c.booked,
        humanControl: c.human_control,
        updated: Number(c.updated),
        messages: ms.map(m => ({ id: m.wa_msg_id, dir: m.dir, type: m.type, text: m.body, ts: Number(m.ts), status: m.status }))
      });
    }
    return out;
  } else {
    return Object.values(mem.contacts)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .map(c => ({ waId: c.wa_id, name: c.name, booked: c.booked, humanControl: c.human_control, updated: c.updated, messages: c.messages }));
  }
}

export async function setContactFlag(waId, field, value) {
  if (!["booked", "human_control"].includes(field)) return;
  if (pool) {
    await pool.query(`UPDATE contacts SET ${field} = $2, updated_at = now() WHERE wa_id = $1`, [waId, value]);
  } else if (mem.contacts[waId]) {
    mem.contacts[waId][field] = value;
  }
}
