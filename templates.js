// Mukesh Medical - WhatsApp template message helpers.
//
// WhatsApp only allows free-form text replies within a 24-hour customer
// service window after the customer last messaged you. Outside that window
// (e.g. sending an unprompted "your order is ready" notification), Meta
// requires a pre-approved TEMPLATE message. This file sends templates only -
// it does not create them. Templates must first be created and approved in
// Meta Business Manager / WhatsApp Manager. See MUKCARE_TEMPLATES.md for the
// exact body text to submit and step-by-step instructions.
//
// This module is self-contained and does NOT import anything from server.js
// or db.js, so it can be dropped in without touching existing files. It
// reuses the same environment variables and Graph API shape as server.js:
//   process.env.ACCESS_TOKEN, process.env.PHONE_NUMBER_ID, process.env.GRAPH_VERSION

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---- Single source of truth for template names + parameter order ----
// Keep the `name` fields in sync with whatever you actually named the
// template when creating it in Meta Business Manager. If you rename a
// template there, update it here too - nothing else needs to change.
// `paramOrder` is documentation only (shows which {{n}} maps to which
// friendly field); the wrapper functions below build the array in this order.
export const TEMPLATES = {
  ORDER_READY: {
    name: "order_ready_pickup",
    lang: "en",
    category: "UTILITY",
    paramOrder: ["name", "orderCode"]
  },
  ORDER_DISPATCHED: {
    name: "order_dispatched",
    lang: "en",
    category: "UTILITY",
    paramOrder: ["name", "orderCode"]
  },
  ORDER_REMINDER: {
    name: "order_reminder",
    lang: "en",
    category: "UTILITY",
    paramOrder: ["name", "orderCode"]
  },
  BILL_SENT: {
    name: "bill_sent",
    lang: "en",
    category: "UTILITY",
    paramOrder: ["name", "orderCode", "amount"]
  },
  // MARKETING category - only ever send this to contacts who have opted in.
  // See the MARKETING_OPT_IN note in campaigns.js.
  PROMO_GENERIC: {
    name: "promo_generic",
    lang: "en",
    category: "MARKETING",
    paramOrder: ["name", "message"]
  },
  // Sent to a delivery executive with the order + customer details.
  DELIVERY_ASSIGN: {
    name: "delivery_assignment",
    lang: "en",
    category: "UTILITY",
    paramOrder: ["orderCode", "customerName", "phone", "address", "items"]
  }
};

/**
 * Low-level: send an approved WhatsApp template message.
 *
 * @param {string} to - recipient wa_id, digits only (e.g. "919390327200")
 * @param {string} templateName - exact template name as approved in Meta
 * @param {string} langCode - template language code, e.g. "en", "hi", "te"
 * @param {Array<string|number>} [bodyParams] - ordered values for {{1}}, {{2}}, ...
 * @returns {Promise<{ok: boolean, id?: string, error?: any, data?: any}>}
 */
export async function sendTemplate(to, templateName, langCode, bodyParams = []) {
  const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("sendTemplate: ACCESS_TOKEN / PHONE_NUMBER_ID not set - skipping send.");
    return { ok: false, error: "ACCESS_TOKEN / PHONE_NUMBER_ID not set." };
  }
  if (!to || !templateName) {
    return { ok: false, error: "to and templateName are required." };
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: langCode || "en" },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })) }]
        : []
    }
  };

  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("sendTemplate err", templateName, data);
      return { ok: false, error: data };
    }
    return { ok: true, id: data.messages?.[0]?.id, data };
  } catch (err) {
    console.error("sendTemplate exception", templateName, err);
    return { ok: false, error: String(err) };
  }
}

// ---- Convenience wrappers ----
// Each wrapper takes a friendly params object and maps it to the exact
// {{1}}, {{2}}, ... order declared in TEMPLATES above, so call sites never
// need to remember positional order.

/** Notify a customer their order is ready for in-store pickup. */
export async function sendOrderReady(to, { name, orderCode } = {}) {
  const t = TEMPLATES.ORDER_READY;
  return sendTemplate(to, t.name, t.lang, [name, orderCode]);
}

/** Notify a customer their order has been dispatched for home delivery. */
export async function sendOrderDispatched(to, { name, orderCode } = {}) {
  const t = TEMPLATES.ORDER_DISPATCHED;
  return sendTemplate(to, t.name, t.lang, [name, orderCode]);
}

/** Send a general reminder about an existing order. */
export async function sendOrderReminder(to, { name, orderCode } = {}) {
  const t = TEMPLATES.ORDER_REMINDER;
  return sendTemplate(to, t.name, t.lang, [name, orderCode]);
}

/** Notify a customer their bill is ready, including the amount. */
export async function sendBillSent(to, { name, orderCode, amount } = {}) {
  const t = TEMPLATES.BILL_SENT;
  return sendTemplate(to, t.name, t.lang, [name, orderCode, amount]);
}

/**
 * Send a generic MARKETING promo template.
 * Only call this for contacts who have explicitly opted in to promotional
 * messages - see MARKETING_OPT_IN in campaigns.js. Prefer using
 * campaigns.js/sendCampaign() for bulk sends, which enforces spam/opt-out
 * skipping and records results.
 */
export async function sendPromoGeneric(to, { name, message } = {}) {
  const t = TEMPLATES.PROMO_GENERIC;
  return sendTemplate(to, t.name, t.lang, [name, message]);
}

/** Notify a delivery executive of an assigned order with customer details. */
export async function sendDeliveryAssignment(to, { orderCode, customerName, phone, address, items } = {}) {
  const t = TEMPLATES.DELIVERY_ASSIGN;
  return sendTemplate(to, t.name, t.lang, [orderCode, customerName, phone, address, items]);
}

/**
 * §7: Deliver a delivery order's invoice OUTSIDE the 24h window using the
 * approved `billed_ready_delivery` template, which carries a DOCUMENT header
 * so the actual invoice PDF is attached. Created in en_US (see the
 * create-delivery-template route), so it must be sent with the same code.
 */
export async function sendBilledReadyDelivery(to, { name, orderCode, docLink, filename } = {}) {
  const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) return { ok: false, error: "ACCESS_TOKEN / PHONE_NUMBER_ID not set." };
  if (!to || !docLink) return { ok: false, error: "to and docLink are required." };
  const payload = {
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: "billed_ready_delivery", language: { code: "en_US" },
      components: [
        { type: "header", parameters: [{ type: "document", document: { link: docLink, filename: filename || `Invoice-${orderCode || ""}.pdf` } }] },
        { type: "body", parameters: [{ type: "text", text: String(name || "there") }, { type: "text", text: String(orderCode || "") }] }
      ]
    }
  };
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) { console.error("sendBilledReadyDelivery err", data); return { ok: false, error: data }; }
    return { ok: true, id: data.messages?.[0]?.id, data };
  } catch (err) { console.error("sendBilledReadyDelivery exception", err); return { ok: false, error: String(err) }; }
}
