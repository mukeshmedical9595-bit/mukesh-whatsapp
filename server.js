// Mukesh Medical - WhatsApp Coexistence dashboard (Postgres-backed).
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, addMessage, updateStatus, getConversations, getConversation, setContactFlag, setMukcarePause, updateContact, getSetting, setSetting, getSettings, bumpNonOrderCount, saveMedia, getMedia, listContacts, createCustomer, deleteContact, getLatestImageMediaId, getContactByWa, normalizeAllNumbers, dbEnabled } from "./db.js";
import { mukcareReply, classifyFeedback } from "./ai.js";
import { initOrders, createOrder, listOrders, getOrder, updateOrderStatus, assignExec, reissueOrder, deleteOrder, createExec, listExecs, setExecActive, execHandoffMessage, getEvents, getOrderItems, setOrderItems, logEvent, setOrderBilling, getProcurement, lockProcurement, editProcurementVendor, deleteProcurementLine, addFeedback, listFeedback, feedbackCounts, markFeedbackHandled, ordersNeedingFeedbackRequest, markFeedbackRequested, normalizeProductName, addItems, latestActiveUnbilled } from "./orders.js";
import { sendTemplate, sendOrderReady, sendOrderDispatched, sendOrderReminder, sendBillSent, sendDeliveryAssignment } from "./templates.js";
import { initCampaignsDb, sendCampaign, recordOptOut } from "./campaigns.js";
import crypto from "crypto";
import PDFDocument from "pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Keep the raw request body so we can verify Meta's X-Hub-Signature-256 on the webhook.
app.use(express.json({ limit: "12mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
// Shared secret the PROFITMAKER bridge program sends in the x-bridge-token header.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
// Public base URL of this Render service, used to build media links (e.g. invoice PDFs).
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://mukesh-whatsapp.onrender.com").replace(/\/+$/, "");

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MEDIA_SECRET = APP_SECRET || DASHBOARD_PASSWORD || "mukcare-media";

// Signed public link to a media blob, so WhatsApp can fetch outbound images/PDFs
// (QR, invoices) without our dashboard auth, while prescription media stays private
// (its id would need a matching token, which we only mint for files we choose to send).
function mediaToken(id) {
  return crypto.createHmac("sha256", MEDIA_SECRET).update(String(id)).digest("hex").slice(0, 24);
}
function mediaLink(id) {
  return `${PUBLIC_URL}/pub/${id}?t=${mediaToken(id)}`;
}

// Straight-line distance (km) between two lat/lng points (haversine).
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}

// Settings-driven delivery quote for an order. Uses the outlet lat/lng + the
// customer's GPS pin (if we have one) to compute distance, then applies the
// configurable tiers. Returns { distanceKm, fee, pending } - pending=true when
// we can't compute (no GPS / no outlet), so staff confirm the fee at billing.
async function computeDeliveryQuote(custLat, custLng, orderValue) {
  const s = await getSettings(["outlet_lat", "outlet_lng", "free_delivery_radius_km", "free_delivery_order_value", "flat_delivery_charge", "max_delivery_km"]);
  const oLat = parseFloat(s.outlet_lat), oLng = parseFloat(s.outlet_lng);
  if (!Number.isFinite(oLat) || !Number.isFinite(oLng) || custLat == null || custLng == null) {
    return { distanceKm: null, fee: null, pending: true };
  }
  const km = haversineKm(oLat, oLng, Number(custLat), Number(custLng));
  const freeKm = parseFloat(s.free_delivery_radius_km);
  const freeVal = parseFloat(s.free_delivery_order_value);
  const flat = parseFloat(s.flat_delivery_charge);
  if (Number.isFinite(freeVal) && orderValue != null && Number(orderValue) >= freeVal) return { distanceKm: km, fee: 0, pending: false };
  if (Number.isFinite(freeKm) && km <= freeKm) return { distanceKm: km, fee: 0, pending: false };
  if (Number.isFinite(flat)) return { distanceKm: km, fee: flat, pending: false };
  return { distanceKm: km, fee: null, pending: true };
}

// Verify Meta's webhook payload signature (X-Hub-Signature-256 = HMAC-SHA256 of the
// raw body keyed by the app secret). Returns true if valid, or if no APP_SECRET is
// configured yet (so the app stays usable during setup). Uses a timing-safe compare.
function verifyWebhookSignature(req) {
  if (!APP_SECRET) return true; // not configured yet
  const sig = req.header("x-hub-signature-256") || "";
  if (!sig.startsWith("sha256=") || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

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

// Send a document (e.g. an invoice PDF) by public link. Persists it for the dashboard.
async function sendWhatsAppDocument(to, { link, filename, caption } = {}, { bot = false } = {}) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || !link) return { ok: false, status: 400, error: { error: "Not connected / no link." } };
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "document",
        document: { link, filename: filename || "document.pdf", ...(caption ? { caption } : {}) }
      })
    });
    const data = await r.json();
    if (!r.ok) { console.error("send document err", data); return { ok: false, status: r.status, error: data }; }
    await addMessage(to, { wa_msg_id: data.messages?.[0]?.id, dir: "out", type: "document", body: caption || `[document] ${filename || ""}`, ts: Date.now(), status: "sent", bot });
    return { ok: true, data };
  } catch (err) { console.error("sendWhatsAppDocument err", err); return { ok: false, status: 500, error: { error: String(err) } }; }
}

