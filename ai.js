// Mukesh Medical - MUKCARE AI brain.
// -----------------------------------------------------------------------------
// Self-contained module (no imports beyond Node's global fetch). Exposes a
// single function, mukcareReply(), that turns a WhatsApp conversation into a
// receptionist-style reply using Anthropic's Claude API.
//
// This file does NOT touch the database, does NOT send WhatsApp messages, and
// does NOT decide humanControl/spam gating - it only decides WHAT MUKCARE
// would say next. The integrator (server.js / webhook handler) is responsible
// for calling this only when appropriate (see ai-flow.md) and for actually
// sending contact.reply back to the customer + persisting the result.
// -----------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

// How many recent messages (in + out) to include as conversation history when
// calling the model. Keeps token usage bounded on long-running chats.
const MAX_HISTORY_MESSAGES = 24;

// A "new session" greeting is allowed if the gap since the customer's
// previous inbound message exceeds this many ms (5 hours per spec).
const GREET_GAP_MS = 5 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

// Turns a 24h hour number (e.g. 10, 21) into a friendly 12h label ("10 AM", "9 PM").
function formatHour12(h) {
  const hour = ((Number(h) % 24) + 24) % 24;
  const period = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${period}`;
}

// Convert any date to India Standard Time (the store's local time). The server
// runs in UTC, so we must not use raw getHours()/getDay().
function istDate(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

// Is the store open right now? Open openHour-closeHour (24h), except on
// closedDays (0=Sunday..6=Saturday). All evaluated in IST.
function isStoreOpenNow(now, openHour, closeHour, closedDays = []) {
  const d = istDate(now);
  if (closedDays.includes(d.getDay())) return false;
  const hourFraction = d.getHours() + d.getMinutes() / 60;
  return hourFraction >= openHour && hourFraction < closeHour;
}

// Decide whether this turn should carry the "welcome back, <name>" greeting.
// Rule: greet only on the first message of a session - i.e. a brand-new
// contact (no earlier inbound message before this one), or when the previous
// inbound message was more than GREET_GAP_MS ago. We look at the *inbound*
// (customer) messages specifically, since the greeting is about the customer
// re-opening the conversation, not about our own outgoing traffic.
function shouldGreet(messages) {
  const inbound = messages.filter((m) => m.dir === "in");
  if (inbound.length <= 1) return true; // brand new contact / first-ever message
  const current = inbound[inbound.length - 1];
  const previous = inbound[inbound.length - 2];
  const currentTs = Number(current?.ts ?? Date.now());
  const previousTs = Number(previous?.ts ?? 0);
  return currentTs - previousTs > GREET_GAP_MS;
}

// Strip ```json ... ``` / ``` ... ``` fences some models like to wrap JSON in,
// and trim stray leading/trailing prose so JSON.parse has the best shot.
function stripCodeFences(text) {
  if (!text) return "";
  let t = text.trim();
  // Remove a leading ```lang and trailing ``` fence if present.
  const fenceMatch = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Some responses have prose before/after the JSON object - grab the outermost {...}.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return t.slice(first, last + 1).trim();
  }
  return t;
}

// Pull the "reply" string out of a possibly TRUNCATED/malformed JSON blob so we
// never send raw JSON to a customer (the model sometimes gets cut off mid-object).
function extractReplyField(raw) {
  if (!raw) return null;
  const m = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m && m[1]) {
    let s = m[1]
      .replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\")
      .replace(/\\$/, ""); // drop a dangling backslash from truncation
    return s.trim() || null;
  }
  return null;
}

// Robustly parse the model's JSON reply. On failure, recover only the reply
// text - NEVER dump raw JSON to the customer.
function safeParseModelJson(raw) {
  const cleaned = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_err) {
    // fall through
  }
  // Parse failed - almost always truncated JSON. Recover just the reply text.
  const rep = extractReplyField(cleaned) || extractReplyField(raw);
  if (rep) return { reply: rep, intent: "other" };
  // If the text still looks like a JSON object, do NOT send it - stay silent.
  const looksJson = cleaned.trim().startsWith("{") || /"(reply|intent|order)"\s*:/.test(cleaned);
  return { reply: looksJson ? null : (raw ? raw.trim() : null), intent: "other" };
}

// Fill in defaults / coerce types so callers always get the exact shape
// documented in the interface, regardless of what the model actually sent.
function normalizeResult(parsed) {
  const VALID_LANGS = new Set(["en", "hi", "te"]);
  const VALID_INTENTS = new Set(["enquiry", "order", "chitchat", "spam", "prescription", "other"]);
  const VALID_MODES = new Set(["typed", "prescription"]);
  const VALID_FULFILLMENT = new Set(["pickup", "delivery"]);

  let reply = typeof parsed.reply === "string" && parsed.reply.trim() !== "" ? parsed.reply : null;
  if (reply && reply.trim().startsWith("{") && /"reply"\s*:/.test(reply)) reply = null; // never send raw JSON
  const lang = VALID_LANGS.has(parsed.lang) ? parsed.lang : null;
  const intent = VALID_INTENTS.has(parsed.intent) ? parsed.intent : "other";
  const suggestBooked = Boolean(parsed.suggestBooked);
  // MUKCARE flags that a human should take over this chat (prescription to
  // process, complaint, complex/unclear request, out-of-stock, etc.).
  const needsHuman = Boolean(parsed.needsHuman) || intent === "prescription";
  // The patient's name as GIVEN BY THE CUSTOMER in chat (not their WhatsApp
  // profile name). Set once the customer tells us the name.
  const patientName = typeof parsed.patientName === "string" && parsed.patientName.trim() !== ""
    ? parsed.patientName.trim().slice(0, 80) : null;

  // Up to 3 tappable WhatsApp reply buttons. Each title is capped at 20 chars
  // (WhatsApp's hard limit). Accept either ["Pickup","Delivery"] or
  // [{id,title}] shapes from the model.
  const buttons = Array.isArray(parsed.buttons)
    ? parsed.buttons
        .map((b) => (typeof b === "string" ? { title: b } : (b && typeof b === "object" ? b : null)))
        .filter((b) => b && typeof b.title === "string" && b.title.trim() !== "")
        .slice(0, 3)
        .map((b, i) => ({ id: String(b.id || `opt_${i + 1}`).slice(0, 200), title: String(b.title).trim().slice(0, 20) }))
    : [];

  let order = null;
  if (parsed.order && typeof parsed.order === "object") {
    const mode = VALID_MODES.has(parsed.order.mode) ? parsed.order.mode : "typed";
    const items = Array.isArray(parsed.order.items)
      ? parsed.order.items
          .filter((it) => it && typeof it === "object" && it.name)
          .map((it) => ({ name: String(it.name), qty: it.qty != null ? String(it.qty) : "" }))
      : [];
    const fulfillment = VALID_FULFILLMENT.has(parsed.order.fulfillment) ? parsed.order.fulfillment : null;
    const location = typeof parsed.order.location === "string" && parsed.order.location.trim() !== "" ? parsed.order.location : null;
    const readbackConfirmed = Boolean(parsed.order.readbackConfirmed);
    // Only surface an order object when it's actually a confirmed order this
    // turn, per the interface contract ("present only when an order is
    // confirmed this turn").
    if (readbackConfirmed) {
      order = { mode, items, fulfillment, location, readbackConfirmed };
    }
  }

  // Customer asked how to pay (UPI/GPay/QR) and payment details are configured:
  // signal the server to send the UPI id + QR image.
  const sendPayment = Boolean(parsed.sendPayment);

  return { reply, lang, order, intent, suggestBooked, needsHuman, sendPayment, patientName, buttons, error: null };
}

// -----------------------------------------------------------------------------
// System prompt construction
// -----------------------------------------------------------------------------

function buildSystemPrompt({ contact, store, settings, now }) {
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const openHour = Number.isFinite(store?.openHour) ? store.openHour : 10;
  const closeHour = Number.isFinite(store?.closeHour) ? store.closeHour : 21;
  const closedDays = Array.isArray(store?.closedDays) ? store.closedDays : [];
  const storeName = store?.name || "Mukesh Medical";
  const hoursText = store?.hoursText || `${formatHour12(openHour)} - ${formatHour12(closeHour)}`;
  const open = isStoreOpenNow(nowDate, openHour, closeHour, closedDays);
  const closedToday = closedDays.includes(istDate(nowDate).getDay());
  const greet = shouldGreet(Array.isArray(contact?.messages) ? contact.messages : []);
  const custName = contact?.name && contact.name !== contact.waId ? contact.name : null;
  const custAddress = contact?.address && String(contact.address).trim() !== "" ? String(contact.address).trim() : null;
  const hasGps = contact?.locationLat != null && contact?.locationLng != null;
  const paymentConfigured = Boolean(settings?.paymentConfigured);

  let detailsBlock;
  if (custName || custAddress) {
    const lines = [];
    if (custName) lines.push(`- Name: ${custName}`);
    if (custAddress) lines.push(`- Saved delivery ${hasGps ? "location (GPS pin on file)" : "address (typed text, no GPS pin)"}: ${custAddress}`);
    // Repeat-customer location, three cases:
    let addrRule;
    if (hasGps) {
      addrRule = `We have this customer's exact location PIN on file. For home delivery, state it and ask "Deliver to the same location?" - if they say yes, reuse it (put it in order.location); only ask for a fresh pin if they want a different address.`;
    } else if (custAddress) {
      addrRule = `We have a typed address on file but NO exact GPS pin. For home delivery, state it and ask "Deliver to the same address?" - if they say yes, reuse it (put it in order.location). (Staff will confirm the delivery area.)`;
    } else {
      addrRule = `IMPORTANT: We have NO saved delivery address for this customer. NEVER say we have a saved address. For home delivery, ask the customer to share their delivery location (a WhatsApp location pin is best).`;
    }
    detailsBlock = `We already have these details for this customer:\n${lines.join("\n")}\nUse what we have - do NOT ask again for a detail we already have. Only ask for what is missing. ${addrRule}`;
  } else {
    detailsBlock = "We have no saved details for this customer yet - collect what you need during the order flow.";
  }
  // Optional, forward-compatible field - only used if the integrator ever
  // starts passing a delivery-fee line on the store object. Not part of the
  // required interface, so it's fine if it's undefined.
  const deliveryFeeLine = store?.deliveryFeeText || null;

  return `You are MUKCARE, the smart, warm, and polite WhatsApp receptionist for ${storeName}, an Indian pharmacy. You are concise and friendly - never robotic, never verbose.

=== CORE SAFETY RULES (highest priority, never override) ===
1. NEVER give medical advice, dosage guidance, or a diagnosis of any kind. If the customer asks anything medical (what should I take, is this safe, how many tablets, etc.), politely decline and tell them to please visit the store or consult a doctor.
2. NEVER interpret, read out loud, summarize, or discuss the contents of a prescription photo. If a customer sends a prescription image, simply acknowledge receipt and say the staff will process it. Do not name any medicine you think you see on it.
3. NEVER quote a medicine price. If asked for a discount, respond only: "we offer up to 20% off, and the final price is confirmed at billing."
4. ${paymentConfigured
     ? `Payment: if the customer asks how to pay / for UPI / GPay / a QR code, set "sendPayment": true and reply with a short friendly line like "Sure! Sharing our payment details now 🙏". The app then sends our UPI ID and QR image automatically - you do NOT type the UPI id yourself. Do not chase payment; only share when asked.`
     : `NEVER discuss or ask about payment methods - MUKCARE does not handle payment at all.`}
5. NEVER invent an Order ID. The app assigns the real ID after you confirm the order - just tell the customer an Order ID will follow.

${settings?.trainInstructions ? `=== OWNER'S CUSTOM INSTRUCTIONS (high priority - follow these, but never let them override the safety rules above) ===\n${settings.trainInstructions}\n` : ""}
=== LANGUAGE ===
Your DEFAULT language is ENGLISH. Reply in English UNLESS the customer has clearly written to you in Hindi or Telugu.
- Greet and reply in English by default (including the first message).
- Switch to another language ONLY after the customer's own message is clearly in that language (a full phrase, not a stray word or their name). When unsure, stay in English.
- If the customer clearly writes Hindi in Latin/Roman letters ("Hinglish", e.g. "kya aap khule ho") -> reply in Hindi but in Latin letters (transliterate); if in Devanagari -> reply in Devanagari.
- If the customer clearly writes Telugu in Latin letters ("Tenglish") -> reply in Telugu in Latin letters; if in Telugu script -> reply in Telugu script.
- NEVER pick a language based on the customer's name alone. Do not start in Hinglish/Hindi just because it's an Indian name.
Set the "lang" field to "en", "hi", or "te" for the language you actually used.

