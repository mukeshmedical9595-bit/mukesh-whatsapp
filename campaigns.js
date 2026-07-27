// Mukesh Medical - bulk promotional/marketing campaign sender.
//
// MARKETING_OPT_IN (read this before using sendCampaign for promo_generic
// or any other MARKETING-category template):
//   WhatsApp marketing templates may ONLY be sent to customers who have
//   explicitly opted in to receive promotional messages from Mukesh
//   Medical - for example, they replied "YES" to a consent prompt, ticked
//   an opt-in box on a signup/order form, or asked in person to be added to
//   offers. Sending marketing templates to people who have not opted in
//   violates WhatsApp Business Policy and risks the phone number being
//   restricted, rate-limited, or permanently banned by Meta.
//
//   This module does not itself track a per-contact "opted_in" flag,
//   because the shared `contacts` table (owned by db.js) does not have one
//   and this module must not edit existing files. It is the CALLER's
//   responsibility to only pass in recipients who have opted in. As a
//   safety net, sendCampaign() still automatically skips:
//     - any wa_id flagged spam = true in the existing contacts table
//     - any wa_id present in the campaign_optouts table (see recordOptOut)
//
// This file is self-contained: it reuses the exported `pool` from db.js
// (falls back to an in-memory store if DATABASE_URL / pool is not set) and
// the sendTemplate() helper from templates.js. It does not edit either file.

import { pool } from "./db.js";
import { sendTemplate } from "./templates.js";

// Small delay between sends so we don't hammer the Graph API / trip rate limits.
const SEND_DELAY_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- In-memory fallback (used only when DATABASE_URL / pool is not set) ----
const mem = { campaigns: [], recipients: [], optouts: new Set() };
let memCampaignSeq = 1;
let memRecipientSeq = 1;

// ---- Schema ----
// Creates the campaigns + campaign_recipients + campaign_optouts tables if
// they don't already exist. Called automatically by sendCampaign(), but you
// can also call it once at app startup if you want the tables ready early.
export async function initCampaignsDb() {
  if (!pool) {
    console.warn("DATABASE_URL not set - campaigns will run WITHOUT persistence (in-memory).");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id            BIGSERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      template_name TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      status        TEXT NOT NULL DEFAULT 'running'
    );
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id          BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      wa_id       TEXT NOT NULL,
      name        TEXT,
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
      error       TEXT,
      sent_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id);
    -- Lightweight opt-out registry: wa_ids that must NEVER receive marketing
    -- templates again (e.g. they replied STOP). Nothing in the existing
    -- webhook handler (server.js) writes to this table yet - if you later
    -- want STOP replies captured automatically, add a call to
    -- recordOptOut(m.from) inside the incoming-message loop in server.js
    -- when m.text.body trims/uppercases to "STOP".
    CREATE TABLE IF NOT EXISTS campaign_optouts (
      wa_id      TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("Campaigns DB schema ready (Postgres).");
}

/** Mark a wa_id as opted out of future marketing campaigns (e.g. they sent STOP). */
export async function recordOptOut(waId) {
  if (!waId) return;
  if (pool) {
    await pool.query(`INSERT INTO campaign_optouts (wa_id) VALUES ($1) ON CONFLICT DO NOTHING`, [waId]);
  } else {
    mem.optouts.add(waId);
  }
}

async function isOptedOut(waId) {
  if (pool) {
    const { rows } = await pool.query(`SELECT 1 FROM campaign_optouts WHERE wa_id = $1`, [waId]);
    return rows.length > 0;
  }
  return mem.optouts.has(waId);
}

// Checks the existing contacts table (owned by db.js) for the spam flag.
// Read-only - never writes to contacts.
async function isSpamFlagged(waId) {
  if (!pool) return false; // no shared contacts store available without a DB
  try {
    const { rows } = await pool.query(`SELECT spam FROM contacts WHERE wa_id = $1`, [waId]);
    return Boolean(rows[0]?.spam);
  } catch (err) {
    console.error("isSpamFlagged err", err);
    return false;
  }
}

async function createCampaign(name, templateName) {
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO campaigns (name, template_name, status) VALUES ($1, $2, 'running') RETURNING id`,
      [name, templateName]
    );
    return rows[0].id;
  }
  const id = memCampaignSeq++;
  mem.campaigns.push({ id, name, template_name: templateName, created_at: new Date(), status: "running" });
  return id;
}

async function finishCampaign(campaignId, status) {
  if (pool) {
    await pool.query(`UPDATE campaigns SET status = $2 WHERE id = $1`, [campaignId, status]);
  } else {
    const c = mem.campaigns.find((x) => x.id === campaignId);
    if (c) c.status = status;
  }
}

async function recordRecipient(campaignId, waId, name, status, error, sentAt) {
  if (pool) {
    await pool.query(
      `INSERT INTO campaign_recipients (campaign_id, wa_id, name, status, error, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [campaignId, waId, name || null, status, error ? String(error).slice(0, 500) : null, sentAt || null]
    );
  } else {
    mem.recipients.push({
      id: memRecipientSeq++,
      campaign_id: campaignId,
      wa_id: waId,
      name,
      status,
      error,
      sent_at: sentAt
    });
  }
}

/**
 * Send a bulk template campaign to a list of recipients.
 *
 * @param {object} opts
 * @param {string} opts.name - human-readable campaign name (e.g. "Monsoon offer")
 * @param {string} opts.templateName - exact Meta-approved template name (e.g. "promo_generic")
 * @param {string} [opts.langCode="en"] - template language code
 * @param {Array<{waId:string, name?:string, params?: Array<string|number>}>} opts.recipients
 *   `params` should match the {{1}}, {{2}}, ... order for the given template.
 * @returns {Promise<{total:number, sent:number, failed:number, skipped:number, campaignId:(number|null)}>}
 *
 * Remember: if templateName is a MARKETING-category template, `recipients`
 * must only contain contacts who have opted in. See MARKETING_OPT_IN above.
 */
export async function sendCampaign({ name, templateName, langCode = "en", recipients = [] }) {
  if (!templateName) throw new Error("sendCampaign: templateName is required.");
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { total: 0, sent: 0, failed: 0, skipped: 0, campaignId: null };
  }

  try {
    await initCampaignsDb();
  } catch (err) {
    console.error("initCampaignsDb err", err);
  }

  const campaignId = await createCampaign(name || templateName, templateName);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of recipients) {
    const waId = r?.waId;
    if (!waId) {
      skipped++;
      continue;
    }

    const [spam, optedOut] = await Promise.all([isSpamFlagged(waId), isOptedOut(waId)]);
    if (spam || optedOut) {
      skipped++;
      await recordRecipient(campaignId, waId, r.name, "skipped", spam ? "spam-flagged" : "opted-out", null);
      continue; // no delay needed - we didn't call the Graph API
    }

    const result = await sendTemplate(waId, templateName, langCode, r.params || []);
    if (result.ok) {
      sent++;
      await recordRecipient(campaignId, waId, r.name, "sent", null, new Date());
    } else {
      failed++;
      await recordRecipient(campaignId, waId, r.name, "failed", JSON.stringify(result.error), null);
    }

    await sleep(SEND_DELAY_MS);
  }

  await finishCampaign(campaignId, "done");

  return { total: recipients.length, sent, failed, skipped, campaignId };
}