// Send an image (e.g. the payment QR) by public link. Persists it for the dashboard.
async function sendWhatsAppImage(to, { link, caption } = {}, { bot = false } = {}) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || !link) return { ok: false, status: 400, error: { error: "Not connected / no link." } };
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "image", image: { link, ...(caption ? { caption } : {}) } })
    });
    const data = await r.json();
    if (!r.ok) { console.error("send image err", data); return { ok: false, status: r.status, error: data }; }
    await addMessage(to, { wa_msg_id: data.messages?.[0]?.id, dir: "out", type: "image", body: caption || "[image]", ts: Date.now(), status: "sent", bot });
    return { ok: true, data };
  } catch (err) { console.error("sendWhatsAppImage err", err); return { ok: false, status: 500, error: { error: String(err) } }; }
}

// Send our payment details (UPI id text + QR image) to a customer. Reads the UPI id
// and QR media id from Settings; no-op if neither is configured.
async function sendPaymentDetails(to) {
  const cfg = await getSettings(["upi_id", "payment_qr_media_id"]);
  if (!cfg.upi_id && !cfg.payment_qr_media_id) return { ok: false, error: "payment not configured" };
  if (cfg.upi_id) await sendWhatsAppText(to, `You can pay via UPI to: ${cfg.upi_id}\nPlease share a screenshot after paying. 🙏`, { bot: true });
  if (cfg.payment_qr_media_id) await sendWhatsAppImage(to, { link: mediaLink(cfg.payment_qr_media_id), caption: "Scan to pay (UPI)" }, { bot: true });
  return { ok: true };
}

