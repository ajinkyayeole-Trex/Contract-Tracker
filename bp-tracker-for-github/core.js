/*
 * Shared rules for the BP contract tracker.
 * Loaded by the server (Node) and by the browser, so the rules stay the same in both places.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The contract journey, in order. "Rejected" sits off the main route.
  const STAGES = [
    'Framework created',
    'Peer approval',
    'Merchant signature pending',
    'Surya signature pending',
    'Signed',
  ];
  const REJECTED = 'Rejected';
  const ALL_STAGES = STAGES.concat([REJECTED]);

  const OPTIONS = {
    region: ['N/W', 'South'],
    accountActivation: ['', 'Not active', 'Active', 'Already active'],
    bankDetails: ['No', 'Finance approval', 'Yes'],
    docsPending: ['All received', 'Not received'],
    rejectionCategory: [
      'Commercials (MinG / RT amount)',
      'Lines or routes changed',
      'Wrong BP details',
      'Missing documents',
      'Terms and clauses',
      'Other',
    ],
  };

  // Fields a person can edit, with their labels (used for the change history too).
  const FIELDS = {
    bpName: 'BP name',
    region: 'Region',
    owner: 'Owner',
    stage: 'Contract stage',
    docsReceived: 'Docs received',
    sfAccountCreated: 'Account created on SF',
    accountActivation: 'Account activation',
    bankDetails: 'Bank details updated',
    onboardingForm: 'Onboarding form filled',
    docsSharedFinance: 'Docs shared with finance',
    docsPending: 'Docs pending',
    comments: 'Comments',
    lines: 'Lines',
    annualMileage: 'Annual mileage (km)',
    contract: 'Contract documents',
    pendingContract: 'Revised contract waiting for signature',
    bpType: 'BP type',
    docs: 'Contract documents',
    rcm: 'RCM clause in Commercial Annex',
    rcmClause: 'RCM clause number',
  };

  // The six contract documents. A new BP signs all six; an existing BP moved to a new route signs only the Lines and Vehicles Annex.
  const DOC_TYPES = [
    ['framework', 'Framework Agreement'], ['lines', 'Lines Annex'], ['vehicles', 'Vehicles Annex'],
    ['commercial', 'Commercial Annex'], ['addendum', 'Addendum'], ['attachments', 'Attachments'],
  ];
  const DOC_STATUS = { signed: 'Signed by BP and Surya', surya: 'BP signed, waiting for Surya', sent: 'Sent, waiting for the BP', pending: 'Waiting for signature', copy: 'Unsigned copy', missing: 'Missing' };
  const BP_TYPES = { new: 'New BP (all 6 documents)', existing: 'Existing BP, new route (Lines + Vehicles Annex)' };

  const STALE_DAYS = 7;

  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // RT amount = MinG × RT kms. Fill in any two and the third is worked out.
  // `calc` remembers which of the three was worked out, so that value can be redone when an input changes.
  const NUM_KEYS = ['rtAmt', 'rtKms', 'minG'];
  function compute(l, key) {
    if (key === 'minG') return l.rtAmt !== null && l.rtKms ? round2(l.rtAmt / l.rtKms) : null;
    if (key === 'rtAmt') return l.minG !== null && l.rtKms !== null ? round2(l.minG * l.rtKms) : null;
    if (key === 'rtKms') return l.rtAmt !== null && l.minG ? round2(l.rtAmt / l.minG) : null;
    return null;
  }
  function normaliseLine(l) {
    l = l || {};
    const out = { code: String(l.code || '').trim().toUpperCase(), rtAmt: num(l.rtAmt), rtKms: num(l.rtKms), minG: num(l.minG), calc: NUM_KEYS.includes(l.calc) ? l.calc : null };
    const empty = NUM_KEYS.filter((k) => out[k] === null);
    // A rate printed in the contract is kept exactly, even if it isn't RT amount ÷ RT kms to the paisa
    if (l.printed && empty.length === 0) { out.calc = null; out.printed = true; if (l.route) out.route = String(l.route); if (l.source) out.source = String(l.source); return out; }
    if (empty.length === 1) out.calc = empty[0];
    else if (!out.calc && empty.length === 0) out.calc = 'minG';
    if (out.calc && empty.length <= 1) {
      const v = compute(out, out.calc);
      if (v !== null) out[out.calc] = v;
    }
    if (out.calc && out[out.calc] === null) out.calc = null;
    if (l.route) out.route = String(l.route);
    if (l.source) out.source = String(l.source);
    return out;
  }

  // Same BP written differently ("Tegra" / "TEGRA EXPRESS", "Deltin Travels Private Limited")
  const NAME_NOISE = /\b(pvt|private|ltd|limited|co|company|travels?|tours?|logistics|express|mobility|services|partners|house|holidays|and|the)\b|[^a-z0-9]/g;
  function nameKey(n) { return String(n || '').toLowerCase().replace(/&/g, ' ').replace(NAME_NOISE, ''); }
  function findDuplicate(list, name, exceptId) {
    const k = nameKey(name);
    if (!k) return null;
    return list.find((c) => !c.archived && c.id !== exceptId &&
      [c.bpName].concat(c.aliases || []).some((a) => nameKey(a) === k)) || null;
  }
  // Line codes that appear under more than one BP
  function duplicateLines(list) {
    const seen = {};
    list.filter((c) => !c.archived).forEach((c) => c.lines.forEach((l) => { if (l.code) (seen[l.code] = seen[l.code] || []).push(c.bpName); }));
    return Object.fromEntries(Object.entries(seen).filter(([, v]) => new Set(v).size > 1));
  }

  // Called while someone types into one box of a line. Picks which box to fill in automatically.
  function editLine(l, key, value) {
    const next = Object.assign({}, l, { [key]: value });
    if (NUM_KEYS.includes(key)) delete next.printed;
    const n = (k) => num(next[k]);
    const others = NUM_KEYS.filter((k) => k !== key);
    const blank = others.filter((k) => n(k) === null || (k === next.calc));
    if (n(key) === null) {
      // They cleared a box: clear whatever was worked out from it.
      if (next.calc && next.calc !== key) next[next.calc] = '';
      next.calc = null;
      return next;
    }
    let target = null;
    if (blank.length === 1) target = blank[0];
    else if (blank.length === 2) target = others.find((k) => k === next.calc) || null;
    else if (next.calc && next.calc !== key) target = next.calc;
    else target = key === 'minG' ? 'rtAmt' : 'minG'; // they typed over the worked-out value: work out another one instead
    if (!target) return next;
    const probe = { rtAmt: n('rtAmt'), rtKms: n('rtKms'), minG: n('minG') };
    probe[target] = null;
    const v = compute(probe, target);
    if (v !== null) { next[target] = v; next.calc = target; }
    return next;
  }

  function uid() {
    return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function blankContract() {
    return {
      id: '',
      bpName: '',
      region: 'N/W',
      owner: '',
      stage: STAGES[0],
      docsReceived: false,
      sfAccountCreated: false,
      accountActivation: '',
      bankDetails: 'No',
      onboardingForm: false,
      docsSharedFinance: false,
      docsPending: 'Not received',
      comments: '',
      lines: [],
      annualMileage: null,
      revenueReport: null,
      rejections: [],
      history: [],
      archived: false,
      createdAt: '',
      updatedAt: '',
      stageSince: '',
    };
  }

  function display(field, v) {
    if (field === 'rcm') return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '(not checked)';
    if (field === 'bpType') return v ? BP_TYPES[v] || v : '(not set)';
    if (field === 'docs') return DOC_TYPES.map(([k, n]) => n + ': ' + DOC_STATUS[(v || {})[k] || 'missing']).join(', ');
    if (field === 'pendingContract') return v ? 'yes' + (v.contract && v.contract.envelopeId && v.contract.envelopeId.length > 8 ? ' (envelope ' + v.contract.envelopeId.slice(0, 8) + '…)' : '') : 'none';
    if (field === 'contract') return v ? (v.documents || 'PDF') + (v.envelopeId && v.envelopeId.length > 8 ? ', envelope ' + v.envelopeId.slice(0, 8) + '…' : '') : '(empty)';
    if (field === 'lines') return (v || []).map((l) => l.code || '?').join(', ') || 'none';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return v === '' || v === null || v === undefined ? '(empty)' : String(v);
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function createContract(input, user, now) {
    now = now || new Date().toISOString();
    const c = Object.assign(blankContract(), pick(input));
    c.id = uid();
    c.bpName = String(c.bpName || '').trim();
    if (!c.bpName) throw new Error('Enter the BP name.');
    c.lines = (c.lines || []).map(normaliseLine).filter((l) => l.code || l.rtAmt || l.rtKms);
    if (!ALL_STAGES.includes(c.stage)) c.stage = STAGES[0];
    c.createdAt = c.updatedAt = c.stageSince = now;
    c.history = [{ at: now, by: user, text: 'Contract created at stage “' + c.stage + '”' + (input.historyNote ? '. ' + input.historyNote : '') }];
    return c;
  }

  function pick(input) {
    const out = {};
    Object.keys(FIELDS).forEach((k) => {
      if (input && Object.prototype.hasOwnProperty.call(input, k)) out[k] = input[k];
    });
    return out;
  }

  // Apply edits and record each change in the history.
  function updateContract(c, patch, user, now) {
    now = now || new Date().toISOString();
    const changes = pick(patch);
    if (changes.lines) changes.lines = changes.lines.map(normaliseLine).filter((l) => l.code || l.rtAmt || l.rtKms);
    if (changes.stage !== undefined && !ALL_STAGES.includes(changes.stage)) throw new Error('Unknown stage: ' + changes.stage);
    if (changes.stage === REJECTED && c.stage !== REJECTED) throw new Error('Use “Mark as rejected” so the reason is recorded.');
    if (changes.bpName !== undefined && !String(changes.bpName).trim()) throw new Error('BP name cannot be empty.');
    const next = Object.assign({}, c);
    let changed = false;
    Object.keys(changes).forEach((k) => {
      if (sameValue(c[k], changes[k])) return;
      changed = true;
      next[k] = changes[k];
      next.history = (next.history || []).concat([{
        at: now, by: user,
        text: FIELDS[k] + ': ' + display(k, c[k]) + ' → ' + display(k, changes[k]),
      }]);
      if (k === 'stage') next.stageSince = now;
    });
    if (changed && patch.historyNote) next.history = next.history.concat([{ at: now, by: user, text: String(patch.historyNote) }]);
    if (changed) next.updatedAt = now;
    return next;
  }

  function rejectContract(c, { category, reason }, user, now) {
    now = now || new Date().toISOString();
    if (!category) throw new Error('Pick a rejection reason.');
    const next = Object.assign({}, c);
    next.rejections = (c.rejections || []).concat([{
      at: now, by: user, fromStage: c.stage, category, reason: String(reason || '').trim(), resentAt: null, resentBy: null,
    }]);
    next.stage = REJECTED;
    next.stageSince = now;
    next.updatedAt = now;
    next.history = (c.history || []).concat([{
      at: now, by: user, text: 'Rejected at “' + c.stage + '”: ' + category + (reason ? ' (' + reason + ')' : ''),
    }]);
    return next;
  }

  // The revised contract goes back out for signature.
  function resendContract(c, user, now) {
    now = now || new Date().toISOString();
    const last = latestRejection(c);
    if (c.stage !== REJECTED || !last) throw new Error('Only rejected contracts can be re-sent.');
    const next = Object.assign({}, c);
    next.rejections = c.rejections.slice(0, -1).concat([Object.assign({}, last, { resentAt: now, resentBy: user })]);
    next.stage = 'Merchant signature pending';
    next.stageSince = now;
    next.updatedAt = now;
    next.history = (c.history || []).concat([{ at: now, by: user, text: 'Revised contract sent for signing' }]);
    return next;
  }

  function latestRejection(c) {
    const r = c.rejections || [];
    return r.length ? r[r.length - 1] : null;
  }

  function daysInStage(c, now) {
    const t = new Date(c.stageSince || c.updatedAt || c.createdAt).getTime();
    return Math.max(0, Math.floor(((now ? new Date(now).getTime() : Date.now()) - t) / 86400000));
  }

  // Onboarding checklist, shown as progress for each BP.
  function checklist(c) {
    return [
      { label: 'Docs received', ok: !!c.docsReceived },
      { label: 'Account on SF', ok: !!c.sfAccountCreated },
      { label: 'Bank details', ok: c.bankDetails === 'Yes' },
      { label: 'Onboarding form', ok: !!c.onboardingForm },
      { label: 'All docs in', ok: c.docsPending === 'All received' },
    ];
  }

  // Which documents this BP must have signed, and where each one stands.
  function requiredDocs(c) {
    if (c.bpType === 'new') return DOC_TYPES.map(([k]) => k);
    if (c.bpType === 'existing') return ['lines', 'vehicles'];
    return [];
  }
  function docCheck(c) {
    const req = requiredDocs(c); const d = c.docs || {};
    const rows = DOC_TYPES.map(([k, label]) => ({ key: k, label, status: d[k] || 'missing', required: req.includes(k) }));
    const need = rows.filter((r) => r.required);
    return {
      type: c.bpType || null, rows,
      missing: need.filter((r) => r.status === 'missing'),
      notSigned: need.filter((r) => r.status !== 'signed' && r.status !== 'missing'),
      done: need.filter((r) => r.status === 'signed').length, total: need.length,
    };
  }

  // What needs someone's attention, most urgent first.
  function flags(c, now) {
    const f = [];
    const last = latestRejection(c);
    if (c.stage === REJECTED && last && !last.resentAt) f.push({ level: 3, text: 'Rejected, revised contract not sent yet' });
    if (!c.docsReceived || c.docsPending === 'Not received') f.push({ level: 2, text: 'Documents not received' });
    if (c.bankDetails === 'Finance approval') f.push({ level: 1, text: 'Bank details awaiting finance approval' });
    else if (c.bankDetails !== 'Yes') f.push({ level: 1, text: 'Bank details not updated' });
    const dc = docCheck(c);
    if (!dc.type) f.push({ level: 1, text: 'Contract documents: tick “Existing BP” (new route, only Lines + Vehicles Annex) or mark it as a new BP (all 6)' });
    else {
      if (dc.missing.length) f.push({ level: 2, text: 'Missing contract documents: ' + dc.missing.map((r) => r.label).join(', ') });
      if (dc.notSigned.length) f.push({ level: c.stage === 'Signed' ? 2 : 1, text: 'Not signed yet: ' + dc.notSigned.map((r) => r.label + ' (' + DOC_STATUS[r.status].toLowerCase() + ')').join(', ') });
    }
    if (c.pendingContract) f.push({ level: 1, text: 'Revised contract out for signing: ' + ((c.pendingContract.changes || []).length) + ' change(s) apply once signed' });
    if (!c.region) f.push({ level: 2, text: 'Region not set: pick N/W or South' });
    const mc = mingCheck(c);
    mc.items.filter((i) => i.status === 'mismatch').forEach((i) => f.push({ level: 3, text: `MinG mismatch on ${i.code}: contract ₹${i.contract.toFixed(2)}/km, revenue report ₹${i.paid.toFixed(2)}/km (${mc.period})` }));
    if (!c.lines.length && mc.extra.length) f.push({ level: 2, text: `Revenue report pays ${mc.extra.length} line${mc.extra.length > 1 ? 's' : ''} (${mc.extra.map((x) => x.code).join(', ')}) but no Lines Annex is entered (${mc.period})` });
    else mc.extra.forEach((x) => f.push({ level: 3, text: `${x.code} is in the revenue report at ₹${x.paid.toFixed(2)}/km but not in the signed Lines Annex (${mc.period})` }));
    if (c.lines.length && c.stage === 'Signed' && !c.annualMileage) f.push({ level: 1, text: 'Annual mileage missing: add the signed Vehicles Annex' });
    if (!c.lines.length) f.push({ level: c.stage === 'Signed' ? 2 : 1, text: c.stage === 'Signed' ? 'Lines missing: add the signed Lines Annex' : 'No lines entered' });
    else if (c.lines.some((l) => l.rtAmt === null)) f.push({ level: 1, text: 'RT amount missing on some lines' });
    else if (c.lines.some((l) => !l.code)) f.push({ level: 1, text: 'Line code missing' });
    return f.sort((a, b) => b.level - a.level);
  }

  // Compare contract MinG (Lines Annex reference rate) with the rate paid in the weekly revenue share report.
  function mingCheck(c) {
    const rep = c.revenueReport;
    if (!rep || !rep.rates) return { status: 'no-report', items: [], extra: [] };
    const items = c.lines.filter((l) => l.code).map((l) => {
      const paid = rep.rates[l.code];
      if (paid === undefined) return { code: l.code, contract: l.minG, paid: null, status: 'not-in-report' };
      const diff = round2(paid - l.minG);
      return { code: l.code, contract: l.minG, paid, diff, status: Math.abs(diff) < 0.005 ? 'ok' : 'mismatch' };
    });
    const codes = new Set(c.lines.map((l) => l.code));
    const extra = Object.keys(rep.rates).filter((k) => !codes.has(k)).map((k) => ({ code: k, paid: rep.rates[k] }));
    const bad = items.some((i) => i.status === 'mismatch') || extra.length;
    return { status: bad ? 'mismatch' : 'ok', period: rep.period, items, extra };
  }

  function totals(c) {
    return c.lines.reduce((t, l) => ({
      rtAmt: t.rtAmt + (l.rtAmt || 0),
      rtKms: t.rtKms + (l.rtKms || 0),
    }), { rtAmt: 0, rtKms: 0 });
  }


  // ---------- Contract PDF → tracker ----------
  // Find the BP a PDF belongs to: same name (or alias), or one name is the other plus extra words.
  function matchBp(list, name) {
    const exact = findDuplicate(list, name);
    if (exact) return { c: exact, how: 'name' };
    const k = nameKey(name);
    if (k.length < 5) return null;
    const near = list.find((c) => !c.archived && [c.bpName].concat(c.aliases || []).some((a) => { const x = nameKey(a); return x.length >= 5 && (x.startsWith(k) || k.startsWith(x)); }));
    return near ? { c: near, how: 'similar' } : null;
  }

  // What changed between the lines in the tracker and the lines in a new Lines Annex
  function lineDiff(oldLines, newLines) {
    const out = [];
    const o = {}; (oldLines || []).forEach((l) => { if (l.code) o[l.code] = l; });
    const seen = {};
    (newLines || []).forEach((l) => {
      seen[l.code] = true;
      const p = o[l.code];
      if (!p) { out.push({ type: 'added', code: l.code, to: l }); return; }
      const fields = ['rtKms', 'minG', 'rtAmt'].filter((k) => num(p[k]) !== num(l[k]));
      if (fields.length) out.push({ type: 'changed', code: l.code, from: p, to: l, fields });
    });
    Object.keys(o).filter((c) => !seen[c]).forEach((c) => out.push({ type: 'removed', code: c, from: o[c] }));
    // A line that disappears while a new one appears on the same route = replaced
    const rk = (l) => String((l && l.route) || '').toLowerCase().replace(/[^a-z]/g, '');
    out.filter((d) => d.type === 'removed' && rk(d.from)).forEach((rem) => {
      const add = out.find((d) => d.type === 'added' && !d.replaces && rk(d.to) === rk(rem.from));
      if (!add) return;
      add.type = 'replaced'; add.replaces = rem.code; add.from = rem.from;
      add.fields = ['rtKms', 'minG', 'rtAmt'].filter((k) => num(rem.from[k]) !== num(add.to[k]));
      rem.type = 'replaced-old'; rem.by = add.code;
    });
    return out;
  }
  const LBL = { rtKms: ['', ' km'], minG: ['MinG ₹', '/km'], rtAmt: ['RT amount ₹', ''] };
  const fmtN = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  function describeDiff(d) {
    if (d.type === 'added') return `New line ${d.code}${d.to.route ? ' (' + d.to.route + ')' : ''}: ${fmtN(d.to.rtKms)} km, MinG ₹${fmtN(d.to.minG)}/km, RT amount ₹${fmtN(d.to.rtAmt)}`;
    if (d.type === 'removed') return `Line ${d.code}${d.from.route ? ' (' + d.from.route + ')' : ''} is no longer in the contract`;
    if (d.type === 'replaced-old') return '';
    if (d.type === 'replaced') return `${d.replaces} → replaced by ${d.code}${d.to.route ? ' (same route ' + d.to.route + ')' : ''}` + (d.fields.length ? ': ' + d.fields.map((k) => `${LBL[k][0]}${fmtN(d.from[k])}${LBL[k][1]} → ${LBL[k][0]}${fmtN(d.to[k])}${LBL[k][1]}`).join(', ') : ', same numbers');
    return `${d.code}: ` + d.fields.map((k) => `${LBL[k][0]}${fmtN(d.from[k])}${LBL[k][1]} → ${LBL[k][0]}${fmtN(d.to[k])}${LBL[k][1]}`).join(', ');
  }

  // Combine the documents already recorded with those in a new PDF. A document only goes "down" (e.g. signed → unsigned)
  // when the PDF is a new version of it (keys in `replace`), e.g. a revised Lines Annex with different lines.
  const DOC_RANK = { missing: 0, copy: 1, sent: 2, pending: 2, surya: 3, signed: 4 };
  function mergeDocs(old, add, replace) {
    const out = Object.assign({}, old || {});
    Object.keys(add || {}).forEach((k) => {
      if ((replace || []).includes(k) || (DOC_RANK[add[k]] || 0) > (DOC_RANK[out[k]] || 0)) out[k] = add[k];
    });
    return out;
  }
  // Built-in document status for the starting BPs (used until someone saves the BP with its own list)
  function withDocDefaults(c) {
    if (c.rcm === undefined && SEED_RCM[c.bpName]) { c.rcm = SEED_RCM[c.bpName][0]; c.rcmClause = SEED_RCM[c.bpName][1]; }
    const d = SEED_DOCS[c.bpName];
    if (!d) return c;
    if (c.docs === undefined) c.docs = Object.assign({}, d.docs);
    if (c.bpType === undefined && d.type) c.bpType = d.type;
    return c;
  }

  // Decide what a contract PDF means for the tracker.
  // r = PdfParse result; signedAnswer = the user's answer when the PDF has no DocuSign stamp (true / false / undefined)
  function planFromPdf(list, r, opts) {
    opts = opts || {};
    const m = opts.forceNew ? null : matchBp(list, r.bpName);
    const c = m ? m.c : null;
    const lines = (r.lines || []).map((l) => normaliseLine({ code: l.code, route: l.route, rtKms: l.rtKms, minG: l.minG, rtAmt: l.rtAmt,
      calc: l.kmsWorkedOut ? 'rtKms' : null, printed: !l.kmsWorkedOut && l.rtKms != null && l.minG != null && l.rtAmt != null, source: 'pdf' }));
    const stamped = !!r.envelopeId;
    const signed = r.stage === 'Signed' || (!stamped && opts.signedAnswer === true);
    const needsAnswer = !stamped && opts.signedAnswer === undefined;
    const flowStage = signed ? 'Signed' : r.stage || 'Merchant signature pending';
    const sb = r.signedBy || {};
    const contract = { envelopeId: r.envelopeId || '—', documents: (r.docs || []).filter((d) => d !== 'Commercial Annex').join(', ') || 'PDF',
      effectiveFrom: r.effectiveFrom || '', file: (r.files || []).join(', '), status: signed ? 'Completed' : r.envelopeStatus || '',
      signedBy: { bp: sb.bp || (signed ? r.signedOn || 'yes' : null), surya: sb.surya || (signed ? r.signedOn || 'yes' : null) } };
    const who = sb.source ? ` (BP: ${sb.bp ? 'signed ' + sb.bp : 'not yet'} · Surya: ${sb.surya ? 'signed ' + sb.surya : 'not yet'})` : '';
    const signLabel = r.stage === 'Signed' ? 'Signed by the BP and Surya' + (sb.source ? who : r.signedOn ? ' (' + r.signedOn + ')' : '')
      : r.stage === 'Surya signature pending' ? 'BP signed' + (r.signedOn ? ' on ' + r.signedOn : '') + ', waiting for Surya'
      : r.stage === 'Merchant signature pending' ? 'Sent in DocuSign, BP has not signed yet' + who
      : stamped ? 'DocuSign status: ' + (r.envelopeStatus || 'unknown')
      : opts.signedAnswer === true ? 'No DocuSign stamp: you said it is signed' : opts.signedAnswer === false ? 'No DocuSign stamp: you said it is not signed yet' : 'No DocuSign stamp in this PDF';
    const plan = { kind: c ? 'update' : 'new', match: m, bp: c, signed, needsAnswer, signLabel, changes: [], patch: null, body: null, notes: [], lines, contract };
    // Documents in this PDF and their signature status
    const docMap = {};
    Object.keys(r.docMap || {}).forEach((k) => { docMap[k] = !stamped ? (opts.signedAnswer === true ? 'signed' : 'copy') : r.docMap[k]; });
    plan.signedBy = sb;
    plan.docMap = docMap;
    plan.suggestExisting = c ? (c.bpType ? c.bpType === 'existing' : !docMap.framework && !!(docMap.lines || docMap.vehicles)) : false;
    const bpType = opts.existingBp === undefined ? (c ? c.bpType || (plan.suggestExisting ? 'existing' : 'new') : 'new') : (opts.existingBp ? 'existing' : 'new');
    plan.bpType = bpType;
    if (r.envelopeStatus === 'Voided' || r.envelopeStatus === 'Declined') { plan.kind = 'none'; plan.notes.push('This DocuSign envelope was ' + r.envelopeStatus.toLowerCase() + ', so nothing is changed.'); return plan; }

    if (!c) {
      const summary = lines.map((l) => describeDiff({ type: 'added', code: l.code, to: l }));
      if (r.rcm) summary.push(r.rcm === 'yes' ? `RCM clause: Yes (Commercial Annex Art. ${r.rcmClause || '8.12.7'})` : 'RCM clause: No (not in this Commercial Annex)');
      if (r.annualMileage) summary.push('Annual mileage: ' + fmtN(r.annualMileage) + ' km');
      plan.changes = summary;
      plan.docsAfter = docMap;
      plan.body = { bpName: r.bpName, region: r.region || 'N/W', stage: flowStage, lines, annualMileage: r.annualMileage || null, contract,
        bpType, docs: docMap, rcm: r.rcm || null, rcmClause: r.rcmClause || '', docsReceived: true, historyNote: 'Added from contract PDF ' + contract.file + '. ' + signLabel + '.' };
      if (!r.bpName) plan.notes.push('The BP name was not found in the PDF: type it in.');
      return plan;
    }

    // Existing BP
    if (signed && c.contract && c.contract.effectiveFrom && r.effectiveFrom && r.effectiveFrom < c.contract.effectiveFrom && c.stage === 'Signed') {
      plan.kind = 'none';
      plan.notes.push(`This contract (effective ${r.effectiveFrom}) is older than the one already in the tracker (effective ${c.contract.effectiveFrom}), so nothing is changed.`);
      return plan;
    }
    const diff = lines.length ? lineDiff(c.lines, lines) : [];
    const mileage = r.annualMileage && r.annualMileage !== c.annualMileage ? { from: c.annualMileage, to: r.annualMileage } : null;
    const text = diff.map(describeDiff).filter(Boolean);
    plan.diff = diff;
    plan.unchanged = lines.length ? lines.filter((l) => !diff.some((d) => d.code === l.code)).map((l) => l.code) : [];
    if (mileage) text.push(`Annual mileage: ${mileage.from ? fmtN(mileage.from) + ' km' : 'empty'} → ${fmtN(mileage.to)} km`);
    const patch = {};
    // Documents: a changed Lines Annex / Vehicles Annex replaces the old one's status; other documents only improve
    const replaceKeys = [].concat(diff.length ? ['lines'] : [], mileage ? ['vehicles'] : []);
    const docsAfter = mergeDocs(c.docs, docMap, replaceKeys);
    plan.docsAfter = docsAfter;
    const docText = DOC_TYPES.filter(([k]) => (docsAfter[k] || 'missing') !== ((c.docs || {})[k] || 'missing'))
      .map(([k, n]) => `${n}: ${DOC_STATUS[(c.docs || {})[k] || 'missing'].toLowerCase()} → ${DOC_STATUS[docsAfter[k]].toLowerCase()}`);
    if (docText.length) patch.docs = docsAfter;
    if (bpType !== c.bpType) { patch.bpType = bpType; docText.push('BP type: ' + BP_TYPES[bpType]); }
    if (r.rcm && r.rcm !== c.rcm) { patch.rcm = r.rcm; patch.rcmClause = r.rcmClause || ''; docText.push(r.rcm === 'yes' ? `RCM clause: Yes (Commercial Annex Art. ${r.rcmClause || '8.12.7'})` : 'RCM clause: No (not in this Commercial Annex)'); }
    const stageIdx = (s) => STAGES.indexOf(s);

    // The PDF becomes the BP's contract: numbers are updated straight away, signed or not
    if (diff.length) patch.lines = lines;
    if (mileage) patch.annualMileage = mileage.to;
    // Contract stage. A DocuSign PDF (with its envelope stamp) shows exactly who has signed, so the tracker follows it,
    // even if that means going back (e.g. marked "Signed" but Surya hasn't signed yet). An unsigned copy never moves a stage back.
    const trustPdf = stamped && !(c.contract && c.contract.effectiveFrom && r.effectiveFrom && r.effectiveFrom < c.contract.effectiveFrom);
    const why = sb.source ? ` (DocuSign: BP ${sb.bp ? 'signed' : 'not signed yet'}, Surya ${sb.surya ? 'signed' : 'not signed yet'})` : '';
    if (c.stage === REJECTED && !signed) { patch.stage = flowStage; text.push(`Stage: Rejected → ${flowStage} (revised contract sent)`); }
    else if (signed && c.stage !== 'Signed') { patch.stage = 'Signed'; text.push(`Stage: ${c.stage} → Signed${why}`); }
    else if (!signed && trustPdf && flowStage !== c.stage) {
      patch.stage = flowStage;
      text.push(`Stage: ${c.stage} → ${flowStage}${c.stage === 'Signed' && (diff.length || mileage) ? ' (revised contract, not signed yet)' : why}`);
    }
    else if (!signed && !stamped && c.stage === 'Signed' && (diff.length || mileage)) { patch.stage = flowStage; text.push(`Stage: Signed → ${flowStage} (revised contract, not signed yet)`); }
    else if (!signed && !stamped && stageIdx(flowStage) > stageIdx(c.stage)) { patch.stage = flowStage; text.push(`Stage: ${c.stage} → ${flowStage}`); }
    else if (!signed && !stamped && c.stage === 'Signed' && !diff.length && !mileage && !docText.length) {
      plan.kind = 'none'; plan.notes.push('Same lines and mileage as the signed contract already in the tracker. Nothing to update.');
      return plan;
    }
    if (c.pendingContract) patch.pendingContract = null;
    if (text.length) patch.contract = contract;
    else if (!c.contract || c.contract.envelopeId !== contract.envelopeId) {
      if (contract.envelopeId.length > 8 || !c.contract) {
        patch.contract = Object.assign({}, contract, c.contract && !lines.length ? { documents: c.contract.documents + '; ' + contract.documents, effectiveFrom: c.contract.effectiveFrom || contract.effectiveFrom } : {});
        text.push('Lines, mileage and stage already match. Contract document recorded: ' + contract.documents + (contract.envelopeId.length > 8 ? ', envelope ' + contract.envelopeId.slice(0, 8) + '…' : ''));
      }
    }
    text.push(...docText);
    plan.changes = text;
    if (!Object.keys(patch).length) { plan.kind = 'none'; plan.notes.push('Everything in this PDF already matches the tracker. Nothing to update.'); return plan; }
    patch.historyNote = 'Updated from contract PDF ' + contract.file + '. ' + signLabel + '. ' + text.join('; ');
    plan.patch = patch;
    return plan;
  }

  // ---- Starting data (23 Oct 2026) ----
  // Lines, RT kms, RT amount and MinG (the "Reference Rate") are copied exactly from each BP's Lines Annex,
  // annual mileage exactly from Vehicles Annex Art. 2.1. Source: OneDrive › BP Contract (one folder per BP)
  // and DocuSign emails. Revenue report = Finance's weekly Revenue Share Report, 12–18 Oct 2026.
  const CL = (code, route, rtKms, rtAmt, minG) => {
    if (rtKms === null) return normaliseLine({ code, route, rtAmt, minG, calc: 'rtKms', source: 'contract' });
    const l = normaliseLine({ code, route, rtKms, rtAmt, calc: 'minG', source: 'contract' });
    if (minG !== undefined && minG !== l.minG) return normaliseLine({ code, route, rtKms, rtAmt, minG, printed: true, source: 'contract' }); // keep the rate as printed
    return l;
  };
  const RR = (rates) => ({ period: '12–18 Oct 2026', receivedOn: '2026-10-22', rates });
  const DONE = { docsReceived: true, sfAccountCreated: true, bankDetails: 'Yes', onboardingForm: true, docsSharedFinance: true, docsPending: 'All received' };
  const TO_CONFIRM = 'Stage to confirm: the contract PDFs in the BP Contract folder are unsigned copies and no DocuSign email was found.';
  const SEED = [];


  // Contract documents found for the starting BPs (OneDrive › BP Contract folders and DocuSign emails, 23 Oct 2026).
  // s = signed by BP and Surya, p = BP signed and waiting for Surya, c = unsigned copy only. Order: framework, lines, vehicles, commercial, addendum, attachments.
  // type: 'new' = all six needed; 'existing' = BP moved to a new route (Lines + Vehicles Annex only); missing = not decided yet.
  const D = (code, type) => { const keys = ['framework', 'lines', 'vehicles', 'commercial', 'addendum', 'attachments']; const map = { s: 'signed', p: 'surya', c: 'copy' };
    const docs = {}; String(code).split('').forEach((ch, i) => { if (map[ch]) docs[keys[i]] = map[ch]; }); return { docs, type }; };
  // RCM clause (Commercial Annex Art. 8.12.7 "GST Charge Mechanism"), checked in each BP's Commercial Annex on 26 Oct 2026.
  const SEED_RCM = {};
  const SEED_DOCS = {};

  function seedContracts(now) {
    now = now || new Date().toISOString();
    return SEED.map((r, i) => {
      const since = r.signedOn ? r.signedOn + 'T12:00:00.000Z' : '2026-10-13T06:00:00.000Z';
      const c = Object.assign(blankContract(), r, { id: 'seed_' + (i + 1), createdAt: since, updatedAt: now, stageSince: since });
      delete c.signedOn;
      c.lines = (r.lines || []).slice();
      delete c.docs; delete c.bpType; delete c.rcm; delete c.rcmClause; withDocDefaults(c);
      c.history = [{ at: since, by: r.contract ? 'Contract PDF' : 'Import from Excel tracker',
        text: r.contract ? (r.stage === 'Signed' ? 'Signed. ' : 'Stage: ' + r.stage + '. ') + 'Lines taken from ' + r.contract.documents + (r.contract.envelopeId.length > 8 ? ', envelope ' + r.contract.envelopeId.slice(0, 8) + '…' : '') : 'Imported at stage “' + r.stage + '”' }];
      return c;
    });
  }

  return {
    STAGES, REJECTED, ALL_STAGES, OPTIONS, FIELDS, STALE_DAYS,
    normaliseLine, editLine, createContract, updateContract, rejectContract, resendContract,
    latestRejection, daysInStage, checklist, flags, totals, mingCheck, seedContracts, blankContract, nameKey, findDuplicate, duplicateLines, matchBp, lineDiff, describeDiff, planFromPdf, DOC_TYPES, DOC_STATUS, BP_TYPES, requiredDocs, docCheck, mergeDocs, withDocDefaults,
  };
});