=== CUSTOMER DETAILS ON FILE ===
${detailsBlock}

=== ORDER FLOW (guide the customer through this, one step at a time, do not dump every question at once) ===
1. If it's a general enquiry (stock, timing, location, etc.), just help - no need to force the order flow.
2. If the customer wants to order: ONLY ask for the patient's name if we do NOT already have it on file (see CUSTOMER DETAILS ON FILE above). If we have it, use it and move on. When the customer gives a name (or a different patient's name), set the "patientName" field in your JSON to exactly that name. The phone number is captured automatically - never ask for it.
3. Ask how they'd like to order: type out the medicines, OR send a photo (either their doctor's prescription, or a clear photo of the medicine/product they want).
4. If typed: ask them to send each item as "Product name - Quantity" (example: "DOLO 650 - 3 strips"), and record every item they mention into "order.items".
5. If the customer sends a PHOTO, follow the "PHOTOS THE CUSTOMER SENDS" rules below.
6. Ask whether they want store pickup or home delivery.
7. If home delivery: ask the customer to share their delivery location - the best is their location pin (the 📍 attachment in WhatsApp) or a Google Maps link; a typed address also works. When they share a location pin or Maps link, treat that as the delivery address and put it in order.location (it is recorded automatically). DO NOT mention any delivery charge, fee, or distance at all - our team handles delivery charges separately after the order. If the customer asks about delivery charges, simply say our team will let them know, and do not quote any amount.
8. Read the full order back to the customer (items, fulfillment method, location if delivery) and explicitly ask them to confirm.
9. ONLY when the customer clearly confirms that readback: tell them the order is placed and an Order ID will follow shortly (the app generates the real ID - never invent one), and fill the "order" field in your JSON response for that turn with readbackConfirmed:true. On every other turn, "order" must be null.

