// Mukesh Medical - WhatsApp Coexistence + Customer Reply Dashboard
// Single-file Node/Express server. Works on Render, Railway, Fly, or any Node host.
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ---- Config (from environment) ----
const PORT           = process.env.PORT || 3000;
const APP_ID         = process.env.APP_ID || "1039310715202655";
const CONFIG_ID      = process.env.CONFIG_ID || "1403795661596400";
const GRAPH_VERSION  = process.env.GRAPH_VERSION || "v21.0";
const APP_SECRET     = process.env.APP_SECRET || "";        // set in host env vars ONLY
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN || "mukeshmedical_verify";
// These may be provided via env OR captured live from the Embedded Signup flow:
let ACCESS_TOKEN     = process.env.ACCESS_TOKEN || "";
let PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID || "";
let WABA_ID          = process.env.WABA_ID || "";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---- Tiny JSON store (conversations keyed by customer wa_id) ----
const DATA_FILE = path.join(__dirname, "data.json");
let store = { conversations: {}, meta: {} };
try { if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error("save err", e); } }
function addMessage(waId, msg, name) {
  if (!store.conversations[waId]) store.conversations[waId] = { waId, name: name || waId, messages: [] };
  if (name) store.conversations[waId].name = name;
  store.conversations[waId].messages.push(msg);
  store.conversations[waId].updated = Date.now();
  save();
}

// ---- Public config for the frontend (no secrets) ----
app.get("/config", (req, res) => {
  res.json({
    appId: APP_ID,
    configId: CONFIG_ID,
    graphVersion: GRAPH_VERSION,
    connected: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID),
    phoneNumberId: PHONE_NUMBER_ID || null,
    wabaId: WABA_ID || null
  });
});

// ---- Webhook verification (Meta calls this once) ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- Webhook receiver (incoming customer messages + statuses) ----
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // ack fast
  try {
    const entry = req.body.entry || [];
    for (const e of entry) {
      for (const ch of (e.changes || [])) {
        const v = ch.value || {};
        const contacts = v.contacts || [];
        const nameFor = (waId) => (contacts.find(c => c.wa_id === waId)?.profile?.name) || waId;
        for (const m of (v.messages || [])) {
          const text = m.text?.body
            || (m.type ? `[${m.type}]` : "[message]");
          addMessage(m.from, {
            id: m.id, dir: "in", type: m.type, text,
            ts: Number(m.timestamp) * 1000 || Date.now()
          }, nameFor(m.from));
          console.log(`IN  ${m.from}: ${text}`);
        }
        for (const s of (v.statuses || [])) {
          const conv = store.conversations[s.recipient_id];
          if (conv) {
            const mm = conv.messages.find(x => x.id === s.id);
            if (mm) { mm.status = s.status; save(); }
          }
        }
      }
    }
  } catch (err) { console.error("webhook err", err); }
});

// ---- List conversations ----
app.get("/api/messages", (req, res) => {
  const list = Object.values(store.conversations)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  res.json({ connected: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID), conversations: list });
});

// ---- Send a reply ----
app.post("/api/send", async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "to and text required" });
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) return res.status(400).json({ error: "Not connected yet. Complete coexistence onboarding first." });
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
    });
    const data = await r.json();
    if (!r.ok) { console.error("send err", data); return res.status(r.status).json(data); }
    addMessage(to, { id: data.messages?.[0]?.id, dir: "out", type: "text", text, ts: Date.now(), status: "sent" });
    res.json({ ok: true, data });
  } catch (err) { console.error(err); res.status(500).json({ error: String(err) }); }
});

// ---- Embedded Signup callback: exchange code -> token, wire up webhook ----
app.post("/api/session", async (req, res) => {
  const { code, phone_number_id, waba_id } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  if (!APP_SECRET) return res.status(500).json({ error: "APP_SECRET not set on server. Add it to host environment variables." });
  try {
    // 1) Exchange the authorization code for a business access token
    const tokenUrl = `${GRAPH}/oauth/access_token?client_id=${APP_ID}`
      + `&client_secret=${encodeURIComponent(APP_SECRET)}&code=${encodeURIComponent(code)}`;
    const tr = await fetch(tokenUrl);
    const tdata = await tr.json();
    if (!tr.ok || !tdata.access_token) { console.error("token err", tdata); return res.status(400).json({ error: "token exchange failed", detail: tdata }); }
    ACCESS_TOKEN = tdata.access_token;
    if (phone_number_id) PHONE_NUMBER_ID = phone_number_id;
    if (waba_id) WABA_ID = waba_id;
    store.meta = { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, connectedAt: Date.now() };
    save();

    // 2) Subscribe our app to the WABA so we receive message webhooks
    if (WABA_ID) {
      const sr = await fetch(`${GRAPH}/${WABA_ID}/subscribed_apps`, {
        method: "POST", headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` }
      });
      console.log("subscribe_apps:", sr.status, await sr.text());
    }
    console.log("=== CONNECTED ===  phone_number_id:", PHONE_NUMBER_ID, " waba_id:", WABA_ID);
    console.log(">>> Save this ACCESS_TOKEN into your host env vars (ACCESS_TOKEN) to persist across restarts.");
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

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`Mukesh Medical WhatsApp app listening on :${PORT}`));