// Indian amount-in-words (e.g. 1234 -> "One Thousand Two Hundred Thirty Four Rupees Only").
function amountInWords(num) {
  let n = Math.round(Number(num) || 0);
  if (n === 0) return "Zero Rupees Only";
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = x => x < 20 ? a[x] : (b[Math.floor(x / 10)] + (x % 10 ? " " + a[x % 10] : ""));
  const three = x => x >= 100 ? (a[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " + two(x % 100) : "")) : two(x);
  let out = "";
  const cr = Math.floor(n / 10000000); n %= 10000000;
  const la = Math.floor(n / 100000); n %= 100000;
  const th = Math.floor(n / 1000); n %= 1000;
  if (cr) out += three(cr) + " Crore ";
  if (la) out += two(la) + " Lakh ";
  if (th) out += two(th) + " Thousand ";
  if (n) out += three(n);
  return out.trim() + " Rupees Only";
}

// Build a full tax-invoice PDF (Buffer) from an order + the bill's totals & line items.
function generateInvoicePdf(order, bill, seller = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 36 });
      const chunks = [];
      doc.on("data", c => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      const L = 36, R = 559, W = R - L;
      const money = v => (Number(v) || 0).toFixed(2);

      // Seller defaults (Mukesh Medical, Narayanaguda) — used when Settings are blank
      const S = {
        name: seller.name || "MUKESH MEDICAL",
        address: seller.address || "3-5-170/1/8/1 & 170/1/8/2/4-1, Narayana Guda Main Road, Narayanaguda, Hyderabad, Telangana - 500029",
        gstin: seller.gstin || "36AGMPK0923E1ZM",
        dl: seller.dl || "TS/HYD/2018-35546 (20B, 21B, 20, 21)",
        prop: seller.prop || "Prop: Rachana Kanodia",
      };

      // Seller header
      doc.fontSize(18).fillColor("#0b6b5e").text(S.name, L, 36);
      doc.fontSize(8.5).fillColor("#444");
      doc.text(S.address, L, doc.y, { width: 320 });
      if (S.prop) doc.text(S.prop, L, doc.y, { width: 320 });
      const sid = [];
      if (S.gstin) sid.push("GSTIN: " + S.gstin);
      if (S.dl) sid.push("D.L.No: " + S.dl);
      if (sid.length) doc.text(sid.join("     "), L, doc.y, { width: 340 });
      // Title + meta (right)
      doc.fontSize(15).fillColor("#111").text("TAX INVOICE", L, 40, { width: W, align: "right" });
      const dt = bill.date ? new Date(bill.date) : new Date();
      doc.fontSize(9).fillColor("#111");
      doc.text("Bill No: " + (bill.billNo || "-"), L, 64, { width: W, align: "right" });
      doc.text("Date: " + dt.toLocaleDateString("en-IN"), L, 76, { width: W, align: "right" });
      doc.text("Order: " + (order.order_code || ""), L, 88, { width: W, align: "right" });
      doc.moveTo(L, 106).lineTo(R, 106).strokeColor("#bbbbbb").stroke();

      // Buyer
      doc.fontSize(9).fillColor("#0b6b5e").text("Bill To", L, 112);
      doc.fontSize(9.5).fillColor("#111").text(order.customer_name || "-", L, 124);
      if (order.phone || order.wa_id) doc.fontSize(9).text("Phone: " + (order.phone || order.wa_id), L, doc.y);
      if (order.address) doc.fontSize(8.5).fillColor("#555").text(String(order.address).slice(0, 95), L, doc.y);

      // Items table header
      let ty = 160;
      const cols = [
        { t: "Product", x: L, w: 152, a: "left" },
        { t: "Batch", x: 190, w: 50, a: "left" },
        { t: "Exp", x: 242, w: 34, a: "left" },
        { t: "Qty", x: 278, w: 26, a: "right" },
        { t: "Free", x: 306, w: 26, a: "right" },
        { t: "MRP", x: 334, w: 44, a: "right" },
        { t: "Rate", x: 380, w: 44, a: "right" },
        { t: "Dis%", x: 426, w: 32, a: "right" },
        { t: "GST%", x: 460, w: 32, a: "right" },
        { t: "Amount", x: 494, w: 65, a: "right" },
      ];
      doc.rect(L, ty - 3, W, 15).fill("#0b6b5e");
      doc.fillColor("#ffffff").fontSize(8);
      cols.forEach(c => doc.text(c.t, c.x, ty, { width: c.w, align: c.a }));
      ty += 16;
      doc.fillColor("#111").fontSize(8);
      const items = Array.isArray(bill.items) ? bill.items : [];
      for (const it of items) {
        if (ty > 715) { doc.addPage(); ty = 50; }
        const vals = [
          String(it.name || "").slice(0, 42), String(it.batch || ""), String(it.exp || ""),
          it.qty != null ? String(it.qty) : "", it.free ? String(it.free) : "",
          it.mrp != null ? money(it.mrp) : "", it.rate != null ? money(it.rate) : "",
          it.disPer ? Number(it.disPer).toFixed(1) : "", it.gstPer != null ? String(Number(it.gstPer)) : "",
          money(it.amount != null ? it.amount : (Number(it.rate || 0) * Number(it.qty || 0))),
        ];
        cols.forEach((c, i) => doc.text(vals[i], c.x, ty, { width: c.w, align: c.a }));
        ty += 13;
      }
      doc.moveTo(L, ty + 1).lineTo(R, ty + 1).strokeColor("#bbbbbb").stroke();
      ty += 8;

      // Totals block (right)
      const lx = 358, vx = 494, vw = 65;
      const trow = (label, val, bold) => {
        doc.fontSize(bold ? 10.5 : 8.5).fillColor(bold ? "#0b6b5e" : "#111");
        doc.text(label, lx, ty, { width: 130, align: "left" });
        doc.text(money(val), vx, ty, { width: vw, align: "right" });
        ty += bold ? 16 : 12;
      };
      if (bill.subTotal) trow("Sub Total", bill.subTotal);
      if (bill.discount) trow("Discount (-)", bill.discount);
      if (bill.schDis) trow("Scheme Dis (-)", bill.schDis);
      const gv = bill.gstVals || [], ga = bill.gstAmts || [];
      let anyGst = false;
      for (let i = 1; i <= 5; i++) {
        const tv = Number(gv[i] || 0), gg = Number(ga[i - 1] || 0);
        if (tv > 0 && gg > 0) { anyGst = true; trow(`GST @${Math.round(gg / tv * 100)}%`, gg); }
      }
      if (!anyGst && bill.gstTotal) trow("GST", bill.gstTotal);
      if (bill.rounding) trow("Round Off", bill.rounding);
      doc.moveTo(lx, ty).lineTo(R, ty).strokeColor("#bbbbbb").stroke(); ty += 4;
      const net = bill.net != null ? bill.net : bill.amount;
      trow("NET AMOUNT", net, true);

      ty += 6;
      doc.fontSize(8.5).fillColor("#111").text("Amount in words: " + amountInWords(net), L, ty, { width: W });
      ty = doc.y + 16;
      doc.fontSize(8).fillColor("#777").text("E.&O.E.   This is a system-generated tax invoice from " + S.name + ".", L, ty, { width: W, align: "center" });
      doc.end();
    } catch (e) { reject(e); }
  });
}

// Mark an inbound WhatsApp message as read (blue ticks) - best-effort, never throws.
async function markWhatsAppRead(messageId) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || !messageId) return;
  try {
    await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId })
    });
  } catch (e) { /* best-effort */ }
}

