// Mukesh Medical - WhatsApp Coexistence dashboard (Postgres-backed).
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, addMessage, updateStatus, getConversations, setContactFlag, dbEnabled } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ---- Config (from environment) ----
const PORT           = process.env.PORT || 3000;
const APP_ID         = process.env.APP_ID || "1039310715202655";
const CONFIG_ID      = process.env.CONFIG_ID || "1403795661596400";
const GRAPH_VERSION  = process.env.GRAPH_VERSION || "v21.0";
const APP_SECRET     = process.env.APP_SECRET || "";
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN || "mukeshmedical_verify";
let ACCESS_TOKEN     = process.env.ACCESS_TOKEN || "";
let PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID || "";
let WABA_ID          = process.env.WABA_ID || "";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---- Public config for the frontend (no secrets) ----
app.get("/config", (req, res) => {
  res.json({
    appId: APP_ID, configId: CONFIG_ID, graphVersion: GRAPH_VERSION,
    connected: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID),
    persistent: dbEnabled,
    phoneNumberId: PHONE_NUMBER_ID || null, wabaId: WABA_ID || null
  });
});

// ---- Webhook verification ----
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

// ---- Webhook receiver ----
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ack fast
  try {
    for (const e of (req.body.entry || [])) {
      for (const ch of (e.changes || [])) {
        const v = ch.value || {};
        const contacts = v.contacts || [];
        const nameFor = (waId) => (contacts.find(c => c.wa_id === waId)?.profile?.name) || waId;

        for (const m of (v.messages || [])) {
          const body = m.text?.body || (m.type ? `[${m.type}]` : "[message]");
          await addMessage(m.from, { wa_msg_id: m.id, dir: "in", type: m.type, body, ts: Number(m.timestamp) * 1000 || Date.now() }, nameFor(m.from));
          console.log(`IN  ${m.from}: ${body}`);
        }
        // Replies sent from the WhatsApp Business app on the phone (coexistence echoes)
        for (const m of (v.message_echoes || v.smb_message_echoes || [])) {
          const body = m.text?.body || (m.type ? `[${m.type}]` : "[message]");
          const cust = m.to || m.recipient_id;
          await addMessage(cust, { wa_msg_id: m.id, dir: "out", type: m.type, body, ts: Number(m.timestamp) * 1000 || Date.now(), status: "sent" }, nameFor(cust));
          console.log(`ECHO ${cust}: ${body}`);
        }
        for (const s of (v.statuses || [])) {
          await updateStatus(s.id, s.status);
        }
      }
    }
  } catch (err) { console.error("webhook err", err); }
});

// ---- List conversations ----
app.get("/api/messages", async (req, res) => {
  try {
    const conversations = await getConversations();
    res.json({ connected: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID), persistent: dbEnabled, conversations });
  } catch (err) { console.error("messages err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Toggle booked / human_control on a conversation ----
app.post("/api/contact/:waId/flag", async (req, res) => {
  const { field, value } = req.body || {};
  try { await setContactFlag(req.params.waId, field, Boolean(value)); res.json({ ok: true }); }
  catch (err) { console.error("flag err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Send a reply ----
app.post("/api/send", async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "to and text required" });
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) return res.status(400).json({ error: "Not connected yet." });
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
    });
    const data = await r.json();
    if (!r.ok) { console.error("send err", data); return res.status(r.status).json(data); }
    await addMessage(to, { wa_msg_id: data.messages?.[0]?.id, dir: "out", type: "text", body: text, ts: Date.now(), status: "sent" });
    res.json({ ok: true, data });
  } catch (err) { console.error(err); res.status(500).json({ error: String(err) }); }
});

// ---- Embedded Signup callback (kept for completeness) ----
app.post("/api/session", async (req, res) => {
  const { code, phone_number_id, waba_id } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  if (!APP_SECRET) return res.status(500).json({ error: "APP_SECRET not set." });
  try {
    const tokenUrl = `${GRAPH}/oauth/access_token?client_id=${APP_ID}&client_secret=${encodeURIComponent(APP_SECRET)}&code=${encodeURIComponent(code)}`;
    const tr = await fetch(tokenUrl); const tdata = await tr.json();
    if (!tr.ok || !tdata.access_token) return res.status(400).json({ error: "token exchange failed", detail: tdata });
    ACCESS_TOKEN = tdata.access_token;
    if (phone_number_id) PHONE_NUMBER_ID = phone_number_id;
    if (waba_id) WABA_ID = waba_id;
    if (WABA_ID) await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, { method: "POST", headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` } });
    res.json({ ok: true, phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID });
  } catch (err) { console.error(err); res.status(500).json({ error: String(err) }); }
});

app.get("/privacy", (req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy Policy — Mukesh Medical</title><style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#111}h1{color:#075E54}</style></head><body>
  <h1>Privacy Policy — Mukesh Medical</h1>
  <p><em>Last updated: ${new Date().toISOString().slice(0,10)}</em></p>
  <p>Mukesh Medical ("we", "us") operates a WhatsApp-based customer messaging service. This policy explains how we handle information when you message us on WhatsApp.</p>
  <h2>Information we collect</h2>
  <p>When you contact us on WhatsApp, we receive your WhatsApp phone number, your WhatsApp profile name, and the content of the messages you send us. We use this solely to respond to your enquiries and provide customer service.</p>
  <h2>How we use it</h2>
  <p>We use your information only to communicate with you, answer questions, take orders, and provide support. We do not sell your information.</p>
  <h2>Sharing</h2>
  <p>Your messages are processed through Meta's WhatsApp Business Platform in accordance with Meta's terms. We do not share your information with third parties except as required to deliver our service or by law.</p>
  <h2>Data retention</h2>
  <p>We retain conversation history only as long as needed to serve you. You may ask us to delete your data at any time by messaging us.</p>
  <h2>Contact</h2>
  <p>For any privacy questions or data-deletion requests, message us on WhatsApp at +91 9390327200 or email yashagencies9595@gmail.com.</p>
  </body></html>`);
});

// ---- Auto-wire: discover phone_number_id + subscribe webhook ----
async function autoWire() {
  if (!ACCESS_TOKEN || !WABA_ID) return { ok: false, reason: "ACCESS_TOKEN and WABA_ID required" };
  try {
    if (!PHONE_NUMBER_ID) {
      const r = await fetch(`${GRAPH}/${WABA_ID}/phone_numbers?access_token=${encodeURIComponent(ACCESS_TOKEN)}`);
      const d = await r.json();
      if (!r.ok) { console.error("phone_numbers err", d); return { ok: false, detail: d }; }
      const num = (d.data && d.data[0]) || null;
      if (num) { PHONE_NUMBER_ID = num.id; console.log("Discovered phone_number_id:", PHONE_NUMBER_ID, "(", num.display_phone_number, ")"); }
    }
    const sr = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, { method: "POST", headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` } });
    console.log("subscribed_apps:", sr.status, await sr.text());
    return { ok: true, phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID };
  } catch (e) { console.error("autoWire err", e); return { ok: false, error: String(e) }; }
}
app.get("/api/wire", async (req, res) => res.json(await autoWire()));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

(async () => {
  try { await initDb(); } catch (e) { console.error("initDb err", e); }
  app.listen(PORT, async () => {
    console.log(`Mukesh Medical app listening on :${PORT} (persistent=${dbEnabled})`);
    console.log("autoWire:", JSON.stringify(await autoWire()));
  });
})();
