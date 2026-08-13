// Mukesh Medical - Orders + Delivery-Executive data model and operations.
// Self-contained module: does not modify any existing files. Import { pool }
// from the shared db.js and reuses it here. Falls back to an in-memory store
// (mirroring db.js's fallback style) when DATABASE_URL isn't set / pool is null,
// so the app keeps working during setup (not persistent across restarts).
import { pool } from "./db.js";

// Allowed order lifecycle values (documented here; not enforced by a DB CHECK
// so that new statuses can be added later without a migration):
//   new -> ready -> dispatched -> collected|billed
//   cancelled, partially_fulfilled, returned  (can occur from most states)
export const ORDER_STATUSES = [
  // Current set used by the dashboard:
  "new", "cancelled", "billed_ready", "billed_dispatched",
  // Legacy values kept so old records / API calls still validate:
  "ready", "dispatched", "collected", "billed", "partially_fulfilled", "returned"
];

// ---- Fallback in-memory store (used only when no DATABASE_URL) ----
const mem = {
  orders: [],   // rows, same shape as Postgres rows
  execs: [],
  events: [],       // { id, order_id, kind, detail, created_at }
  orderItems: [],   // { id, order_id, ... }
  procurement: [],  // procurement_lines
  feedback: [],     // feedback rows
  prescriptions: [],
  learning: [],
  nextOrderId: 1,
  nextExecId: 1,
  nextSeq: 1,
};

