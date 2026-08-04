// Mukesh Medical - quantity helper.
// Computes how many units (tablets/doses) a prescription line needs from its
// dosage pattern and duration. STAFF-SIDE ONLY: this is arithmetic to help the
// pharmacist pre-fill an order line, never medical advice shown to a customer.
//
// Supports common Indian Rx dosage notations:
//   "1-0-1"      -> 2 per day (morning-noon-night)
//   "1-1-1"      -> 3 per day
//   "1/2-0-1/2"  -> 1 per day (halves)
//   "BD"/"1 BD"  -> 2 per day     TDS -> 3     QID -> 4     OD/HS -> 1
//   "SOS" / "PRN"-> as-needed (returns null, staff decides)
// Duration: "5 days", "1 week", "2 weeks", "1 month", or a bare number (days).

function perDayFromDosage(dosage) {
  if (!dosage) return null;
  const s = String(dosage).trim().toLowerCase();
  if (/\b(sos|prn)\b/.test(s)) return null; // as-needed

  // Latin abbreviations
  const abbr = { od: 1, hs: 1, bd: 2, bid: 2, tds: 3, tid: 3, qid: 4, qds: 4 };
  const abbrMatch = s.match(/\b(od|hs|bd|bid|tds|tid|qid|qds)\b/);
  if (abbrMatch) {
    const mult = (s.match(/(\d+(?:\.\d+)?)\s*(?:tab|cap|x|\*)?\s*(?:od|hs|bd|bid|tds|tid|qid|qds)/) || [])[1];
    return abbr[abbrMatch[1]] * (mult ? Number(mult) : 1);
  }

  // Dash pattern like 1-0-1, 1/2-0-1/2, 1-1-1-1
  if (s.includes("-")) {
    const parts = s.split("-").map(p => p.trim());
    let total = 0, ok = false;
    for (const p of parts) {
      if (p === "" ) continue;
      const frac = p.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (frac) { total += Number(frac[1]) / Number(frac[2]); ok = true; }
      else if (/^\d+(?:\.\d+)?$/.test(p)) { total += Number(p); ok = true; }
    }
    return ok ? total : null;
  }

  // Bare "N times a day" or a single number meaning N/day
  const times = s.match(/(\d+(?:\.\d+)?)\s*(?:times?|x)\s*(?:a\s*day|\/\s*day|daily)?/);
  if (times) return Number(times[1]);
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return null;
}

function daysFromDuration(duration) {
  if (!duration) return null;
  const s = String(duration).trim().toLowerCase();
  const num = (s.match(/(\d+(?:\.\d+)?)/) || [])[1];
  const n = num ? Number(num) : null;
  if (n == null) return null;
  if (/month/.test(s)) return Math.round(n * 30);
  if (/week/.test(s)) return Math.round(n * 7);
  return Math.round(n); // days (or bare number)
}

// Returns { quantity, perDay, days, note } or { quantity: null, note } when it
// can't be computed (as-needed, missing duration, unrecognised pattern).
export function computeQuantity(dosage, duration) {
  const perDay = perDayFromDosage(dosage);
  const days = daysFromDuration(duration);
  if (perDay == null) return { quantity: null, perDay: null, days, note: "as-needed / unclear dosage - set manually" };
  if (days == null) return { quantity: null, perDay, days: null, note: "duration missing - set manually" };
  const quantity = Math.ceil(perDay * days);
  return { quantity, perDay, days, note: `${perDay}/day x ${days} days = ${quantity}` };
}

export default { computeQuantity };
