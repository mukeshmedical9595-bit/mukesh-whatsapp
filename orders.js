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
          fulfillment, address, distance_km, delivery_fee, status, exec_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
