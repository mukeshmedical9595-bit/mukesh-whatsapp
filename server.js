// Mukesh Medical - WhatsApp Coexistence dashboard (Postgres-backed).
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, addMessage, updateStatus, getConversations, getConversation, setContactFlag, updateContact, getSetting, setSetting, saveMedia, getMedia, listContacts, createCustomer, deleteContact, getLatestImageMediaId, dbEnabled } from "./db.js";
import { mukcareReply } from "./ai.js";
import { initOrders, createOrder, listOrders, getOrder, updateOrderStatus, assignExec, reissueOrder, deleteOrder, createExec, listExecs, setExecActive, execHandoffMessage } from "./orders.js";
import { sendTemplate, sendOrderReady, sendOrderDispatched, sendOrderReminder, sendBillSent } from "./templates.js";
import { initCampaignsDb, sendCampaign, recordOptOut } from "./campaigns.js";

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
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const ORDER_DELETE_PASSWORD = process.env.ORDER_DELETE_PASSWORD || "";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Simple single-password gate for the dashboard API. The frontend sends the
// password in the "x-dash-key" header (over HTTPS). If DASHBOARD_PASSWORD is
// not configured, the gate is open (keeps the app usable during setup).
function requireAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const key = req.header("x-dash-key") || "";
  if (key === DASHBOARD_PASSWORD) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// Normalise an Indian phone number to WhatsApp wa_id form (91XXXXXXXXXX).
// We operate only in India, so a bare 10-digit number gets 91 prepended.
function normalizePhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return "91" + d;
  if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1);
  return d; // already has a country code, or non-standard - leave as-is
}

// Store profile passed to MUKCARE (the AI). Hours 10am-9pm, Mon-Sat (closed Sunday=0).
const AI_STORE = { name: "Mukesh Medical", openHour: 10, closeHour: 21, closedDays: [0], hoursText: "10 AM - 9 PM" };

// Send a plain-text WhatsApp message and persist it. bot=true marks it as a MUKCARE reply.
async function sendWhatsAppText(to, text, { bot = false } = {}) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) return { ok: false, status: 400, error: { error: "Not connected yet." } };
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } })
    });
    const data = await r.json();
    if (!r.ok) { console.error("send err", data); return { ok: false, status: r.status, error: data }; }
    await addMessage(to, { wa_msg_id: data.messages?.[0]?.id, dir: "out", type: "text", body: text, ts: Date.now(), status: "sent", bot });
    return { ok: true, data };
  } catch (err) { console.error("sendWhatsAppText err", err); return { ok: false, status: 500, error: { error: String(err) } }; }
}

// Send an interactive message with up to 3 tappable reply buttons.
// buttons: [{ id, title }]. Persists the body text (+ an options hint) for the dashboard.
async function sendWhatsAppInteractive(to, bodyText, buttons, { bot = false } = {}) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) return { ok: false, status: 400, error: { error: "Not connected yet." } };
  const btns = (buttons || []).slice(0, 3).map(b => ({ type: "reply", reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } }));
  if (btns.length === 0) return sendWhatsAppText(to, bodyText, { bot });
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: { type: "button", body: { text: bodyText }, action: { buttons: btns } }
      })
    });
    const data = await r.json();
    if (!r.ok) { console.error("send interactive err", data); return { ok: false, status: r.status, error: data }; }
    const stored = `${bodyText}\n⤷ options: ${btns.map(b => b.reply.title).join(" · ")}`;
    await addMessage(to, { wa_msg_id: data.messages?.[0]?.id, dir: "out", type: "interactive", body: stored, ts: Date.now(), status: "sent", bot });
    return { ok: true, data };
  } catch (err) { console.error("sendWhatsAppInteractive err", err); return { ok: false, status: 500, error: { error: String(err) } }; }
}