// WhatsApp only allows free-form (non-template) messages within 24h of the customer's
// last inbound message. Returns true if we're still inside that window.
async function within24hWindow(waId) {
  try {
    const convo = await getConversation(waId);
    if (!convo) return false;
    const lastIn = [...(convo.messages || [])].reverse().find(m => m.dir === "in");
    if (!lastIn) return false;
    return (Date.now() - Number(lastIn.ts)) < 24 * 60 * 60 * 1000;
  } catch { return false; }
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
      if (execPhone) {
        const items = (Array.isArray(order.items) ? order.items : []).map(it => it.name + (it.qty ? (" - " + it.qty) : "")).join(", ") || (order.mode === "prescription" ? "Prescription order" : "-");
        let r = null;
        try { r = await sendDeliveryAssignment(execPhone, { orderCode: order.order_code, customerName: order.customer_name || "-", phone: order.phone || order.wa_id || "-", address: order.address || "-", items }); } catch (e) {}
        if (!r?.ok) await sendWhatsAppText(execPhone, execHandoffMessage(order, exec), { bot: false }); // fallback (needs open chat)
      } else console.warn("notifyDispatch: assigned exec has no phone", order.exec_id);
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
    // MUKCARE auto-pauses a chat for 6h when it decides a human is needed, so the
    // staff can take over without the bot interrupting. Resume only after it expires.
    if (convo.pausedUntil && convo.pausedUntil > Date.now()) {
      console.log(`MUKCARE paused for ${waId} until ${new Date(convo.pausedUntil).toISOString()} - skipping auto-reply.`);
      return;
    }
    const cfg = await getSettings(["train_instructions", "upi_id", "payment_qr_media_id"]);
    const trainInstructions = cfg.train_instructions;
    const paymentConfigured = Boolean(cfg.upi_id || cfg.payment_qr_media_id);

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

    // §3d/§3e: give the AI the customer's in-progress and most-recent orders.
    let activeOrder = null, lastOrder = null;
    try {
      activeOrder = await latestActiveUnbilled(waId);
      const recent = await listOrders({ waId, limit: 1 });
      if (recent && recent[0]) lastOrder = { order_code: recent[0].order_code, status: recent[0].status };
    } catch (e) { console.error("order context err", e); }

    const result = await mukcareReply({
      contact: {
        ...convo, messages: convo.messages,
        activeOrder: activeOrder ? { order_code: activeOrder.order_code, items: activeOrder.items } : null,
        lastOrder
      },
      messages: convo.messages,
      settings: { trainInstructions, paymentConfigured },
      store: AI_STORE,
      now: new Date(),
      latestImage
    });
    if (result.error) { console.error("MUKCARE error:", result.error); return; }

    // Save the patient's name (as given by the customer in chat) as the display name,
    // mark it confirmed, and remember it as the default patient so future orders skip the ask.
    if (result.patientName) {
      await updateContact(waId, { name: result.patientName, nameConfirmed: true, defaultPatient: result.patientName });
      convo.name = result.patientName;
      convo.defaultPatient = result.patientName;
    }

    // Spam guard: count consecutive non-order messages; auto-flag as spam past a
    // threshold. Any order-related turn resets the counter.
    const orderish = result.intent === "order" || result.intent === "enquiry" || result.order || result.suggestBooked;
    if (orderish) { await bumpNonOrderCount(waId, true); }
    else if (result.intent === "spam" || result.intent === "chitchat") {
      const n = await bumpNonOrderCount(waId, false);
      if (n >= 6) { await setContactFlag(waId, "spam", true); console.log(`Auto-flagged spam: ${waId} (${n} non-order msgs)`); }
    }

    if (result.reply) {
      if (result.buttons && result.buttons.length) {
        await sendWhatsAppInteractive(waId, result.reply, result.buttons, { bot: true });
      } else {
        await sendWhatsAppText(waId, result.reply, { bot: true });
      }
      console.log(`MUKCARE -> ${waId}: ${result.reply}${result.buttons?.length ? " [buttons: " + result.buttons.map(b => b.title).join(", ") + "]" : ""}`);
    }
    // Customer asked how to pay and payment is configured: send UPI id + QR image.
    if (result.sendPayment && paymentConfigured) {
      try { await sendPaymentDetails(waId); console.log(`MUKCARE sent payment details -> ${waId}`); } catch (e) { console.error("sendPaymentDetails err", e); }
    }
    if (result.suggestBooked) await setContactFlag(waId, "booked", true);
    // MUKCARE decided a human should handle this chat: flag it and pause MUKCARE's
    // auto-replies for 6 hours so staff can take over and resolve it. After 6h,
    // if the customer messages again, MUKCARE resumes automatically.
    if (result.needsHuman) {
      await setContactFlag(waId, "needs_human", true);
      await setMukcarePause(waId, Date.now() + 6 * 60 * 60 * 1000);
      console.log(`MUKCARE paused 6h for ${waId} (human needed).`);
    }

    // When the customer confirms the order, record it and send the real Order ID.
    if (result.order) {
      try {
        // §3d: if an un-billed order is already being prepared, APPEND to it instead
        // of opening a duplicate (unless the AI explicitly flagged this as a new order).
        if (activeOrder && !result.order.newOrder) {
          await addItems(activeOrder.id, result.order.items);
          console.log(`ORDER items added to ${activeOrder.order_code} for ${waId}`);
        } else {
          // §3f: never let a confirmed delivery order silently degrade to pickup.
          // If the AI omitted fulfillment, infer delivery from a shared location / saved pin.
          const fulfillment = result.order.fulfillment
            || ((result.order.location || convo.locationLat != null) ? "delivery" : "pickup");
          // Prefer a saved location (e.g. a shared Maps link) over a vague AI phrase.
          const deliveryAddress = convo.address || result.order.location;
          // Remember the address on the customer's record for next time (only if we don't already have one).
          if (fulfillment === "delivery" && result.order.location && !convo.address) {
            await updateContact(waId, { address: result.order.location });
          }
          const order = await createOrder({
            waId,
            customerName: convo.name,
            phone: waId,
            mode: result.order.mode,
            items: result.order.items,
            fulfillment,
            address: fulfillment === "delivery" ? deliveryAddress : null,
            patientName: convo.defaultPatient || convo.name || null,
            status: "new"
          });
          await sendWhatsAppText(waId, `Your Order ID is ${order.order_code}. Please keep it for reference. 🙏`, { bot: true });
          console.log(`ORDER created ${order.order_code} for ${waId}`);
        }
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
  // Reject forged payloads: verify Meta's HMAC signature before doing anything.
  if (!verifyWebhookSignature(req)) { console.warn("Webhook signature invalid - ignoring."); return res.sendStatus(401); }
  res.sendStatus(200); // ack fast
  const aiTargets = new Set();
  const feedbackCandidates = []; // [waId, text] for new inbound text messages
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
            try { await updateContact(m.from, { address: mapsLink, locationLat: lat, locationLng: lng }); } catch (e) { console.error("save location err", e); }
          }
          // Marketing opt-out: a bare "STOP" removes them from future campaigns.
          if ((m.text?.body || "").trim().toUpperCase() === "STOP") await recordOptOut(m.from);
          const { inserted } = await addMessage(m.from, { wa_msg_id: m.id, dir: "in", type: m.type, body, media_id: mediaId, ts: Number(m.timestamp) * 1000 || Date.now() }, nameFor(m.from));
          markWhatsAppRead(m.id); // blue ticks (best-effort)
          console.log(`IN  ${m.from}: ${body}`);
          if (inserted) {
            aiTargets.add(m.from); // only reply to genuinely new messages
            if (m.type === "text" && m.text?.body) feedbackCandidates.push([m.from, m.text.body]);
            // Mark the chat unread and pull it back out of the archive so staff see it.
            try { await updateContact(m.from, { unread: true, archived: false }); } catch (e) {}
          }
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
          if (s.status === "failed") console.error("MSG FAILED ->", s.recipient_id, JSON.stringify(s.errors || s));
        }
      }
    }
    // After persisting inbound messages, let MUKCARE reply to each customer.
    for (const t of aiTargets) await handleAiReply(t);
    // Fire-and-forget: classify new inbound TEXT for feedback/sentiment.
    for (const [waId, text] of feedbackCandidates) classifyAndRecordFeedback(waId, text).catch(() => {});
  } catch (err) { console.error("webhook err", err); }
});

