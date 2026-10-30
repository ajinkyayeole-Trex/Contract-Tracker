/*
 * Weekly MinG update for the Supabase version of the BP tracker (run by the scheduled Claude task).
 * 1. Reads reports.json (one entry per Revenue Share Report email: { bp, subject, received, rates: { LINE: ₹/km }, totalKm }).
 * 2. Logs in to Supabase as the weekly-check user (an Editor), saves each BP's paid ₹/km and weekly Total KMs,
 *    only for the BPs that changed, and never over someone else's newer save.
 * 3. Prints a summary: MinG mismatches, lines paid but not in the contract, BPs not in the tracker.
 *
 * Usage: node weekly-ming-supabase.js reports.json [--dry-run]
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, LOGIN_EMAIL, LOGIN_PASSWORD, CORE_JS (path to the dashboard's core.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require(process.env.CORE_JS || path.join(__dirname, '..', 'public', 'core.js'));
const URL_ = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_ANON_KEY || '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function period(subject) {
  const m = /(\d{2})-(\d{2})-(\d{4})\s*to\s*(\d{2})-(\d{2})-(\d{4})/.exec(subject || '');
  if (!m) return null;
  const [, d1, m1, y1, d2, m2, y2] = m;
  const label = m1 === m2 && y1 === y2 ? `${+d1}–${+d2} ${MON[m2 - 1]} ${y2}` : `${+d1} ${MON[m1 - 1]} – ${+d2} ${MON[m2 - 1]} ${y2}`;
  return { label, end: `${y2}-${m2}-${d2}` };
}

// Apply all reports to the data. Returns a summary.
function apply(data, reports) {
  const list = data.contracts || [];
  const sum = { saved: [], skipped: [], notInTracker: [], mismatches: [], extra: [] };
  reports.forEach((rep) => {
    const per = period(rep.subject);
    const paid = {};
    Object.keys(rep.rates || {}).forEach((k) => { const v = Number(String(rep.rates[k]).replace(/,/g, '')); if (/^IN[0-9A-Z]{3,}$/i.test(k) && v > 0 && v < 500) paid[k.toUpperCase()] = v; });
    const codes = Object.keys(paid);
    if (!per || !codes.length) { sum.skipped.push(`${rep.bp || '?'}: no period or no rates`); return; }
    const overlap = (c) => (c.lines || []).filter((l) => codes.includes(l.code)).length;
    let c = null;
    const byName = rep.bp ? C.matchBp(list, rep.bp) : null;
    if (byName && (overlap(byName.c) > 0 || !(byName.c.lines || []).length)) c = byName.c;
    if (!c) { const best = list.filter((x) => !x.archived).map((x) => ({ x, n: overlap(x) })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n)[0]; if (best) c = best.x; }
    if (!c) { sum.notInTracker.push(`${rep.bp} (${codes.join(', ')})`); return; }
    const old = c.revenueReport;
    if (old && old.periodEnd && old.periodEnd > per.end) { sum.skipped.push(`${c.bpName}: already has the newer ${old.period}`); return; }
    // The BP's "Total KMs" for the week (grand total of the KMs table in the report)
    const totalKm = Number(String(rep.totalKm == null ? '' : rep.totalKm).replace(/,/g, '')) || null;
    // Round-trip km per line from the report's first table: Total KMs ÷ (Total Trips ÷ 2)
    const lineKm = {};
    Object.keys(rep.lineKm || {}).forEach((k) => {
      const x = rep.lineKm[k] || {}; const kmv = Number(String(x.km == null ? x : x.km).replace(/,/g, '')); const trips = Number(x.trips);
      if (/^IN[0-9A-Z]{3,}$/i.test(k) && kmv > 0 && trips >= 2) lineKm[k.toUpperCase()] = Math.round((kmv / (trips / 2)) * 100) / 100;
    });
    if (old && old.periodEnd === per.end && C.sameValue(old.rates, paid) && (old.totalKm || null) === totalKm && C.sameValue(old.lineKm || {}, lineKm)) { sum.skipped.push(`${c.bpName}: ${per.label} already saved`); return; }
    c.revenueReport = { period: per.label, periodEnd: per.end, receivedOn: String(rep.received || '').slice(0, 10), rates: paid, totalKm, lineKm, from: rep.bp };
    const filled = C.fillFromReport ? C.fillFromReport(c) : [];
    if (filled.length) {
      c.history = (c.history || []).concat([{ at: new Date().toISOString(), by: 'Weekly revenue report check', text: 'RT kms filled in from the Revenue Share Report ' + per.label + ' (the contract leaves it blank): ' + filled.map((code) => { const l = c.lines.find((x) => x.code === code); return code + ' ' + l.rtKms + ' km' + (l.rtAmt ? ', RT amount ₹' + l.rtAmt : ''); }).join('; ') }]);
      sum.filled = (sum.filled || []).concat(filled.map((code) => c.bpName + ' ' + code));
    }
    sum.saved.push(`${c.bpName} (${per.label})`);
    const chk = C.mingCheck(c);
    chk.items.filter((i) => i.status === 'mismatch').forEach((i) => sum.mismatches.push(`${c.bpName} ${i.code}: contract ₹${i.contract}/km, paid ₹${i.paid}/km (${i.diff > 0 ? '+' : ''}${i.diff})`));
    chk.extra.forEach((x) => sum.extra.push(`${c.bpName} ${x.code}: paid ₹${x.paid}/km but not in the contract`));
  });
  return sum;
}


let token = null;
async function sb(pathq, opts) {
  opts = opts || {};
  const headers = Object.assign({ apikey: KEY, 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, opts.headers || {});
  const res = await fetch(URL_ + pathq, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (!res.ok) { const e = new Error((d && (d.error_description || d.msg || d.message)) || 'Error ' + res.status); e.status = res.status; throw e; }
  return d;
}

async function main() {
  const reports = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const dry = process.argv.includes('--dry-run');
  const email = String(process.env.LOGIN_EMAIL || '').trim(), pw = String(process.env.LOGIN_PASSWORD || '');
  if (!URL_ || !KEY || /PASTE/.test(URL_ + KEY)) throw new Error('Supabase URL / anon key missing: paste them into the scheduled task.');
  if (!email || !pw || /PASTE/.test(email + pw)) throw new Error('Weekly-check login missing: paste its email and password into the scheduled task.');
  try { token = (await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: pw } })).access_token; }
  catch (e) { throw new Error(e.status === 400 ? 'Wrong weekly-check email or password.' : e.message); }
  const rows = await sb('/rest/v1/contracts?select=data');
  const data = { contracts: rows.map((r) => r.data) };
  const before = {}; data.contracts.forEach((c) => { before[c.id] = c.revenueReport || null; });
  const sum = apply(data, reports);
  const changed = data.contracts.filter((c) => !C.sameValue(c.revenueReport || null, before[c.id]));
  if (!changed.length || dry) { console.log(JSON.stringify(Object.assign({ uploaded: false, dryRun: dry }, sum), null, 1)); return; }
  const failed = [];
  for (const c of changed) {
    const rev = c.updatedAt;
    const next = Object.assign({}, c, { updatedAt: new Date().toISOString() });
    next.history = (c.history || []).concat([{ at: next.updatedAt, by: 'Weekly revenue report check', text: 'Revenue Share Report ' + (c.revenueReport.period || '') + ' saved' }]);
    try {
      const out = await sb('/rest/v1/contracts?id=eq.' + encodeURIComponent(c.id) + '&rev=eq.' + encodeURIComponent(rev),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { data: next, rev: next.updatedAt } });
      if (!out || !out.length) failed.push(c.bpName + ' (someone saved it at the same moment; it will be picked up next run)');
    } catch (e) { failed.push(c.bpName + ': ' + (e.status === 401 || e.status === 403 ? 'the weekly-check login is not an Editor' : e.message)); }
  }
  console.log(JSON.stringify(Object.assign({ uploaded: true, failed }, sum), null, 1));
}

if (require.main === module) main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
module.exports = { apply, period, main };
