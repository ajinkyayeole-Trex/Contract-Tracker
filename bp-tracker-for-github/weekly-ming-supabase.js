/*
 * Weekly Revenue Share Report update for the BP tracker (Supabase), run by the scheduled Claude task.
 * 1. Reads reports.json: one entry per Revenue Share Report email
 *      { bp, subject, received, lines: { LINE: { km, trips, rate, cost } } }
 *    km / trips = "Total KMs" / "Total Trips" (first table), rate = "Revenue Share Advances" ₹/km and cost = "Bus Cost" (second table).
 * 2. Logs in to Supabase as the weekly-check user (an Editor) and saves every report in the BP's report history
 *    (used for the MinG check and the Performance tab). Never over someone else's newer save.
 * 3. A BP that Finance pays but that is not in the tracker gets its own new entry (names are not merged:
 *    if Finance pays it separately, it is a separate BP), flagged red in Needs attention to add the contract.
 * 4. Prints a summary.
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
const BY = 'Weekly revenue report check';

// Apply all reports to the list of BPs (changes it in place). Returns what changed and a summary.
function apply(list, reports) {
  const sum = { saved: [], created: [], skipped: [], unreadable: [], mismatches: [], smallGaps: [], extra: [] };
  const touched = new Map(); // id → periods saved
  const created = new Set();
  const R = (reports || []).map((raw) => ({ raw, n: C.normaliseReport(raw || {}) }));
  R.filter((x) => !x.n).forEach((x) => sum.unreadable.push(`${(x.raw && x.raw.bp) || '?'}: no period or no line rows (${(x.raw && x.raw.subject) || 'no subject'})`));
  R.filter((x) => x.n).sort((a, b) => (a.n.start < b.n.start ? -1 : a.n.start > b.n.start ? 1 : 0)).forEach(({ n }) => {
    if (!n.from) { sum.unreadable.push(`no BP name: ${n.period}`); return; }
    // Same name (or a saved alias) only. A different name is a different BP, even when it runs the same line codes.
    const m = C.matchBp(list.filter((c) => !c.archived), n.from);
    let c = m && m.c;
    if (!c) { c = C.contractFromReport(n, BY); list.push(c); created.add(c.id); sum.created.push(`${c.bpName} (${Object.keys(n.lines).join(', ')})`); }
    if (!C.addReport(c, n)) { sum.skipped.push(`${c.bpName}: ${n.period} already saved`); return; }
    touched.set(c.id, (touched.get(c.id) || []).concat(n.period));
  });
  touched.forEach((periods, id) => {
    const c = list.find((x) => x.id === id);
    sum.saved.push(`${c.bpName}: ${periods.join(', ')}`);
    if (created.has(id)) return; // no contract yet: nothing to compare
    const chk = C.mingCheck(c);
    chk.items.filter((i) => i.status === 'mismatch').forEach((i) => {
      const t = `${c.bpName} ${i.code}: contract ₹${i.contract}/km, paid ₹${i.paid}/km (${i.diff > 0 ? '+' : ''}${i.diff})`;
      (c.mingStrict || !(Math.abs(Number(i.diff)) <= C.MING_TOLERANCE + 1e-9) ? sum.mismatches : sum.smallGaps).push(t);
    });
    (chk.extra || []).forEach((x) => sum.extra.push(`${c.bpName} ${x.code}: paid ₹${x.paid}/km but not in the signed Lines Annex`));
  });
  return { touched, created, sum };
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
const toRow = (c) => ({ id: c.id, bp_name: c.bpName, region: c.region || null, stage: c.stage || null, data: c, rev: c.updatedAt });
const withNote = (c, periods) => {
  const now = new Date().toISOString();
  return Object.assign({}, c, { updatedAt: now, history: (c.history || []).concat([{ at: now, by: BY, text: 'Revenue Share Report saved: ' + periods.join(', ') }]) });
};

async function main(argv) {
  argv = argv || process.argv;
  const reports = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
  const dry = argv.includes('--dry-run');
  const email = String(process.env.LOGIN_EMAIL || '').trim(), pw = String(process.env.LOGIN_PASSWORD || '');
  if (!URL_ || !KEY || /PASTE/.test(URL_ + KEY)) throw new Error('Supabase URL / anon key missing: paste them into the scheduled task.');
  if (!email || !pw || /PASTE/.test(email + pw)) throw new Error('Weekly-check login missing: paste its email and password into the scheduled task.');
  try { token = (await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: pw } })).access_token; }
  catch (e) { throw new Error(e.status === 400 ? 'Wrong weekly-check email or password.' : e.message); }
  const list = (await sb('/rest/v1/contracts?select=data')).map((r) => r.data);
  const rev0 = {}; list.forEach((c) => { rev0[c.id] = c.updatedAt; });
  const { touched, created, sum } = apply(list, reports);
  const out = Object.assign({ reports: reports.length, bpsInTracker: list.length }, sum);
  if (!touched.size || dry) { console.log(JSON.stringify(Object.assign({ uploaded: false, dryRun: dry }, out), null, 1)); return out; }
  const failed = [];
  for (const [id, periods] of touched) {
    const c = list.find((x) => x.id === id);
    try {
      if (created.has(id)) { await sb('/rest/v1/contracts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: toRow(c) }); continue; }
      let next = withNote(c, periods), base = rev0[id];
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await sb('/rest/v1/contracts?id=eq.' + encodeURIComponent(id) + '&rev=eq.' + encodeURIComponent(base), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { data: next, rev: next.updatedAt } });
        if (res && res.length) break;
        // Someone saved this BP in the meantime: take their version and add the reports again
        const cur = ((await sb('/rest/v1/contracts?select=data&id=eq.' + encodeURIComponent(id))) || [])[0];
        if (!cur || attempt) { failed.push(c.bpName + ' (someone saved it at the same moment; it is picked up next run)'); break; }
        const fresh = cur.data; base = fresh.updatedAt;
        (reports || []).map((r) => C.normaliseReport(r || {})).filter((n) => n && C.matchBp([fresh], n.from)).forEach((n) => C.addReport(fresh, n));
        next = withNote(fresh, periods);
      }
    } catch (e) { failed.push(c.bpName + ': ' + (e.status === 401 || e.status === 403 ? 'the weekly-check login is not an Editor' : e.message)); }
  }
  console.log(JSON.stringify(Object.assign({ uploaded: true, failed }, out), null, 1));
  return out;
}

if (require.main === module) main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
module.exports = { apply, main };