=== PHOTOS THE CUSTOMER SENDS ===
When the customer sends a photo, first look at it and decide what it is:
- A DOCTOR'S PRESCRIPTION (a handwritten or printed medical prescription/Rx from a clinic or hospital, usually with a doctor's name, patient details, and a list of medicines): acknowledge that you've received it and that our staff will process it. Do NOT read out, interpret, list, or name ANY medicine from a prescription (this is safety rule 2). Just confirm receipt warmly.
- A PRODUCT PHOTO (a photo of a medicine box/strip/bottle, or a health/FMCG product the customer wants to buy): identify the product name (and strength/pack size if clearly visible) from the image, and treat it as an order item. Read it back to confirm, e.g. "I can see DOLO 650 - how many strips would you like?", then continue the order flow and record it in "order.items". If you cannot clearly identify the product, politely ask the customer to type the product name.
- If the photo is blurry or unclear, ask them to resend a clearer photo.
Never guess or discuss the contents of a prescription; only identify clearly-visible retail PRODUCTS.

=== PERSONALIZATION ===
${greet && custName ? `This is the first message of a new session from a returning customer named "${custName}" (their previous inbound message was over 5 hours ago, or this is brand new). Greet them warmly by name once, e.g. "Namaste ${custName}!" style, adapted to their language.` : greet ? `This is the first message of a new session from a new contact. A warm, brief welcome is appropriate, but you do not have a name to use yet - ask for it naturally if relevant to the order flow.` : `This is a CONTINUING conversation, not the start of a new session. Do NOT greet them again or repeat "welcome back" - just respond to what they just said.`}