// Download a media file (prescription image/document) from WhatsApp by media id.
async function downloadWhatsAppMedia(mediaId) {
  if (!ACCESS_TOKEN || !mediaId) return null;
  try {
    const metaR = await fetch(`${GRAPH}/${mediaId}?access_token=${encodeURIComponent(ACCESS_TOKEN)}`);
    const meta = await metaR.json();
    if (!metaR.ok || !meta.url) { console.error("media meta err", meta); return null; }
    const binR = await fetch(meta.url, { headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` } });
    if (!binR.ok) { console.error("media download err", binR.status); return null; }
    return { buffer: Buffer.from(await binR.arrayBuffer()), mime: meta.mime_type || "application/octet-stream" };
  } catch (e) { console.error("downloadWhatsAppMedia err", e); return null; }
}

// Notify a customer of a status. Tries the approved TEMPLATE first (delivers even
// outside WhatsApp's 24h window); if that fails (e.g. template not yet approved),
// falls back to plain text (delivers only inside the 24h window).
async function notifyCustomer(order, kind) {
  const name = order.customer_name || "there", code = order.order_code || "";
  const to = normalizePhone(order.wa_id || order.phone);
  if (!to) return;
  let r = null;
  try { r = kind === "ready" ? await sendOrderReady(to, { name, orderCode: code }) : await sendOrderDispatched(to, { name, orderCode: code }); } catch (e) {}
  if (r?.ok) { await addMessage(to, { wa_msg_id: r.id, dir: "out", type: "template", body: `[${kind}] Order ${code}`, ts: Date.now(), status: "sent", bot: true }); return; }
  const txt = kind === "ready"
    ? `Hi ${name}, your order ${code} is billed and ready for pickup at Mukesh Medical. Please collect it at your convenience. Thank you. 🙏`
    : `Hi ${name}, your order ${code} has been billed and dispatched for home delivery. Our delivery team will reach you shortly. Thank you. 🙏`;
  await sendWhatsAppText(to, txt, { bot: true });
}

// Pickup-ready notification (fired when status becomes billed_ready).
async function notifyOrderStatus(order) {
  try {
    if (order.status === "billed_ready") await notifyCustomer(order, "ready");
    // billed_dispatched notifications are sent when a delivery executive is assigned - see notifyDispatch().
  } catch (e) { console.error("notifyOrderStatus err", e); }
}

// Dispatch notifications: fired when a delivery executive is assigned to a
// billed_dispatched order. Messages the customer AND the delivery executive.
async function notifyDispatch(order) {
  try {
    await notifyCustomer(order, "dispatched");
    if (order.exec_id) {
      const exec = (await listExecs()).find(e => String(e.id) === String(order.exec_id));
      const execPhone = normalizePhone(exec?.phone);
      if (execPhone) await sendWhatsAppText(execPhone, execHandoffMessage(order, exec), { bot: false });
      else console.warn("notifyDispatch: assigned exec has no phone", order.exec_id);
    }
  } catch (e) { console.error("notifyDispatch err", e); }
}

// MUKCARE auto-reply. Called from the webhook for each customer who just messaged.
// Skips if AI is not configured, the chat is under human control, or marked spam.
async function handleAiReply(waId) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return; // AI not enabled yet
    const convo = await getConversation(waId);
    if (!convo) return;
    if (convo.humanControl || convo.spam) return;
    const trainInstructions = await getSetting("train_instructions");

    // If the customer's latest message is a photo, load it so MUKCARE can see it
    // (to identify a product, or recognise a prescription).
    let latestImage = null;
    const lastMsg = convo.messages[convo.messages.length - 1];
    if (lastMsg && lastMsg.type === "image" && lastMsg.mediaId) {
      try {
        const media = await getMedia(lastMsg.mediaId);
        if (media?.data) {
          const buf = Buffer.isBuffer(media.data) ? media.data : Buffer.from(media.data);
          if (buf.length <= 4500000) latestImage = { mime: media.mime || "image/jpeg", base64: buf.toString("base64") };
        }
      } catch (e) { console.error("load image for AI err", e); }
    }

    const result = await mukcareReply({
      contact: { ...convo, messages: convo.messages },
      messages: convo.messages,
      settings: { trainInstructions },
      store: AI_STORE,
      now: new Date(),
      latestImage
    });
    if (result.error) { console.error("MUKCARE error:", result.error); return; }

    // Save the patient's name (as given by the customer in chat) as the display name.
    if (result.patientName) {
      await updateContact(waId, { name: result.patientName });
      convo.name = result.patientName;
    }

    if (result.reply) {
      if (result.buttons && result.buttons.length) {
        await sendWhatsAppInteractive(waId, result.reply, result.buttons, { bot: true });
      } else {
        await sendWhatsAppText(waId, result.reply, { bot: true });
      }
      console.log(`MUKCARE -> ${waId}: ${result.reply}${result.buttons?.length ? " [buttons: " + result.buttons.map(b => b.title).join(", ") + "]" : ""}`);
    }
    if (result.suggestBooked) await setContactFlag(waId, "booked", true);

    // When the customer confirms the order, record it and send the real Order ID.
    if (result.order) {
      try {
        // Prefer a saved location (e.g. a shared Maps link) over a vague AI phrase.
        const deliveryAddress = convo.address || result.order.location;
        // Remember the address on the customer's record for next time (only if we don't already have one).
        if (result.order.fulfillment === "delivery" && result.order.location && !convo.address) {
          await updateContact(waId, { address: result.order.location });
        }
        const order = await createOrder({
          waId,
          customerName: convo.name,
          phone: waId,
          mode: result.order.mode,
          items: result.order.items,
          fulfillment: result.order.fulfillment,
          address: result.order.fulfillment === "delivery" ? deliveryAddress : null,
          status: "new"
        });
        await sendWhatsAppText(waId, `Your Order ID is ${order.order_code}. Please keep it for reference. 🙏`, { bot: true });
        console.log(`ORDER created ${order.order_code} for ${waId}`);
      } catch (oe) { console.error("createOrder err", oe); }
    }
  } catch (e) { console.error("handleAiReply err", e); }
}

// ---- Public config for the frontend (no secrets) ----
app.get("/config", (req, res) => {
  res.json({
    appId: APP_ID, configId: CONFIG_ID, graphVersion: GRAPH_VERSION,
    connected: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID),
    persistent: dbEnabled,
    authRequired: Boolean(DASHBOARD_PASSWORD),
    phoneNumberId: PHONE_NUMBER_ID || null, wabaId: WABA_ID || null
  });
});

// Login check: frontend calls this with the x-dash-key header to validate the password.
app.get("/api/verify", requireAuth, (req, res) => res.json({ ok: true }));

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
  const aiTargets = new Set();
  try {
    for (const e of (req.body.entry || [])) {
      for (const ch of (e.changes || [])) {
        const v = ch.value || {};
        const contacts = v.contacts || [];
        const nameFor = (waId) => (contacts.find(c => c.wa_id === waId)?.profile?.name) || waId;

        for (const m of (v.messages || [])) {
          // A tapped reply button / list item comes through as an interactive reply.
          const btnTitle = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
          let body = m.text?.body || btnTitle || (m.type ? `[${m.type}]` : "[message]");
          let mediaId = null;
          // Prescription images (or document uploads) - download & store with us.
          const mediaObj = m.image || m.document || null;
          if (mediaObj?.id) {
            const dl = await downloadWhatsAppMedia(mediaObj.id);
            if (dl) mediaId = await saveMedia({ waId: m.from, waMsgId: m.id, mime: dl.mime, buffer: dl.buffer });
            body = m.image ? "[photo]" : "[document]";
          }
          // A shared WhatsApp location -> Google Maps link, saved as the customer's delivery address.
          if (m.type === "location" && m.location) {
            const lat = m.location.latitude, lng = m.location.longitude;
            const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
            body = `📍 ${mapsLink}`;
            try { await updateContact(m.from, { address: mapsLink }); } catch (e) { console.error("save location err", e); }
          }
          // Marketing opt-out: a bare "STOP" removes them from future campaigns.
          if ((m.text?.body || "").trim().toUpperCase() === "STOP") await recordOptOut(m.from);
          const { inserted } = await addMessage(m.from, { wa_msg_id: m.id, dir: "in", type: m.type, body, media_id: mediaId, ts: Number(m.timestamp) * 1000 || Date.now() }, nameFor(m.from));
          console.log(`IN  ${m.from}: ${body}`);
          if (inserted) aiTargets.add(m.from); // only reply to genuinely new messages
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
    // After persisting inbound messages, let MUKCARE reply to each customer.
    for (const t of aiTargets) await handleAiReply(t);
  } catch (err) { console.error("webhook err", err); }
});

// ---- List conversations ----
app.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const conversations = await getConversations();
    res.json({ connected: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID), persistent: dbEnabled, conversations });
  } catch (err) { console.error("messages err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Toggle booked / human_control / spam on a conversation ----
app.post("/api/contact/:waId/flag", requireAuth, async (req, res) => {
  const { field, value } = req.body || {};
  try { await setContactFlag(req.params.waId, field, Boolean(value)); res.json({ ok: true }); }
  catch (err) { console.error("flag err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Update editable profile fields (name, note) ----
app.post("/api/contact/:waId", requireAuth, async (req, res) => {
  const { name, note, address } = req.body || {};
  try { await updateContact(req.params.waId, { name, note, address }); res.json({ ok: true }); }
  catch (err) { console.error("contact update err", err); res.status(500).json({ error: String(err) }); }
});

// ---- App settings (Train MUKCARE instructions live here) ----
app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    res.json({
      trainInstructions: await getSetting("train_instructions")
    });
  } catch (err) { console.error("settings get err", err); res.status(500).json({ error: String(err) }); }
});
app.post("/api/settings", requireAuth, async (req, res) => {
  const { trainInstructions } = req.body || {};
  try {
    if (trainInstructions !== undefined) await setSetting("train_instructions", String(trainInstructions));
    res.json({ ok: true });
  } catch (err) { console.error("settings set err", err); res.status(500).json({ error: String(err) }); }
});

// Live test sandbox: run MUKCARE on a test conversation using the CURRENT saved
// training instructions - nothing is sent to WhatsApp or saved. Lets the owner
// verify their training/commands work before going live.
app.post("/api/mukcare-test", requireAuth, async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const name = req.body?.customerName || "Test Customer";
    const trainInstructions = await getSetting("train_instructions");
    const result = await mukcareReply({
      contact: { waId: "919999999999", name, messages },
      messages,
      settings: { trainInstructions },
      store: AI_STORE,
      now: new Date()
    });
    res.json({ ok: true, reply: result.reply, buttons: result.buttons || [], intent: result.intent, error: result.error });
  } catch (err) { console.error("mukcare-test err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Orders ----
app.get("/api/orders", requireAuth, async (req, res) => {
  try { res.json({ orders: await listOrders({ limit: 300 }), execs: await listExecs() }); }
  catch (err) { console.error("orders list err", err); res.status(500).json({ error: String(err) }); }
});

// Manual order creation (walk-in / phone). Non-WhatsApp customers get details entered here.
app.post("/api/orders", requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const nPhone = normalizePhone(b.phone);
    const order = await createOrder({
      waId: b.waId || nPhone || null,
      customerName: b.customerName || null,
      phone: nPhone || null,
      mode: b.mode || "typed",
      items: Array.isArray(b.items) ? b.items : [],
      fulfillment: b.fulfillment || null,
      address: b.address || null,
      notes: b.notes || null,
      status: b.status || "new"
    });
    res.json({ ok: true, order });
  } catch (err) { console.error("order create err", err); res.status(500).json({ error: String(err) }); }
});

app.post("/api/orders/:id/status", requireAuth, async (req, res) => {
  try {
    const order = await updateOrderStatus(req.params.id, req.body?.status);
    if (order) notifyOrderStatus(order).catch(() => {}); // customer + exec notifications
    res.json({ ok: true, order });
  } catch (err) { console.error("order status err", err); res.status(400).json({ error: String(err) }); }
});

app.post("/api/orders/:id/assign", requireAuth, async (req, res) => {
  try {
    const order = await assignExec(req.params.id, req.body?.execId || null);
    // On assigning a delivery exec to a billed & dispatched order, notify customer + exec.
    if (order && order.exec_id && order.status === "billed_dispatched") notifyDispatch(order).catch(() => {});
    res.json({ ok: true, order });
  } catch (err) { console.error("order assign err", err); res.status(500).json({ error: String(err) }); }
});

// Send the order details to the assigned delivery executive over WhatsApp.
app.post("/api/orders/:id/notify-exec", requireAuth, async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    if (!order.exec_id) return res.status(400).json({ error: "no exec assigned" });
    const exec = (await listExecs()).find(e => String(e.id) === String(order.exec_id));
    if (!exec?.phone) return res.status(400).json({ error: "exec has no phone" });
    const r = await sendWhatsAppText(exec.phone, execHandoffMessage(order, exec), { bot: false });
    if (!r.ok) return res.status(r.status || 400).json(r.error || { error: "send failed" });
    res.json({ ok: true });
  } catch (err) { console.error("notify-exec err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Delivery executives ----
app.get("/api/execs", requireAuth, async (req, res) => {
  try { res.json({ execs: await listExecs() }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});
app.post("/api/execs", requireAuth, async (req, res) => {
  const b = req.body || {};
  try { res.json({ ok: true, exec: await createExec({ name: b.name, phone: normalizePhone(b.phone), area: b.area }) }); }
  catch (err) { console.error("exec create err", err); res.status(500).json({ error: String(err) }); }
});
app.post("/api/execs/:id/active", requireAuth, async (req, res) => {
  try { res.json({ ok: true, exec: await setExecActive(req.params.id, req.body?.active) }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ---- Customer database ----
app.get("/api/customers", requireAuth, async (req, res) => {
  try { res.json({ customers: await listContacts() }); }
  catch (err) { console.error("customers list err", err); res.status(500).json({ error: String(err) }); }
});
app.post("/api/customers", requireAuth, async (req, res) => {
  const { phone, name, address, note } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone required" });
  try { res.json({ ok: true, customer: await createCustomer({ phone: normalizePhone(phone), name, address, note }) }); }
  catch (err) { console.error("customer create err", err); res.status(500).json({ error: String(err) }); }
});
// Edit a customer's fields (name/address/note) without touching the phone/history.
app.post("/api/customers/:waId", requireAuth, async (req, res) => {
  const { name, address, note } = req.body || {};
  try { await updateContact(req.params.waId, { name, address, note }); res.json({ ok: true }); }
  catch (err) { console.error("customer edit err", err); res.status(500).json({ error: String(err) }); }
});
// Delete a customer record (and their chat history). Operated by staff.
app.post("/api/customers/:waId/delete", requireAuth, async (req, res) => {
  try { await deleteContact(req.params.waId); res.json({ ok: true }); }
  catch (err) { console.error("customer delete err", err); res.status(500).json({ error: String(err) }); }
});
// Delete an order - requires the separate order-delete password.
app.post("/api/orders/:id/delete", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!ORDER_DELETE_PASSWORD) return res.status(400).json({ error: "Order-delete password not configured." });
  if (password !== ORDER_DELETE_PASSWORD) return res.status(403).json({ error: "wrong password" });
  try { await deleteOrder(req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("order delete err", err); res.status(500).json({ error: String(err) }); }
});

// Full order detail, including the customer's latest prescription image (if any).
app.get("/api/orders/:id/detail", requireAuth, async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "not found" });
    const prescriptionMediaId = order.wa_id ? await getLatestImageMediaId(order.wa_id) : null;
    res.json({ order, prescriptionMediaId });
  } catch (err) { console.error("order detail err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Prescription image / media (auth-gated; health data) ----
app.get("/media/:id", requireAuth, async (req, res) => {
  try {
    const m = await getMedia(req.params.id);
    if (!m || !m.data) return res.sendStatus(404);
    res.set("Content-Type", m.mime || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=86400");
    res.send(Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data));
  } catch (e) { console.error("media err", e); res.sendStatus(500); }
});

// ---- One-time: create all MUKCARE message templates via the Graph API ----
// Far more reliable than the WhatsApp Manager UI. Requires the ACCESS_TOKEN to
// have whatsapp_business_management permission. Safe to re-run (existing names
// just return a duplicate error which we report).
const MUKCARE_TEMPLATE_DEFS = [
  { name: "order_ready_pickup", category: "UTILITY",
    body: "Hi {{1}}, your order {{2}} is ready for pickup at Mukesh Medical. Please collect it at your convenience. Thank you.",
    example: ["Rahul", "MM-260727-001"] },
  { name: "order_dispatched", category: "UTILITY",
    body: "Hi {{1}}, your order {{2}} has been dispatched for home delivery. Our delivery team will reach you shortly. Thank you.",
    example: ["Rahul", "MM-260727-001"] },
  { name: "order_reminder", category: "UTILITY",
    body: "Hi {{1}}, a friendly reminder about your order {{2}} with Mukesh Medical. Please reply here if you need any help.",
    example: ["Rahul", "MM-260727-001"] },
  { name: "bill_sent", category: "UTILITY",
    body: "Hi {{1}}, your bill for order {{2}} (Rs. {{3}}) is ready. Thank you for choosing Mukesh Medical.",
    example: ["Rahul", "MM-260727-001", "450"] },
  { name: "promo_generic", category: "MARKETING",
    body: "Hi {{1}}, {{2}} Reply STOP to opt out. - Mukesh Medical",
    example: ["Rahul", "This week: 15% off on all health supplements!"] },
];

app.post("/api/admin/create-templates", requireAuth, async (req, res) => {
  if (!ACCESS_TOKEN || !WABA_ID) return res.status(400).json({ error: "ACCESS_TOKEN and WABA_ID required" });
  const results = [];
  for (const t of MUKCARE_TEMPLATE_DEFS) {
    try {
      const r = await fetch(`${GRAPH}/${WABA_ID}/message_templates`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: t.name, language: "en", category: t.category,
          components: [{ type: "BODY", text: t.body, example: { body_text: [t.example] } }]
        })
      });
      const data = await r.json();
      results.push({ name: t.name, ok: r.ok, status: data.status || (r.ok ? "submitted" : "error"), detail: r.ok ? undefined : (data.error?.message || data) });
    } catch (e) { results.push({ name: t.name, ok: false, detail: String(e) }); }
  }
  res.json({ results });
});

// ---- Bulk broadcast (marketing templates) ----
app.post("/api/campaigns/send", requireAuth, async (req, res) => {
  const { name, templateName, langCode, recipients } = req.body || {};
  try {
    const summary = await sendCampaign({ name, templateName, langCode: langCode || "en", recipients: recipients || [] });
    res.json({ ok: true, summary });
  } catch (err) { console.error("campaign send err", err); res.status(500).json({ error: String(err) }); }
});

// Manually send an approved template to one customer (e.g. reminder, bill-sent).
app.post("/api/notify", requireAuth, async (req, res) => {
  const { to, template, params } = req.body || {};
  if (!to || !template) return res.status(400).json({ error: "to and template required" });
  try {
    let r;
    if (template === "reminder") r = await sendOrderReminder(to, params || {});
    else if (template === "bill") r = await sendBillSent(to, params || {});
    else if (template === "ready") r = await sendOrderReady(to, params || {});
    else if (template === "dispatched") r = await sendOrderDispatched(to, params || {});
    else return res.status(400).json({ error: "unknown template" });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) { console.error("notify err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Send a reply ----
app.post("/api/send", requireAuth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: "to and text required" });
  const r = await sendWhatsAppText(to, text, { bot: false });
  if (!r.ok) return res.status(r.status || 400).json(r.error || { error: "send failed" });
  res.json({ ok: true, data: r.data });
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
  try { await initOrders(); } catch (e) { console.error("initOrders err", e); }
  try { await initCampaignsDb(); } catch (e) { console.error("initCampaignsDb err", e); }
  app.listen(PORT, async () => {
    console.log(`Mukesh Medical app listening on :${PORT} (persistent=${dbEnabled})`);
    console.log("autoWire:", JSON.stringify(await autoWire()));
  });
})();