// Classify a customer message for feedback; record it, and flag negative
// feedback's chat as needs-human + unread so staff follow up. Never throws.
async function classifyAndRecordFeedback(waId, text) {
  try {
    const c = await classifyFeedback(text);
    if (!c.isFeedback) return;
    await addFeedback({ waId, sentiment: c.sentiment, text });
    if (c.sentiment === "negative") {
      await setContactFlag(waId, "needs_human", true);
      await updateContact(waId, { unread: true });
      console.log(`NEGATIVE feedback from ${waId} - flagged needs-human.`);
    }
  } catch (e) { /* best-effort */ }
}

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
  try {
    await setContactFlag(req.params.waId, field, Boolean(value));
    // When staff mark the chat handled, or turn MUKCARE's auto-reply back on,
    // lift any 6-hour auto-pause so MUKCARE can resume on the next message.
    if ((field === "needs_human" && !value) || (field === "human_control" && !value)) {
      await setMukcarePause(req.params.waId, null);
    }
    res.json({ ok: true });
  }
  catch (err) { console.error("flag err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Update editable profile fields (name, note) ----
app.post("/api/contact/:waId", requireAuth, async (req, res) => {
  const { name, note, address } = req.body || {};
  try { await updateContact(req.params.waId, { name, note, address }); res.json({ ok: true }); }
  catch (err) { console.error("contact update err", err); res.status(500).json({ error: String(err) }); }
});

// Clear the unread flag when staff open a chat.
app.post("/api/contact/:waId/read", requireAuth, async (req, res) => {
  try { await setContactFlag(req.params.waId, "unread", false); res.json({ ok: true }); }
  catch (err) { console.error("mark read err", err); res.status(500).json({ error: String(err) }); }
});

// ---- App settings (Train MUKCARE instructions live here) ----
// Business-rule settings exposed to the dashboard Settings tab. Keys are stored
// in the generic settings table; camelCase in the API maps to snake_case keys.
const SETTINGS_KEYS = {
  trainInstructions: "train_instructions",
  upiId: "upi_id",
  paymentQrMediaId: "payment_qr_media_id",
  freeDeliveryRadiusKm: "free_delivery_radius_km",
  freeDeliveryOrderValue: "free_delivery_order_value",
  flatDeliveryCharge: "flat_delivery_charge",
  maxDeliveryKm: "max_delivery_km",
  outletLat: "outlet_lat",
  outletLng: "outlet_lng",
  outletAddress: "outlet_address",
  discountText: "discount_text",
  sellerName: "seller_name",
  sellerAddress: "seller_address",
  sellerGstin: "seller_gstin",
  sellerDl: "seller_dl",
};
app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    const out = {};
    for (const [camel, key] of Object.entries(SETTINGS_KEYS)) out[camel] = await getSetting(key);
    res.json(out);
  } catch (err) { console.error("settings get err", err); res.status(500).json({ error: String(err) }); }
});
app.post("/api/settings", requireAuth, async (req, res) => {
  const body = req.body || {};
  try {
    for (const [camel, key] of Object.entries(SETTINGS_KEYS)) {
      if (body[camel] !== undefined) await setSetting(key, body[camel] === null ? "" : String(body[camel]));
    }
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

// Record billing (bill no + amount + optional invoice PDF), move to Billed &
// Ready / Dispatched, and notify the customer (invoice attached if provided).
// Manual entry path; the ERP bridge (Block 8) will call this internally later.
app.post("/api/orders/:id/bill", requireAuth, async (req, res) => {
  try {
    const { billNo, orderValue, billMediaId } = req.body || {};
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    const isDelivery = order.fulfillment === "delivery";

    // Staff-confirmed delivery distance/fee (if we have the customer's GPS pin).
    let distanceKm = null, deliveryFee = null, deliveryFeePending = null;
    if (isDelivery) {
      const contact = order.wa_id ? await getConversation(order.wa_id).catch(() => null) : null;
      const q = await computeDeliveryQuote(contact?.locationLat, contact?.locationLng, orderValue);
      distanceKm = q.distanceKm; deliveryFee = q.fee; deliveryFeePending = q.pending;
    }

    const billed = await setOrderBilling(req.params.id, {
      billNo, orderValue: orderValue != null && orderValue !== "" ? Number(orderValue) : null,
      billMediaId: billMediaId || null, distanceKm, deliveryFee, deliveryFeePending, fulfilment: order.fulfillment
    });

    // Notify the customer their bill is ready (pickup vs delivery wording), with
    // the invoice PDF attached when one was uploaded.
    const to = normalizePhone(order.wa_id || order.phone);
    if (to) {
      const name = order.customer_name || "there", code = order.order_code || "";
      const msg = isDelivery
        ? `Hi ${name}, your order ${code} is billed and ready for dispatch. Our delivery agent's details will follow shortly. Thank you! 🙏`
        : `Hi ${name}, your order ${code} is billed and ready for pickup at Mukesh Medical. Thank you! 🙏`;
      await sendWhatsAppText(to, msg, { bot: true }).catch(() => {});
      if (billMediaId) await sendWhatsAppDocument(to, { link: mediaLink(billMediaId), filename: `Invoice-${code}.pdf`, caption: `Invoice ${code}` }, { bot: true }).catch(() => {});
    }
    res.json({ ok: true, order: billed });
  } catch (err) { console.error("order bill err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Procurement (Place Orders) ----
app.get("/api/place-orders", requireAuth, async (req, res) => {
  try {
    let stock = {};
    try { stock = JSON.parse(await getSetting("erp_stock") || "{}"); } catch (e) {}
    res.json(await getProcurement(stock));
  }
  catch (err) { console.error("place-orders err", err); res.status(500).json({ error: String(err) }); }
});
app.post("/api/place-orders/lock", requireAuth, async (req, res) => {
  try {
    const { productNorm, vendor } = req.body || {};
    const line = await lockProcurement(productNorm, vendor);
    res.json({ ok: true, line });
  } catch (err) { console.error("lock err", err); res.status(400).json({ error: String(err) }); }
});
app.post("/api/place-orders/line/:id/vendor", requireAuth, async (req, res) => {
  try { await editProcurementVendor(req.params.id, req.body?.vendor); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});
app.post("/api/place-orders/line/:id/delete", requireAuth, async (req, res) => {
  try { await deleteProcurementLine(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ---- Feedback ----
app.get("/api/feedback", requireAuth, async (req, res) => {
  try {
    sweepFeedbackRequests().catch(() => {}); // opportunistic sweep while dashboard is open
    res.json({ items: await listFeedback(req.query.filter || "all"), counts: await feedbackCounts() });
  } catch (err) { console.error("feedback list err", err); res.status(500).json({ error: String(err) }); }
});
app.post("/api/feedback/:id/handled", requireAuth, async (req, res) => {
  try { await markFeedbackHandled(req.params.id, req.body?.handled !== false); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// Post-order feedback sweep: a few hours after an order became ready/dispatched,
// ask the customer how it went - but only inside WhatsApp's 24h window.
let _fbSweeping = false;
async function sweepFeedbackRequests() {
  if (_fbSweeping) return; _fbSweeping = true;
  try {
    const due = await ordersNeedingFeedbackRequest(180);
    for (const o of due) {
      const to = normalizePhone(o.wa_id || o.phone);
      if (!to) { await markFeedbackRequested(o.id); continue; }
      if (!(await within24hWindow(to))) { continue; } // wait; try again later within window
      const name = o.customer_name || "there";
      await sendWhatsAppText(to, `Hi ${name}, thank you for choosing Mukesh Medical! How was your experience with order ${o.order_code}? Your feedback helps us serve you better. 🙏`, { bot: true }).catch(() => {});
      await markFeedbackRequested(o.id);
      console.log(`Feedback request sent for ${o.order_code}`);
    }
  } finally { _fbSweeping = false; }
}

// ---- ERP bridge receiver (PROFITMAKER) ----
// The small bridge program on the shop's billing PC POSTs here (token-auth).
// Body: { stock?: {productName: qty}, bill?: {orderCode, billNo, amount, invoiceBase64, invoiceMime} }
// On stock: cache it for the Place-Orders view. On bill: mark the order billed &
// ready and send the customer the invoice PDF.
app.post("/api/bridge/results", async (req, res) => {
  if (!BRIDGE_TOKEN || req.header("x-bridge-token") !== BRIDGE_TOKEN) return res.status(401).json({ error: "bad bridge token" });
  try {
    const { stock, bill } = req.body || {};
    let stockSaved = 0, billed = null;

    if (stock && typeof stock === "object") {
      const norm = {};
      for (const [name, qty] of Object.entries(stock)) { const k = normalizeProductName(name); if (k) norm[k] = Number(qty) || 0; }
      await setSetting("erp_stock", JSON.stringify(norm));
      stockSaved = Object.keys(norm).length;
    }

    if (bill && bill.orderCode) {
      const order = (await listOrders({ limit: 100000 })).find(o => o.order_code === bill.orderCode);
      if (!order) return res.json({ ok: true, stockSaved, warning: `order ${bill.orderCode} not found` });
      let billMediaId = null;
      if (bill.invoiceBase64) {
        try { billMediaId = await saveMedia({ mime: bill.invoiceMime || "application/pdf", buffer: Buffer.from(bill.invoiceBase64, "base64") }); } catch (e) {}
      }
      // No invoice attached? Generate a full tax invoice from the bill data.
      if (!billMediaId) {
        try {
          const sc = await getSettings(["seller_name", "seller_address", "seller_gstin", "seller_dl"]);
          const seller = { name: sc.seller_name || "Mukesh Medical", address: sc.seller_address || "Narayanaguda, Hyderabad", gstin: sc.seller_gstin, dl: sc.seller_dl };
          const pdf = await generateInvoicePdf(order, bill, seller);
          billMediaId = await saveMedia({ mime: "application/pdf", buffer: pdf });
        } catch (e) { console.error("invoice pdf gen err", e); }
      }
      const isDelivery = order.fulfillment === "delivery";
      let distanceKm = null, deliveryFee = null, deliveryFeePending = null;
      if (isDelivery) {
        const contact = order.wa_id ? await getConversation(order.wa_id).catch(() => null) : null;
        const q = await computeDeliveryQuote(contact?.locationLat, contact?.locationLng, bill.amount);
        distanceKm = q.distanceKm; deliveryFee = q.fee; deliveryFeePending = q.pending;
      }
      billed = await setOrderBilling(order.id, {
        billNo: bill.billNo || null, orderValue: bill.amount != null ? Number(bill.amount) : null,
        billMediaId, distanceKm, deliveryFee, deliveryFeePending, fulfilment: order.fulfillment
      });
      const to = normalizePhone(order.wa_id || order.phone);
      if (to) {
        const name = order.customer_name || "there", code = order.order_code;
        const msg = isDelivery
          ? `Hi ${name}, your order ${code} is billed and ready for dispatch. Our delivery agent's details will follow shortly. Thank you! 🙏`
          : `Hi ${name}, your order ${code} is billed and ready for pickup at Mukesh Medical. Thank you! 🙏`;
        await sendWhatsAppText(to, msg, { bot: true }).catch(() => {});
        if (billMediaId) await sendWhatsAppDocument(to, { link: mediaLink(billMediaId), filename: `Invoice-${code}.pdf`, caption: `Invoice ${code}` }, { bot: true }).catch(() => {});
      }
      console.log(`BRIDGE billed ${bill.orderCode} (bill ${bill.billNo || "-"})`);
    }
    res.json({ ok: true, stockSaved, billed: billed ? billed.order_code : null });
  } catch (err) { console.error("bridge results err", err); res.status(500).json({ error: String(err) }); }
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
// §4/§5: look up a saved customer by number (any format) to auto-fill the manual order form.
app.get("/api/customers/by-number/:wa", requireAuth, async (req, res) => {
  try { res.json({ customer: await getContactByWa(req.params.wa) }); }
  catch (err) { console.error("customer by-number err", err); res.status(500).json({ error: String(err) }); }
});
// §5: one-time migration - rewrite every stored number to 91XXXXXXXXXX and merge duplicates.
app.post("/api/customers/normalize", requireAuth, async (req, res) => {
  try { res.json({ ok: true, result: await normalizeAllNumbers() }); }
  catch (err) { console.error("normalizeAllNumbers err", err); res.status(500).json({ error: String(err) }); }
});

// ---- Retail import of existing customers (Name | Mobile | Alternate | Location) ----
// Converts DMS coordinates to lat/lng, keeps map links / landmarks as text,
// normalises phones to 91XXXXXXXXXX, upserts by phone (never duplicates), and
// marks imported customers name_confirmed so MUKCARE skips KYC.
function cleanName(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function parseDMS(str) {
  // e.g. 17°26'03.5"N 78°26'58.7"E  -> { lat, lng }
  const re = /(\d+)[°º]\s*(\d+)['′]\s*([\d.]+)["″]?\s*([NSEW])/gi;
  const found = []; let m;
  while ((m = re.exec(str)) !== null) {
    let dec = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
    const hemi = m[4].toUpperCase();
    if (hemi === "S" || hemi === "W") dec = -dec;
    found.push({ dec, hemi });
  }
  if (found.length < 2) return null;
  const lat = found.find(f => f.hemi === "N" || f.hemi === "S");
  const lng = found.find(f => f.hemi === "E" || f.hemi === "W");
  if (!lat || !lng) return null;
  return { lat: Math.round(lat.dec * 1e6) / 1e6, lng: Math.round(lng.dec * 1e6) / 1e6 };
}
app.post("/api/import/customers", requireAuth, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  let imported = 0, skipped = 0, locMissing = 0;
  const errors = [];
  for (const r of rows) {
    try {
      const name = cleanName(r.name || r.Name);
      const phone = normalizePhone(r.mobile || r.Mobile || r.phone);
      if (!phone || phone.length < 11) { skipped++; continue; }
      const alt = normalizePhone(r.alternate || r.Alternate || r.alt) || null;
      const locRaw = String(r.location || r.Location || "").trim();
      const fields = { name: name || null, source: "retail_import", nameConfirmed: true, alternateNumber: alt };
      const dms = locRaw ? parseDMS(locRaw) : null;
      if (dms) { fields.locationLat = dms.lat; fields.locationLng = dms.lng; fields.address = locRaw; }
      else if (locRaw) { fields.address = locRaw; }
      else { locMissing++; }
      await createCustomer({ phone, name: name || phone });
      await updateContact(phone, fields);
      imported++;
    } catch (e) { errors.push(String(e)); }
  }
  res.json({ ok: true, imported, skipped, locMissing, total: rows.length, errors: errors.slice(0, 5) });
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
    const events = await getEvents(order.id).catch(() => []);
    const lineItems = await getOrderItems(order.id).catch(() => []);
    res.json({ order, prescriptionMediaId, events, lineItems });
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

// ---- Public signed media (for outbound WhatsApp links: QR, invoices) ----
// No dashboard auth, but a valid HMAC token is required, so only files we chose
// to mint a link for are reachable (prescription ids won't validate).
app.get("/pub/:id", async (req, res) => {
  try {
    if ((req.query.t || "") !== mediaToken(req.params.id)) return res.sendStatus(403);
    const m = await getMedia(req.params.id);
    if (!m || !m.data) return res.sendStatus(404);
    res.set("Content-Type", m.mime || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data));
  } catch (e) { console.error("pub media err", e); res.sendStatus(500); }
});

// ---- Upload a media blob (e.g. the payment QR, a bill PDF) as base64 ----
// Body: { base64 | dataUrl, mime }. Returns { id }.
app.post("/api/media", requireAuth, async (req, res) => {
  try {
    let { base64, dataUrl, mime } = req.body || {};
    if (dataUrl && !base64) {
      const m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
      if (m) { mime = mime || m[1]; base64 = m[2]; }
    }
    if (!base64) return res.status(400).json({ error: "no data" });
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: "too large (max 8MB)" });
    const id = await saveMedia({ mime: mime || "application/octet-stream", buffer });
    res.json({ id });
  } catch (e) { console.error("media upload err", e); res.status(500).json({ error: String(e) }); }
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
  { name: "delivery_assignment", category: "UTILITY",
    body: "New delivery assigned - order {{1}}. Customer: {{2}}, phone {{3}}. Deliver to: {{4}}. Items: {{5}}. Payment: collect on delivery unless paid at billing.",
    example: ["MM-260728-001", "Suresh Raina", "9876543210", "https://maps.google.com/?q=17.4,78.4", "DOLO 650 - 2 strips"] },
];

app.post("/api/admin/create-templates", requireAuth, async (req, res) => {
  if (!ACCESS_TOKEN || !WABA_ID) return res.status(400).json({ error: "ACCESS_TOKEN and WABA_ID required" });
  const lang = req.query.lang || "en_US"; // Meta prefers a full locale code
  const results = [];
  for (const t of MUKCARE_TEMPLATE_DEFS) {
    try {
      const r = await fetch(`${GRAPH}/${WABA_ID}/message_templates`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: t.name, language: lang, category: t.category,
          components: [{ type: "BODY", text: t.body, example: { body_text: [t.example] } }]
        })
      });
      const data = await r.json();
      const e = data.error || {};
      // Treat "already exists" as success so re-runs are harmless.
      const exists = /already exists/i.test(e.message || e.error_user_msg || "");
      results.push({
        name: t.name,
        ok: r.ok || exists,
        status: exists ? "exists" : (data.status || (r.ok ? "submitted" : "error")),
        detail: (r.ok || exists) ? undefined : { message: e.message, userTitle: e.error_user_title, userMsg: e.error_user_msg, code: e.code, subcode: e.error_subcode }
      });
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
    // Post-order feedback sweep every 30 min (also runs when the Feedback tab loads).
    setInterval(() => { sweepFeedbackRequests().catch(() => {}); }, 30 * 60 * 1000);
  });
})();