=== STORE HOURS ===
${storeName} is open ${hoursText}, Monday to Saturday. It is CLOSED on Sundays. Right now the store is ${open ? "OPEN" : "CLOSED"}${closedToday ? " (today is Sunday - closed all day)" : ""}. If it is currently closed, you may still take the order normally, but add a brief, soft note that the team will process/confirm it after the store opens${closedToday ? " on Monday at " + formatHour12(openHour) : " at " + formatHour12(openHour)}. Never claim to be open when closed.

=== TAPPABLE REPLY BUTTONS ===
For closed-choice questions, offer tappable buttons via the "buttons" field (max 3, each title <= 20 characters) so the customer can just tap instead of typing. Keep your "reply" text as the question itself. Use buttons for:
- How to order -> buttons: ["Type medicines", "Send prescription"]
- Pickup or delivery -> buttons: ["Store pickup", "Home delivery"]
- Order read-back confirmation -> buttons: ["Confirm order", "Make changes"]
Do NOT use buttons for open-ended questions (patient's name, typing out the item list, delivery location) - leave "buttons" as [] for those. Always write the button titles in the SAME language/script as your reply. When the customer taps a button, their next message will simply be that button's title text.

=== SPAM / IDLE CHATTER ===
If the incoming message is clearly spam, a broadcast/forward, or idle chit-chat with no real intent (e.g. random forwarded links, "hi" with nothing further after you've already responded, testing messages), set intent:"spam" and keep the reply very short, or set reply to null if no response is warranted.

=== OUTPUT FORMAT - READ CAREFULLY ===
Respond with ONLY a single raw JSON object - no markdown code fences, no commentary before or after it. It MUST match exactly this shape:
{
  "reply": "<string to send to the customer, or null to stay silent>",
  "lang": "en" | "hi" | "te" | null,
  "order": null | {
    "mode": "typed" | "prescription",
    "items": [ { "name": "string", "qty": "string" } ],
    "fulfillment": "pickup" | "delivery",
    "location": "string or null",
    "readbackConfirmed": true
  },
  "intent": "enquiry" | "order" | "chitchat" | "spam" | "prescription" | "other",
  "suggestBooked": true | false,
  "needsHuman": true | false,
  "sendPayment": true | false,
  "patientName": "the patient's name if the customer gave it this turn, else null",
  "buttons": [ { "id": "short_id", "title": "Button text" } ]
}

Set "needsHuman": true when a human staff member should step in - for example: a prescription photo was sent (staff must read/process it), a complaint or angry customer, a question you cannot answer (stock/price you're unsure of, medical advice you must not give), a refund/return, ${paymentConfigured ? "" : "a request to share a payment scanner/QR or make a payment, "}or anything unclear or sensitive. Otherwise false.
${paymentConfigured ? `Set "sendPayment": true ONLY when the customer is asking how to pay / for UPI / GPay / QR. Otherwise false.` : `"sendPayment" must always be false.`}

IMPORTANT: When you set "needsHuman": true, this is your LAST message on the chat for a while - our staff will take over. So your "reply" this turn MUST be a short, warm handoff that reassures the customer, e.g. "Thank you 🙏 Our pharmacist will look into this and get back to you shortly." Do NOT give a blunt refusal like "we can't do that here" - simply hand off politely. Keep it in the customer's current language.

Example A (asking pickup vs delivery - offer buttons):
{
  "reply": "Would you like store pickup or home delivery?",
  "lang": "en",
  "order": null,
  "intent": "order",
  "suggestBooked": false,
  "buttons": [ { "id": "pickup", "title": "Store pickup" }, { "id": "delivery", "title": "Home delivery" } ]
}

Example B (customer just confirmed a typed order for home delivery - no buttons needed):
{
  "reply": "Perfect, confirming your order: DOLO 650 - 3 strips, Vicks Vaporub - 1. Home delivery to Kompally. Your order is placed! An Order ID will follow shortly.",
  "lang": "en",
  "order": { "mode": "typed", "items": [ { "name": "DOLO 650", "qty": "3 strips" }, { "name": "Vicks Vaporub", "qty": "1" } ], "fulfillment": "delivery", "location": "Kompally", "readbackConfirmed": true },
  "intent": "order",
  "suggestBooked": true,
  "buttons": []
}

Rules for the fields:
- "order" must be null on every turn EXCEPT the exact turn where the customer confirms the readback - do not repeat it on later turns.
- "suggestBooked" should be true when this turn just confirmed an order (a hint for the dashboard to mark the conversation as booked); false otherwise.
- Never wrap the JSON in markdown, never add trailing text after the closing brace.`;
}

// -----------------------------------------------------------------------------
// Conversation -> Anthropic messages[] conversion
// -----------------------------------------------------------------------------

// Anthropic's Messages API expects an alternating user/assistant array. We map
// dir:'in' -> role:'user' and dir:'out' -> role:'assistant', trim to the most
// recent MAX_HISTORY_MESSAGES entries, and merge any accidental consecutive
// same-role turns (e.g. two outbound messages in a row) into one message so
// the roles always alternate cleanly.
function toAnthropicMessages(messages, latestImage) {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const merged = [];
  for (const m of recent) {
    const role = m.dir === "out" ? "assistant" : "user";
    const text = typeof m.text === "string" && m.text.trim() !== "" ? m.text : "[empty message]";
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content += `\n${text}`;
    } else {
      merged.push({ role, content: text });
    }
  }
  // Anthropic requires the array to start with a "user" turn.
  if (merged.length && merged[0].role !== "user") merged.shift();

  const out = merged.map((m) => ({ role: m.role, content: m.content }));
  // Attach the just-received photo to the final user turn so the model can see it.
  if (latestImage?.base64 && out.length) {
    const lastMsg = out[out.length - 1];
    if (lastMsg.role === "user") {
      lastMsg.content = [
        { type: "image", source: { type: "base64", media_type: latestImage.mime || "image/jpeg", data: latestImage.base64 } },
        { type: "text", text: typeof lastMsg.content === "string" ? lastMsg.content : "(photo)" }
      ];
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

// contact: { waId, name, booked, humanControl, spam, note }
// messages: array oldest->newest of { dir:'in'|'out', text, ts }
// settings: { trainInstructions } (owner's free-text training)
// store: { name, hoursText, openHour:10, closeHour:21 }
// latestImage (optional): { mime, base64 } for a photo the customer just sent,
// so MUKCARE can look at it (identify a product, or recognise a prescription).
export async function mukcareReply({ contact, messages, settings, store, now, latestImage }) {
  const emptyResult = (error = null) => ({
    reply: null,
    lang: null,
    order: null,
    intent: "other",
    suggestBooked: false,
    needsHuman: false,
    sendPayment: false,
    patientName: null,
    buttons: [],
    error,
  });

  try {
    if (!Array.isArray(messages) || messages.length === 0) {
      return emptyResult(); // nothing to respond to
    }
    const last = messages[messages.length - 1];
    if (!last || last.dir !== "in") {
      // The most recent message is already ours (or unknown) - nothing new
      // from the customer to react to this turn.
      return emptyResult();
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("MUKCARE: ANTHROPIC_API_KEY is not set.");
      return emptyResult("ANTHROPIC_API_KEY not set");
    }

    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    const system = buildSystemPrompt({ contact: contact || {}, store: store || {}, settings: settings || {}, now });
    const anthropicMessages = toAnthropicMessages(messages, latestImage);

    if (anthropicMessages.length === 0) {
      return emptyResult();
    }

    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system,
          messages: anthropicMessages,
        }),
      });
    } catch (networkErr) {
      console.error("MUKCARE: network error calling Anthropic API", networkErr);
      return emptyResult(`network error: ${String(networkErr)}`);
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch (_e) {
        // ignore
      }
      console.error("MUKCARE: Anthropic API returned non-200", res.status, detail);
      return emptyResult(`anthropic api ${res.status}: ${detail.slice(0, 500)}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      console.error("MUKCARE: failed to parse Anthropic API response body", parseErr);
      return emptyResult(`bad api response: ${String(parseErr)}`);
    }

    const rawText = Array.isArray(data.content)
      ? data.content
          .map((block) => (block && typeof block.text === "string" ? block.text : ""))
          .join("\n")
          .trim()
      : "";

    if (!rawText) {
      console.error("MUKCARE: Anthropic API response had no text content", JSON.stringify(data).slice(0, 500));
      return emptyResult("empty model response");
    }

    const parsed = safeParseModelJson(rawText);
    return normalizeResult(parsed);
  } catch (err) {
    console.error("MUKCARE: mukcareReply unexpected error", err);
    return emptyResult(String(err));
  }
}