function todayStamp(d = new Date()) {
  // YYMMDD in local server time
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// ---- Schema ----
export async function initOrders() {
  if (!pool) {
    console.warn("DATABASE_URL not set - orders/execs running WITHOUT persistence (in-memory).");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS execs (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT,
      phone      TEXT,
      area       TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id                BIGSERIAL PRIMARY KEY,
      order_code        TEXT UNIQUE,
      wa_id             TEXT,
      customer_name     TEXT,
      phone             TEXT,
      mode              TEXT,           -- 'typed' | 'prescription'
      items             JSONB,          -- [{name, qty}, ...]
      prescription_url  TEXT,
      fulfillment       TEXT,           -- 'pickup' | 'delivery'
      address           TEXT,
      distance_km       NUMERIC,
      delivery_fee      INT,
      status            TEXT NOT NULL DEFAULT 'new',
      -- Allowed statuses (documented, not DB-enforced so new ones can be added
      -- without a migration): new, ready, dispatched, collected, billed,
      -- cancelled, partially_fulfilled, returned
      exec_id           BIGINT REFERENCES execs(id),
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_wa_id ON orders(wa_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

    -- Billing / delivery / lifecycle fields added as the system grew.
    -- All idempotent so this is safe to re-run on every boot.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS patient_name         TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_value          NUMERIC;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_no              TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_media_id        BIGINT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at             TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS feedback_requested   BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_pending BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat         DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng         DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS days_supply          INT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS rx_note              TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS incomplete           BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS needs_review         BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted              BOOLEAN NOT NULL DEFAULT FALSE;

    -- Per-line order items (in addition to the legacy JSONB orders.items column,
    -- which is kept for backward compatibility). New code should prefer this table.
    CREATE TABLE IF NOT EXISTS order_items (
      id               BIGSERIAL PRIMARY KEY,
      order_id         BIGINT REFERENCES orders(id) ON DELETE CASCADE,
      name             TEXT,
      pack             TEXT,
      quantity         TEXT,
      dosage           TEXT,
      duration         TEXT,
      calc_note        TEXT,
      duration_missing BOOLEAN NOT NULL DEFAULT FALSE,
      not_required     BOOLEAN NOT NULL DEFAULT FALSE,
      placed_line_id   BIGINT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

    -- Audit timeline: one row per lifecycle event (status change, note, message).
    CREATE TABLE IF NOT EXISTS order_events (
      id         BIGSERIAL PRIMARY KEY,
      order_id   BIGINT REFERENCES orders(id) ON DELETE CASCADE,
      kind       TEXT,          -- 'status' | 'message' | 'system'
      detail     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

    -- Procurement: vendor-locked purchase batches aggregated across orders.
    CREATE TABLE IF NOT EXISTS procurement_lines (
      id            BIGSERIAL PRIMARY KEY,
      product_norm  TEXT,
      product_name  TEXT,
      qty_placed    NUMERIC,
      stock_used    NUMERIC,
      total_ordered NUMERIC,
      vendor        TEXT,
      contributing  JSONB,
      placed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Customer feedback captured after an order, with AI sentiment.
    CREATE TABLE IF NOT EXISTS feedback (
      id         BIGSERIAL PRIMARY KEY,
      wa_id      TEXT,
      order_id   BIGINT,
      sentiment  TEXT,          -- 'positive' | 'neutral' | 'negative'
      text       TEXT,
      handled    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_handled ON feedback(handled);

    -- Uploaded prescription / product images + the AI's draft reading (staff-only).
    CREATE TABLE IF NOT EXISTS prescriptions (
      id         BIGSERIAL PRIMARY KEY,
      wa_id      TEXT,
      order_id   BIGINT,
      media_id   BIGINT,
      kind       TEXT,          -- 'prescription'|'product_photo'|'document'|'unclear'
      draft      JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Verified prescription readings that improve future vision reads.
    CREATE TABLE IF NOT EXISTS learning_examples (
      id         BIGSERIAL PRIMARY KEY,
      kind       TEXT,
      input      TEXT,
      verified   JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("Orders/execs schema ready (Postgres).");
}

// ---- Order code generation: MM-YYMMDD-NNN (NNN = daily sequence, 001-based) ----
async function nextOrderCode(d = new Date()) {
  const stamp = todayStamp(d);
  const prefix = `MM-${stamp}-`;
  if (pool) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE order_code LIKE $1`,
      [`${prefix}%`]
    );
    const seq = (rows[0]?.n || 0) + 1;
    return `${prefix}${String(seq).padStart(3, "0")}`;
  } else {
    const n = mem.orders.filter(o => o.order_code && o.order_code.startsWith(prefix)).length + 1;
    return `${prefix}${String(n).padStart(3, "0")}`;
  }
}

// data: { waId, customerName, phone, mode, items, prescriptionUrl, fulfillment,
//         address, distanceKm, deliveryFee, notes, status }
export async function createOrder(data) {
  const orderCode = await nextOrderCode();
  const status = data.status || "new";
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO orders
         (order_code, wa_id, customer_name, phone, mode, items, prescription_url,
          fulfillment, address, distance_km, delivery_fee, status, exec_id, notes, patient_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        orderCode,
        data.waId || null,
        data.customerName || null,
        data.phone || null,
        data.mode || "typed",
        JSON.stringify(data.items || []),
        data.prescriptionUrl || null,
        data.fulfillment || null,
        data.address || null,
        data.distanceKm ?? null,
        data.deliveryFee ?? null,
        status,
        data.execId || null,
        data.notes || null,
        data.patientName || null,
      ]
    );
    await logEvent(rows[0].id, "status", `Order created (${status})`);
    return rows[0];
  } else {
    const row = {
      id: mem.nextOrderId++,
      order_code: orderCode,
      wa_id: data.waId || null,
      customer_name: data.customerName || null,
      phone: data.phone || null,
      mode: data.mode || "typed",
      items: data.items || [],
      prescription_url: data.prescriptionUrl || null,
      fulfillment: data.fulfillment || null,
      address: data.address || null,
      distance_km: data.distanceKm ?? null,
      delivery_fee: data.deliveryFee ?? null,
      status,
      exec_id: data.execId || null,
      notes: data.notes || null,
      order_value: data.orderValue ?? null,
      bill_no: data.billNo ?? null,
      bill_media_id: data.billMediaId ?? null,
      ready_at: null,
      feedback_requested: false,
      delivery_fee_pending: data.deliveryFeePending ?? false,
      delivery_lat: data.deliveryLat ?? null,
      delivery_lng: data.deliveryLng ?? null,
      days_supply: data.daysSupply ?? null,
      patient_name: data.patientName ?? null,
      deleted: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
    mem.orders.push(row);
    await logEvent(row.id, "status", `Order created (${status})`);
    return row;
  }
}

// ---- Order event timeline ----
export async function logEvent(orderId, kind, detail) {
  if (!orderId) return;
  if (pool) {
    await pool.query(
      `INSERT INTO order_events (order_id, kind, detail) VALUES ($1,$2,$3)`,
      [orderId, kind || "system", detail || ""]
    );
  } else {
    mem.events.push({ id: mem.nextSeq++, order_id: Number(orderId), kind: kind || "system", detail: detail || "", created_at: new Date() });
  }
}

export async function getEvents(orderId) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT id, kind, detail, EXTRACT(EPOCH FROM created_at)*1000 AS ts
       FROM order_events WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );
    return rows.map(r => ({ id: r.id, kind: r.kind, detail: r.detail, ts: Number(r.ts) }));
  }
  return mem.events.filter(e => e.order_id === Number(orderId))
    .sort((a, b) => a.created_at - b.created_at)
    .map(e => ({ id: e.id, kind: e.kind, detail: e.detail, ts: +e.created_at }));
}

// ---- Per-line order items (new table; JSONB orders.items still kept in sync) ----
export async function setOrderItems(orderId, items = []) {
  if (!orderId) return;
  if (pool) {
    await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
    for (const it of items) {
      await pool.query(
        `INSERT INTO order_items (order_id, name, pack, quantity, dosage, duration, calc_note, duration_missing, not_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orderId, it.name || null, it.pack || null, it.quantity ?? it.qty ?? null,
         it.dosage || null, it.duration || null, it.calc_note || null,
         Boolean(it.duration_missing), Boolean(it.not_required)]
      );
    }
  } else {
    mem.orderItems = mem.orderItems.filter(i => i.order_id !== Number(orderId));
    for (const it of items) {
      mem.orderItems.push({ id: mem.nextSeq++, order_id: Number(orderId), name: it.name || null,
        pack: it.pack || null, quantity: it.quantity ?? it.qty ?? null, dosage: it.dosage || null,
        duration: it.duration || null, calc_note: it.calc_note || null,
        duration_missing: Boolean(it.duration_missing), not_required: Boolean(it.not_required) });
    }
  }
}

export async function getOrderItems(orderId) {
  if (pool) {
    const { rows } = await pool.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`, [orderId]);
    return rows;
  }
  return mem.orderItems.filter(i => i.order_id === Number(orderId));
}

// §3d: append items to an existing (not-yet-billed) order instead of opening a
// duplicate. Keeps orders.items (JSONB) and order_items in sync, flags the order
// needs_review, and logs an items_added event.
export async function addItems(orderId, items = []) {
  const o = await getOrder(orderId);
  if (!o) return null;
  const existing = Array.isArray(o.items) ? o.items : [];
  const add = (items || [])
    .map(it => ({ name: String(it.name || "").trim(), qty: it.qty != null ? String(it.qty) : (it.quantity != null ? String(it.quantity) : "") }))
    .filter(x => x.name);
  if (!add.length) return o;
  const merged = existing.concat(add);
  if (pool) {
    await pool.query(`UPDATE orders SET items = $2, needs_review = TRUE, updated_at = now() WHERE id = $1`,
      [orderId, JSON.stringify(merged)]);
  } else {
    o.items = merged; o.needs_review = true; o.updated_at = new Date();
  }
  await setOrderItems(orderId, merged);
  await logEvent(orderId, "items_added", add.map(i => i.name + (i.qty && i.qty !== "1" ? " - " + i.qty : "")).join(", "));
  return getOrder(orderId);
}

// §3d: the customer's most recent order still being prepared (status 'new',
// not yet billed) - so a follow-up "add these too" appends instead of duplicating.
export async function latestActiveUnbilled(waId) {
  if (!waId) return null;
  if (pool) {
    const { rows } = await pool.query(
      `SELECT id, order_code, items FROM orders
        WHERE wa_id = $1 AND status = 'new' AND deleted = FALSE
        ORDER BY created_at DESC LIMIT 1`, [waId]);
    return rows[0] || null;
  }
  return mem.orders.filter(o => o.wa_id === waId && o.status === "new" && !o.deleted)
    .sort((a, b) => b.created_at - a.created_at)[0] || null;
}

// filter: { status, waId, execId, limit, offset } - all optional
export async function listOrders(filter = {}) {
  const { status, waId, execId, limit = 100, offset = 0 } = filter;
  if (pool) {
    const clauses = [];
    const params = [];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (waId) { params.push(waId); clauses.push(`wa_id = $${params.length}`); }
    if (execId) { params.push(execId); clauses.push(`exec_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit); params.push(offset);
    const { rows } = await pool.query(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  } else {
    let out = mem.orders.slice();
    if (status) out = out.filter(o => o.status === status);
    if (waId) out = out.filter(o => o.wa_id === waId);
    if (execId) out = out.filter(o => o.exec_id === execId);
    out = out.sort((a, b) => b.created_at - a.created_at);
    return out.slice(offset, offset + limit);
  }
}

export async function getOrder(id) {
  if (pool) {
    const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
    return rows[0] || null;
  } else {
    return mem.orders.find(o => o.id === Number(id)) || null;
  }
}

export async function updateOrderStatus(id, status) {
  if (!ORDER_STATUSES.includes(status)) {
    throw new Error(`Invalid order status: ${status}`);
  }
  // Stamp ready_at when an order becomes ready/dispatched (drives feedback sweep + SLA).
  const stampReady = (status === "billed_ready" || status === "billed_dispatched");
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE orders SET status = $2, updated_at = now(),
         ready_at = CASE WHEN $3 AND ready_at IS NULL THEN now() ELSE ready_at END
       WHERE id = $1 RETURNING *`,
      [id, status, stampReady]
    );
    await logEvent(id, "status", `Status → ${status}`);
    return rows[0] || null;
  } else {
    const o = mem.orders.find(o => o.id === Number(id));
    if (!o) return null;
    o.status = status;
    if (stampReady && !o.ready_at) o.ready_at = new Date();
    o.updated_at = new Date();
    await logEvent(id, "status", `Status → ${status}`);
    return o;
  }
}

// Permanently delete an order (password-gated in the API route).
export async function deleteOrder(id) {
  if (pool) { await pool.query(`DELETE FROM orders WHERE id = $1`, [id]); }
  else { const i = mem.orders.findIndex(o => o.id === Number(id)); if (i >= 0) mem.orders.splice(i, 1); }
}

export async function assignExec(orderId, execId) {
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE orders SET exec_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [orderId, execId]
    );
    await logEvent(orderId, "status", `Delivery agent assigned`);
    return rows[0] || null;
  } else {
    const o = mem.orders.find(o => o.id === Number(orderId));
    if (!o) return null;
    o.exec_id = execId;
    o.updated_at = new Date();
    await logEvent(orderId, "status", `Delivery agent assigned`);
    return o;
  }
}

// Record billing: bill number, order value, optional invoice media, and
// staff-confirmed delivery distance/fee. Moves the order to 'billed_ready'
// (pickup) or 'billed_dispatched' (delivery) and stamps ready_at.
export async function setOrderBilling(id, { billNo, orderValue, billMediaId, distanceKm, deliveryFee, deliveryFeePending, fulfilment } = {}) {
  const targetStatus = fulfilment === "delivery" ? "billed_dispatched" : "billed_ready";
  if (pool) {
    await pool.query(
      `UPDATE orders SET
         bill_no = COALESCE($2, bill_no),
         order_value = COALESCE($3, order_value),
         bill_media_id = COALESCE($4, bill_media_id),
         distance_km = COALESCE($5, distance_km),
         delivery_fee = COALESCE($6, delivery_fee),
         delivery_fee_pending = COALESCE($7, delivery_fee_pending),
         status = $8,
         ready_at = CASE WHEN ready_at IS NULL THEN now() ELSE ready_at END,
         updated_at = now()
       WHERE id = $1`,
      [id, billNo ?? null, orderValue ?? null, billMediaId ?? null, distanceKm ?? null,
       deliveryFee ?? null, deliveryFeePending ?? null, targetStatus]
    );
  } else {
    const o = mem.orders.find(o => o.id === Number(id));
    if (o) {
      if (billNo != null) o.bill_no = billNo;
      if (orderValue != null) o.order_value = orderValue;
      if (billMediaId != null) o.bill_media_id = billMediaId;
      if (distanceKm != null) o.distance_km = distanceKm;
      if (deliveryFee != null) o.delivery_fee = deliveryFee;
      if (deliveryFeePending != null) o.delivery_fee_pending = deliveryFeePending;
      o.status = targetStatus;
      if (!o.ready_at) o.ready_at = new Date();
      o.updated_at = new Date();
    }
  }
  await logEvent(id, "status", `Billed (${billNo || "no bill#"}${orderValue != null ? ", ₹" + orderValue : ""}) → ${targetStatus}`);
  return getOrder(id);
}

// Business rule: editing an order does NOT mutate it in place. Instead the
// old order_code is cancelled and a brand-new order_code is issued, carrying
// over the original fields with the requested changes applied. This keeps a
// clean paper trail (old code stays visible/traceable as 'cancelled').
//
// changes: any subset of the createOrder() `data` fields to override.
// Returns the NEW order row (the old row is left in place with status='cancelled').
export async function reissueOrder(id, changes = {}) {
  const old = await getOrder(id);
  if (!old) throw new Error(`Order ${id} not found`);

  await updateOrderStatus(id, "cancelled");

  const merged = {
    waId: changes.waId ?? old.wa_id,
    customerName: changes.customerName ?? old.customer_name,
    phone: changes.phone ?? old.phone,
    mode: changes.mode ?? old.mode,
    items: changes.items ?? old.items,
    prescriptionUrl: changes.prescriptionUrl ?? old.prescription_url,
    fulfillment: changes.fulfillment ?? old.fulfillment,
    address: changes.address ?? old.address,
    distanceKm: changes.distanceKm ?? old.distance_km,
    deliveryFee: changes.deliveryFee ?? old.delivery_fee,
    notes: changes.notes ?? old.notes,
    execId: changes.execId ?? old.exec_id,
    status: "new",
  };
  const fresh = await createOrder(merged);
  return fresh;
}

// Alias kept for the interface name requested by integrators; identical
// behaviour to reissueOrder (edits always cancel+reissue, never mutate in place).
export async function editOrder(id, changes = {}) {
  return reissueOrder(id, changes);
}

// ---- Delivery executives ----
// data: { name, phone, area, active }
export async function createExec(data) {
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO execs (name, phone, area, active) VALUES ($1,$2,$3,$4) RETURNING *`,
      [data.name || null, data.phone || null, data.area || null, data.active ?? true]
    );
    return rows[0];
  } else {
    const row = {
      id: mem.nextExecId++,
      name: data.name || null,
      phone: data.phone || null,
      area: data.area || null,
      active: data.active ?? true,
      created_at: new Date(),
    };
    mem.execs.push(row);
    return row;
  }
}

export async function listExecs() {
  if (pool) {
    const { rows } = await pool.query(`SELECT * FROM execs ORDER BY created_at DESC`);
    return rows;
  } else {
    return mem.execs.slice().sort((a, b) => b.created_at - a.created_at);
  }
}

export async function setExecActive(id, active) {
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE execs SET active = $2 WHERE id = $1 RETURNING *`,
      [id, Boolean(active)]
    );
    return rows[0] || null;
  } else {
    const e = mem.execs.find(e => e.id === Number(id));
    if (!e) return null;
    e.active = Boolean(active);
    return e;
  }
}

// ---- WhatsApp handoff message for the assigned delivery executive ----
// order: an order row (as returned by createOrder/getOrder/etc, snake_case fields)
// exec: an exec row (optional, only used for a friendly greeting)
export function execHandoffMessage(order, exec) {
  const lines = [];
  lines.push(`New delivery - ${order.order_code}`);
  if (exec?.name) lines.push(`Hi ${exec.name}, please pick this up:`);
  lines.push("");
  lines.push(`Customer: ${order.customer_name || "-"}`);
  lines.push(`Phone: ${order.phone || "-"}`);
  lines.push(`Address: ${order.address || "-"}`);
  lines.push("");

  const items = Array.isArray(order.items) ? order.items : [];
  if (order.mode === "prescription" || items.length === 0) {
    lines.push("Items: Prescription order (see attached prescription image)");
  } else {
    lines.push("Items:");
    for (const it of items) {
      const qty = it.qty != null ? ` x${it.qty}` : "";
      lines.push(`  - ${it.name}${qty}`);
    }
  }

  lines.push("");
  lines.push(`Fulfillment: ${order.fulfillment === "delivery" ? "Home delivery" : "Store pickup"}`);
  if (order.fulfillment === "delivery" && order.delivery_fee != null) {
    lines.push(`Delivery fee: Rs.${order.delivery_fee}`);
  }
  lines.push("Payment: collect on delivery (COD) unless customer confirms otherwise at billing.");
  lines.push("");
  lines.push(`Order code: ${order.order_code}`);

  return lines.join("\n");
}

// ---- Procurement: aggregate demand across orders, subtract stock/placed ----
// Normalise a product name for matching (uppercase, collapse spaces/punctuation).
export function normalizeProductName(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
// Parse a leading quantity number out of free text ("3 strips" -> 3, "" -> 1).
function parseQty(text) {
  const m = String(text ?? "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 1;
}

// Read all procurement_lines (vendor-locked batches).
export async function listProcurementLines() {
  if (pool) {
    const { rows } = await pool.query(`SELECT * FROM procurement_lines ORDER BY placed_at DESC`);
    return rows;
  }
  return mem.procurement.slice().sort((a, b) => b.placed_at - a.placed_at);
}

// Build the procurement view: aggregate demand from active orders per product,
// subtract what's already vendor-locked, and split into pending / available.
// stock: optional { productNorm: qtyInStock } map (from ERP later); defaults to {}.
export async function getProcurement(stock = {}) {
  const active = (await listOrders({ limit: 100000 })).filter(
    o => !o.deleted && ["new", "billed_ready", "billed_dispatched"].includes(o.status)
  );
  const agg = {}; // norm -> { product_name, totalOrdered, contributing:[] }
  for (const o of active) {
    const items = Array.isArray(o.items) ? o.items : [];
    for (const it of items) {
      if (!it || !it.name) continue;
      const norm = normalizeProductName(it.name);
      if (!norm) continue;
      const q = parseQty(it.qty);
      if (!agg[norm]) agg[norm] = { product_norm: norm, product_name: it.name, total_ordered: 0, contributing: [] };
      agg[norm].total_ordered += q;
      agg[norm].contributing.push({ orderId: o.id, orderCode: o.order_code, customer: o.customer_name || o.phone || "-", qty: it.qty || String(q) });
    }
  }
  // Subtract already-placed (vendor-locked) quantities.
  const lines = await listProcurementLines();
  const placedByNorm = {};
  for (const l of lines) placedByNorm[l.product_norm] = (placedByNorm[l.product_norm] || 0) + Number(l.qty_placed || 0);

  const pending = [], available = [];
  for (const norm of Object.keys(agg)) {
    const a = agg[norm];
    const inStock = Number(stock[norm] || 0);
    const alreadyPlaced = placedByNorm[norm] || 0;
    const toPlace = a.total_ordered - inStock - alreadyPlaced;
    const row = { ...a, in_stock: inStock, already_placed: alreadyPlaced, to_place: Math.max(0, toPlace) };
    if (toPlace > 0) pending.push(row); else available.push(row);
  }
  pending.sort((x, y) => y.to_place - x.to_place);
  return { pending, available, placed: lines };
}

// Vendor-lock a product: freeze the current "to place" quantity into a
// procurement_line tagged with the vendor + the contributing orders snapshot.
export async function lockProcurement(productNorm, vendor, stock = {}) {
  const { pending } = await getProcurement(stock);
  const row = pending.find(p => p.product_norm === productNorm);
  if (!row) throw new Error("nothing to place for this product");
  const contributing = JSON.stringify(row.contributing || []);
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO procurement_lines (product_norm, product_name, qty_placed, stock_used, total_ordered, vendor, contributing)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [row.product_norm, row.product_name, row.to_place, row.in_stock, row.total_ordered, vendor || null, contributing]
    );
    return rows[0];
  }
  const line = { id: mem.nextSeq++, product_norm: row.product_norm, product_name: row.product_name,
    qty_placed: row.to_place, stock_used: row.in_stock, total_ordered: row.total_ordered,
    vendor: vendor || null, contributing: row.contributing || [], placed_at: new Date() };
  mem.procurement.push(line);
  return line;
}

export async function editProcurementVendor(id, vendor) {
  if (pool) { await pool.query(`UPDATE procurement_lines SET vendor = $2 WHERE id = $1`, [id, vendor || null]); }
  else { const l = mem.procurement.find(l => l.id === Number(id)); if (l) l.vendor = vendor || null; }
}

export async function deleteProcurementLine(id) {
  if (pool) { await pool.query(`DELETE FROM procurement_lines WHERE id = $1`, [id]); }
  else { const i = mem.procurement.findIndex(l => l.id === Number(id)); if (i >= 0) mem.procurement.splice(i, 1); }
}

// ---- Feedback ----
export async function addFeedback({ waId, orderId, sentiment, text }) {
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO feedback (wa_id, order_id, sentiment, text) VALUES ($1,$2,$3,$4) RETURNING *`,
      [waId || null, orderId || null, sentiment || "neutral", text || null]
    );
    return rows[0];
  }
  const row = { id: mem.nextSeq++, wa_id: waId || null, order_id: orderId || null, sentiment: sentiment || "neutral", text: text || null, handled: false, created_at: new Date() };
  mem.feedback.push(row);
  return row;
}
export async function listFeedback(filter = "all") {
  let rows;
  if (pool) { rows = (await pool.query(`SELECT id, wa_id, order_id, sentiment, text, handled, EXTRACT(EPOCH FROM created_at)*1000 AS ts FROM feedback ORDER BY created_at DESC`)).rows.map(r => ({ ...r, ts: Number(r.ts) })); }
  else { rows = mem.feedback.slice().sort((a, b) => b.created_at - a.created_at).map(r => ({ ...r, ts: +r.created_at })); }
  if (filter === "positive") rows = rows.filter(r => r.sentiment === "positive");
  else if (filter === "negative") rows = rows.filter(r => r.sentiment === "negative");
  return rows;
}
export async function feedbackCounts() {
  const all = await listFeedback("all");
  return {
    total: all.length,
    positive: all.filter(r => r.sentiment === "positive").length,
    negative: all.filter(r => r.sentiment === "negative").length,
    unhandledNegative: all.filter(r => r.sentiment === "negative" && !r.handled).length,
  };
}
export async function markFeedbackHandled(id, handled = true) {
  if (pool) { await pool.query(`UPDATE feedback SET handled = $2 WHERE id = $1`, [id, Boolean(handled)]); }
  else { const f = mem.feedback.find(f => f.id === Number(id)); if (f) f.handled = Boolean(handled); }
}

// Orders that became ready/dispatched >delayMin minutes ago and haven't had a
// feedback request sent yet - drives the post-order feedback sweep.
export async function ordersNeedingFeedbackRequest(delayMin = 180) {
  const cutoff = Date.now() - delayMin * 60 * 1000;
  const all = await listOrders({ limit: 100000 });
  return all.filter(o => !o.feedback_requested && !o.deleted
    && ["billed_ready", "billed_dispatched"].includes(o.status)
    && o.ready_at && new Date(o.ready_at).getTime() <= cutoff);
}
export async function markFeedbackRequested(orderId) {
  if (pool) { await pool.query(`UPDATE orders SET feedback_requested = TRUE WHERE id = $1`, [orderId]); }
  else { const o = mem.orders.find(o => o.id === Number(orderId)); if (o) o.feedback_requested = true; }
}
