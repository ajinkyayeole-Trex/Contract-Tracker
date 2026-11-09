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
    contractDocs: 'Attached documents',
    aliases: 'Other names of this BP',
    entityName: 'Entity name (Commercial Annex)',
  };
  // Saved, but without its own line in the history (the "Contract documents" lines already say what changed)
  const QUIET_FIELDS = ['contractDocs'];

  // The six contract documents. A new BP signs all six; an existing BP moved to a new route signs only the Lines and Vehicles Annex.
  const DOC_TYPES = [
    ['framework', 'Framework Agreement'], ['lines', 'Lines Annex'], ['vehicles', 'Vehicles Annex'],
    ['commercial', 'Commercial Annex'], ['addendum', 'Addendum'], ['attachments', 'Attachments'],
  ];
  const DOC_STATUS = { signed: 'Signed by BP and Surya', surya: 'BP signed, waiting for Surya', sent: 'Sent, waiting for the BP', pending: 'Waiting for signature', copy: 'Unsigned copy', missing: 'Missing' };
  const BP_TYPES = { new: 'New BP (all 6 documents)', existing: 'Existing BP, new route (Lines + Vehicles Annex)' };

  const STALE_DAYS = 7;
  // MinG differences up to this (₹/km, either way) are not raised in Needs attention
  const MING_TOLERANCE = 0.08;

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
  const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function normaliseLine(l) {
    l = l || {};
    const out = { code: String(l.code || '').trim().toUpperCase(), rtAmt: num(l.rtAmt), rtKms: num(l.rtKms), minG: num(l.minG), calc: NUM_KEYS.includes(l.calc) ? l.calc : null };
    const empty = NUM_KEYS.filter((k) => out[k] === null);
    // A rate printed in the contract is kept exactly, even if it isn't RT amount ÷ RT kms to the paisa
    if (isDate(l.from)) out.from = l.from;
    if (l.kmsFrom) out.kmsFrom = String(l.kmsFrom);
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
  const NAME_NOISE = /\b(pvt|private|ltd|limited|co|company|travels?|tours?|logistics|express|mobility|solutions?|services|partners|house|holidays|and|the)\b|[^a-z0-9]/g;
  function nameKey(n) { return String(n || '').toLowerCase().replace(/['’`´]\s*s\b/g, '').replace(/['’`´]/g, '').replace(/&/g, ' ').replace(NAME_NOISE, ''); }
  function findDuplicate(list, name, exceptId) {
    const k = nameKey(name);
    if (!k) return null;
    return list.find((c) => !c.archived && c.id !== exceptId &&
      [c.bpName].concat(c.aliases || []).some((a) => nameKey(a) === k)) || null;
  }
  // BPs whose name looks like this one (typing mistakes, "Pvt Ltd", spacing…). Best 2 first. score 1 = same name.
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const looseKey = (n) => String(n || '').toLowerCase().replace(/&/g, ' ').replace(/\b(pvt|private|ltd|limited|the)\b|[^a-z0-9]/g, '');
  function nameScore(a, b) {
    const ka = nameKey(a), kb = nameKey(b);
    if (ka && ka === kb) return 1;
    let best = 0;
    [[ka, kb], [looseKey(a), looseKey(b)]].forEach(([x, y]) => {
      if (x.length < 4 || y.length < 4) return;
      const short = Math.min(x.length, y.length);
      if (short >= 5 && (x.startsWith(y) || y.startsWith(x))) best = Math.max(best, 0.9);
      best = Math.max(best, 1 - lev(x, y) / Math.max(x.length, y.length));
    });
    return Math.round(best * 100) / 100;
  }
  function similarBps(list, name, exceptId) {
    if (String(name || '').trim().length < 3) return [];
    return list.filter((c) => !c.archived && c.id !== exceptId)
      .map((c) => ({ c, score: Math.max(...[c.bpName].concat(c.aliases || []).map((a) => nameScore(name, a))) }))
      .filter((x) => x.score >= 0.8).sort((a, b) => b.score - a.score).slice(0, 2);
  }
  // One owner, several names: contract PDFs often write the BP as "<trading name> - <legal entity>" or "<firm> - <owner>":
  // "Madurai Radha Travels - RVN ENTERPRISES", "V.M.TRAVELS - SYED AKBAR SYED NASEER", "RVN Enterprises (Madurai Radha Travels)".
  // Every part (split at " - ", "_" and brackets) is compared with every part of the tracker's names and aliases.
  // Used only for contract PDFs, and only when exactly one BP fits (the form then shows "It's a different BP" to undo it).
  const nameParts = (n) => String(n || '').split(/\s+[-–—]\s+|_|[()]/).map((x) => x.trim()).filter(Boolean);
  function matchNamePart(list, name) {
    const keys = nameParts(name).map(nameKey).filter((k) => k.length >= 2);
    if (!keys.length) return null;
    const hits = list.filter((c) => !c.archived && [c.bpName].concat(c.aliases || []).some((a) => nameParts(a).concat([a]).some((x) => keys.includes(nameKey(x)))));
    return hits.length === 1 ? hits[0] : null;
  }
  const matchFirmPart = matchNamePart;
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
    if (field === 'aliases') return (v || []).join(', ') || 'none';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return v === '' || v === null || v === undefined ? '(empty)' : String(v);
  }

  // Same content, whatever the order of the keys (the database may store them in a different order)
  function stableJson(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  function sameValue(a, b) {
    return stableJson(a) === stableJson(b);
  }

  function createContract(input, user, now) {
    now = now || new Date().toISOString();
    const c = Object.assign(blankContract(), pick(input));
    c.id = uid();
    c.bpName = String(c.bpName || '').trim();
    if (!c.bpName) throw new Error('Enter the BP name.');
    c.lines = (c.lines || []).map(normaliseLine).filter((l) => l.code || l.rtAmt || l.rtKms);
    const eff = c.contract && isDate(c.contract.effectiveFrom) ? c.contract.effectiveFrom : null;
    if (eff) c.lines.forEach((l) => { if (!l.from) l.from = eff; });
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
    // A line copied from the revenue report becomes a contract line as soon as someone enters its contract values
    if (changes.lines) changes.lines.forEach((l) => { if (l.source !== 'report') return; const o = (c.lines || []).find((x) => x.code === l.code && x.source === 'report'); if (!o || ['rtKms', 'minG', 'rtAmt'].some((k) => num(o[k]) !== l[k])) delete l.source; });
    if (changes.stage !== undefined && !ALL_STAGES.includes(changes.stage)) throw new Error('Unknown stage: ' + changes.stage);
    if (changes.stage === REJECTED && c.stage !== REJECTED) throw new Error('Use “Mark as rejected” so the reason is recorded.');
    if (changes.bpName !== undefined && !String(changes.bpName).trim()) throw new Error('BP name cannot be empty.');
    const next = Object.assign({}, c);
    let changed = false;
    Object.keys(changes).forEach((k) => {
      if (sameValue(c[k], changes[k])) return;
      changed = true;
      next[k] = changes[k];
      if (QUIET_FIELDS.includes(k)) return;
      next.history = (next.history || []).concat([{
        at: now, by: user,
        text: FIELDS[k] + ': ' + display(k, c[k]) + ' → ' + display(k, changes[k]),
      }]);
      if (k === 'stage') next.stageSince = now;
    });
    // A new contract (PDF) replaced or changed lines: keep the old ones as history, with the dates they applied
    if (changed && changes.lines && patch.contract && !sameValue(c.lines, next.lines)) {
      const newEff = isDate(patch.contract.effectiveFrom) ? patch.contract.effectiveFrom : null;
      next.lines = next.lines.map((l) => (l.from || !newEff ? l : Object.assign({}, l, { from: newEff })));
      const sb3 = patch.contract.signedBy || {};
      const newSign = [sb3.surya, sb3.bp].filter(isDate).sort().pop();
      const oldFrom = lineFrom(c, (c.lines || [])[0]);
      // Normally the day before the new contract starts; if it "starts" before the old one (back-dated), the day before it was signed
      const base = newEff && (!oldFrom || newEff > oldFrom) ? newEff : (newSign || now.slice(0, 10));
      const to = addDays(base, -1);
      // Lines copied from the revenue report (BP added automatically) were never a contract: they are not kept as old lines
      const past = lineDiff(c.lines, next.lines).filter((d) => d.from && d.from.source !== 'report' && ['removed', 'replaced-old', 'changed'].includes(d.type))
        .map((d) => Object.assign({}, d.from, { from: lineFrom(c, d.from), to, endedBy: d.type === 'changed' ? 'new rate' : d.by || '' }));
      if (past.length) next.pastLines = (c.pastLines || []).concat(past);
    }
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
      // Every attached document counts, signed or not; only a document that was never attached is missing
      done: need.filter((r) => r.status !== 'missing').length, signed: need.filter((r) => r.status === 'signed').length, total: need.length,
    };
  }

  // What needs someone's attention, most urgent first.
  function flags(c, now) {
    const f = [];
    if (c && c.autoCreated && !(c.lines || []).some((l) => l.source !== 'report')) {
      return [{ level: 3, text: 'No contract in the tracker: Finance pays this BP (' + ((c.lines || []).map((l) => l.code).join(', ') || 'see revenue report') + '). Add its Lines Annex and Vehicles Annex.' }];
    }
    c = Object.assign({ lines: [], docs: {}, history: [], rejections: [] }, c);
    c.lines = Array.isArray(c.lines) ? c.lines.filter(Boolean) : [];
    const last = latestRejection(c);
    if (c.stage === REJECTED && last && !last.resentAt) f.push({ level: 3, text: 'Rejected, revised contract not sent yet' });
    if (!c.docsReceived || c.docsPending === 'Not received') f.push({ level: 2, text: 'Onboarding documents not received (set “Docs received” to Yes and “Docs pending” to All received in Contracts)' });
    const dc = docCheck(c);
    if (!dc.type) f.push({ level: 1, text: 'Contract documents: tick “Existing BP” (new route, only Lines + Vehicles Annex) or mark it as a new BP (all 6)' });
    else {
      if (dc.missing.length) f.push({ level: 2, text: 'Missing contract documents: ' + dc.missing.map((r) => r.label).join(', ') });
    }
    if (c.pendingContract) f.push({ level: 1, text: 'Revised contract out for signing: ' + ((c.pendingContract.changes || []).length) + ' change(s) apply once signed' });
    if (!c.region) f.push({ level: 2, text: 'Region not set: pick N/W or South' });
    const mc = mingCheck(c);
    const n2 = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? '—' : Number(v).toFixed(2));
    // Small differences (₹0.08/km or less) are only highlighted (unless the BP is marked mingStrict: every difference is raised) in the Lines & MinG tab, not raised here
    mc.items.filter((i) => i.status === 'mismatch' && (c.mingStrict || !(Math.abs(Number(i.diff)) <= MING_TOLERANCE + 1e-9))).forEach((i) => f.push({ level: 3, text: `MinG mismatch on ${i.code}: contract ₹${n2(i.contract)}/km, revenue report ₹${n2(i.paid)}/km (${mc.period})` }));
    if (!c.lines.length && mc.extra.length) f.push({ level: 2, text: `Revenue report pays ${mc.extra.length} line${mc.extra.length > 1 ? 's' : ''} (${mc.extra.map((x) => x.code).join(', ')}) but no Lines Annex is entered (${mc.period})` });
    else mc.extra.forEach((x) => f.push({ level: 3, text: x.oldLine
      ? `Finance still pays the old line code ${x.code} (₹${n2(x.paid)}/km)${x.replacedBy ? ', replaced by ' + x.replacedBy : ''}${x.endedOn ? ' from ' + addDays(x.endedOn, 1) : ''}: ask Finance to switch to the new code (${mc.period})`
      : `${x.code} is in the revenue report at ₹${n2(x.paid)}/km but not in the signed Lines Annex (${mc.period})` }));
    if (c.lines.length && c.stage === 'Signed' && !c.annualMileage) f.push({ level: 1, text: 'Annual mileage missing: add the signed Vehicles Annex' });
    if (!c.lines.length) f.push({ level: c.stage === 'Signed' ? 2 : 1, text: c.stage === 'Signed' ? 'Lines missing: add the signed Lines Annex' : 'No lines entered' });
    else {
      const gap = (l) => ['code', 'rtKms', 'minG', 'rtAmt'].filter((k) => l[k] === null || l[k] === undefined || l[k] === '').map((k) => ({ code: 'line code', rtKms: 'RT kms', minG: 'MinG', rtAmt: 'RT amount' })[k]);
      const inc = c.lines.map((l) => ({ l, g: gap(l) })).filter((x) => x.g.length);
      // Only RT kms (and so RT amount) missing, MinG known: the weekly revenue report fills it in by itself
      const waiting = inc.filter((x) => x.l.code && x.l.minG != null && x.g.every((g) => g === 'RT kms' || g === 'RT amount'));
      const other = inc.filter((x) => !waiting.includes(x));
      if (waiting.length) f.push({ level: 1, text: 'RT kms blank in the contract for ' + waiting.map((x) => x.l.code).join(', ') + ': filled in automatically from the next Revenue Share Report' });
      if (other.length) f.push({ level: 1, text: 'Line details incomplete: ' + other.map((x) => (x.l.code || 'a line') + ' (' + x.g.join(', ') + ' missing)').join('; ') });
    }
    return f.sort((a, b) => b.level - a.level);
  }

  // Compare contract MinG (Lines Annex reference rate) with the rate paid in the weekly revenue share report.
  // Date a line applies from: its own date, or the contract's effective date
  function lineFrom(c, l) {
    if (l && isDate(l.from)) return l.from;
    return c && c.contract && isDate(c.contract.effectiveFrom) ? c.contract.effectiveFrom : null;
  }
  // The same line written two ways: "IN04301A" in a contract and "IN4301A" in Finance's report
  const lineKey = (code) => String(code || '').toUpperCase().replace(/\s+/g, '').replace(/^IN0(\d{4}[A-Z]?)$/, 'IN$1');
  function mingCheck(c) {
    const rep0 = c.revenueReport;
    if (!rep0 || !rep0.rates) return { status: 'no-report', items: [], extra: [] };
    // Look up paid rates by the normalised line code, keeping the code as Finance wrote it
    const paidBy = {}; Object.keys(rep0.rates).forEach((k) => { paidBy[lineKey(k)] = { code: k, rate: rep0.rates[k] }; });
    const rep = rep0;
    const end = isDate(rep.periodEnd) ? rep.periodEnd : isDate(rep.receivedOn) ? rep.receivedOn : null;
    if (c.autoCreated && !(c.lines || []).some((l) => l.source !== 'report')) return { status: 'no-contract', period: rep0.period, items: (c.lines || []).map((l) => ({ code: l.code, contract: null, paid: rep0.rates[l.code] ?? null, status: 'no-contract' })), extra: [] };
    const items = c.lines.filter((l) => l.code).map((l) => {
      const paid = paidBy[lineKey(l.code)] ? paidBy[lineKey(l.code)].rate : undefined;
      const f = lineFrom(c, l);
      if (end && f && f > end) return { code: l.code, contract: l.minG, paid: paid === undefined ? null : paid, status: 'not-started', from: f };
      if (paid === undefined) return { code: l.code, contract: l.minG, paid: null, status: 'not-in-report' };
      if (l.minG === null || l.minG === undefined || l.minG === '') return { code: l.code, contract: null, paid, status: 'no-ming' };
      const diff = round2(paid - l.minG);
      return { code: l.code, contract: l.minG, paid, diff, status: Math.abs(diff) < 0.005 ? 'ok' : 'mismatch' };
    });
    const codes = new Set(c.lines.map((l) => lineKey(l.code)));
    const extra = [];
    Object.keys(rep0.rates).filter((k) => !codes.has(lineKey(k))).forEach((k) => {
      const paidK = rep0.rates[k];
      // A line that was still running in the report's week (replaced since): compare with its old rate
      const old = end && (c.pastLines || []).filter((p) => lineKey(p.code) === lineKey(k) && (!p.to || p.to >= addDays(end, -6))).pop();
      if (old && old.minG != null) { const diff = round2(paidK - old.minG); items.push({ code: k, contract: old.minG, paid: paidK, diff, past: true, status: Math.abs(diff) < 0.005 ? 'ok' : 'mismatch' }); return; }
      // Paid under a code that was replaced earlier: say so, with the line that replaced it
      const was = (c.pastLines || []).filter((p) => lineKey(p.code) === lineKey(k)).pop();
      extra.push(was ? { code: k, paid: paidK, oldLine: true, replacedBy: was.endedBy && was.endedBy !== 'new rate' ? was.endedBy : '', endedOn: was.to || '' } : { code: k, paid: paidK });
    });
    const bad = items.some((i) => i.status === 'mismatch') || extra.length;
    return { status: bad ? 'mismatch' : 'ok', period: rep.period, items, extra };
  }

  // Lines whose contract leaves RT kms blank: take the RT kms from Finance's weekly Revenue Share Report
  // (revenueReport.lineKm = { LINE: round-trip km }, worked out as the week's Total KMs ÷ (Total Trips ÷ 2)).
  // Then the missing RT amount (or MinG) is worked out from the other two. Returns the codes that were filled.
  function fillFromReport(c) {
    const rep = c && c.revenueReport; const km0 = rep && rep.lineKm;
    if (!km0 || !Array.isArray(c.lines)) return [];
    const km = {}; Object.keys(km0).forEach((k) => { km[lineKey(k)] = km0[k]; });
    const filled = [];
    c.lines = c.lines.map((l) => {
      const v = Number(km[lineKey(l.code)]);
      if (!l.code || !(v > 0) || (l.rtKms !== null && l.rtKms !== undefined && l.rtKms !== '')) return l;
      const missing = ['rtAmt', 'minG'].filter((k) => l[k] === null || l[k] === undefined || l[k] === '');
      const next = normaliseLine(Object.assign({}, l, { rtKms: v, calc: missing.length === 1 ? missing[0] : null, printed: false }));
      next.kmsFrom = 'Revenue Share Report ' + (rep.period || '');
      filled.push(l.code);
      return next;
    });
    return filled;
  }

  // ---------- Revenue Share Report history (every report kept) ----------
  const dmyIso = (d) => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(d || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dLabel = (iso) => +iso.slice(8, 10) + ' ' + MON3[+iso.slice(5, 7) - 1];
  function reportPeriod(subject) {
    const m = /(\d{2}-\d{2}-\d{4})\s*to\s*(\d{2}-\d{2}-\d{4})/.exec(subject || '');
    if (!m) return null;
    const start = dmyIso(m[1]), end = dmyIso(m[2]);
    const label = start === end ? dLabel(start) + ' ' + end.slice(0, 4) : start.slice(0, 7) === end.slice(0, 7) ? `${+start.slice(8, 10)}–${dLabel(end)} ${end.slice(0, 4)}` : `${dLabel(start)} – ${dLabel(end)} ${end.slice(0, 4)}`;
    return { start, end, label, days: Math.round((new Date(end + 'T12:00:00Z') - new Date(start + 'T12:00:00Z')) / 864e5) + 1 };
  }
  const numOrNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  // Normalise one report email: { bp, subject, received, lines: { CODE: { km, trips, rate, cost } } }
  function normaliseReport(rep) {
    const per = reportPeriod(rep.subject); if (!per) return null;
    const lines = {};
    Object.keys(rep.lines || {}).forEach((k) => {
      const code = String(k).trim().toUpperCase(); if (!/^IN[0-9A-Z]{3,}$/.test(code)) return;
      const l = rep.lines[k] || {}; const km = numOrNull(l.km), trips = numOrNull(l.trips), rate = numOrNull(l.rate);
      let cost = numOrNull(l.cost); if (cost === null && km !== null && rate !== null) cost = round2(km * rate);
      lines[code] = { km, trips, rate, cost };
    });
    if (!Object.keys(lines).length) return null;
    return { start: per.start, end: per.end, period: per.label, days: per.days, from: String(rep.bp || '').trim(), received: String(rep.received || '').slice(0, 10), lines };
  }
  // The report the MinG check uses: the latest one covering at least 3 days (a 1-day stub like 1 Nov never replaces a week)
  function deriveRevenueReport(c) {
    const R = (c.reports || []).filter((r) => r.days >= 3).sort((a, b) => (a.end < b.end ? -1 : 1));
    const r = R[R.length - 1]; if (!r) return c.revenueReport || null;
    const rates = {}, lineKm = {}; let totalKm = 0;
    Object.keys(r.lines).forEach((k) => { const l = r.lines[k]; if (l.rate !== null) rates[k] = l.rate; if (l.km !== null) totalKm += l.km; if (l.km > 0 && l.trips >= 2) lineKm[k] = round2(l.km / (l.trips / 2)); });
    return { period: r.period, periodEnd: r.end, receivedOn: r.received, rates, totalKm: round2(totalKm), lineKm, from: r.from };
  }
  // Add one report to a BP (same BP name + same dates = replaced, not doubled). Returns true if anything changed.
  function addReport(c, rep) {
    const r = rep && rep.start && rep.end && rep.days ? rep : normaliseReport(rep); if (!r) return false;
    const list = (c.reports || []).slice();
    const i = list.findIndex((x) => x.start === r.start && x.end === r.end && nameKey(x.from) === nameKey(r.from));
    if (i >= 0) { if (sameValue(list[i], r)) return false; list[i] = r; } else list.push(r);
    list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    c.reports = list; c.revenueReport = deriveRevenueReport(c);
    if (c.autoCreated) refreshReportLines(c);
    return true;
  }
  // BPs created from a report (no contract yet): their lines are the codes Finance pays, MinG = the rate paid, RT kms / amount blank
  function refreshReportLines(c) {
    const last = {}; (c.reports || []).forEach((r) => Object.keys(r.lines).forEach((k) => { last[k] = r.lines[k].rate; }));
    const keep = (c.lines || []).filter((l) => l.source !== 'report');
    if (keep.length) return; // a contract was added: its lines win
    c.lines = Object.keys(last).map((k) => ({ code: k, minG: last[k], rtKms: null, rtAmt: null, calc: null, source: 'report' }));
  }
  function regionFromCodes(codes) { const s = codes.filter((k) => /^IN[45]/.test(k)).length; return s > codes.length / 2 ? 'South' : 'N/W'; }
  function contractFromReport(r, user) {
    const c = createContract({ bpName: r.from, region: regionFromCodes(Object.keys(r.lines)), stage: STAGES[0], lines: [],
      comments: 'Added automatically: Finance pays this BP but its contract is not in the tracker yet. Lines and MinG are taken from the Revenue Share Report.',
      historyNote: 'Created from the Revenue Share Report ' + r.period + '.' }, user || 'Revenue report check');
    c.autoCreated = true; c.lines = [];
    return c;
  }
  // ---------- Pro-rata payouts (a report is spread evenly over its days) ----------
  const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function overlapDays(a1, a2, b1, b2) { const s = a1 > b1 ? a1 : b1, e = a2 < b2 ? a2 : b2; return s > e ? 0 : Math.round((new Date(e + 'T12:00:00Z') - new Date(s + 'T12:00:00Z')) / 864e5) + 1; }
  // Payout (Bus Cost) and KMs between two dates, per BP or per line
  function payoutBetween(c, from, to, code) {
    let cost = 0, km = 0, trips = 0;
    (c.reports || []).forEach((r) => {
      const d = overlapDays(r.start, r.end, from, to); if (!d) return; const f = d / r.days;
      Object.keys(r.lines).forEach((k) => { if (code && lineKey(k) !== lineKey(code)) return; const l = r.lines[k]; cost += (l.cost || 0) * f; km += (l.km || 0) * f; trips += (l.trips || 0) * f; });
    });
    return { cost: round2(cost), km: round2(km), trips: Math.round(trips * 10) / 10 };
  }
  // Financial-year quarter (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) containing a date, and the one before
  function fyQuarter(iso, back) {
    let y = +iso.slice(0, 4), m = +iso.slice(5, 7); let q0 = Math.floor((m - 1) / 3) * 3 + 1; // calendar quarter start month (Jan/Apr/Jul/Oct)
    for (let i = 0; i < (back || 0); i++) { q0 -= 3; if (q0 < 1) { q0 += 12; y -= 1; } }
    const start = `${y}-${String(q0).padStart(2, '0')}-01`; const endM = q0 + 2;
    const end = addDaysIso(`${endM === 12 ? y + 1 : y}-${String(endM === 12 ? 1 : endM + 1).padStart(2, '0')}-01`, -1);
    const fy = q0 >= 4 ? y : y - 1; const qn = { 4: 1, 7: 2, 10: 3, 1: 4 }[q0];
    return { start, end, label: `Q${qn} FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`, months: `${MON3[q0 - 1]}–${MON3[endM - 1]} ${end.slice(0, 4)}` };
  }
  // Per line: first week paid (= effective from), round trips, KMs and payout till date, payout in the latest report
  function lineHistory(c) {
    const out = {};
    const R = (c.reports || []).slice().sort((a, b) => (a.start < b.start ? -1 : 1));
    const lastWeek = R.filter((r) => r.days >= 3).pop();
    R.forEach((r) => Object.keys(r.lines).forEach((k) => {
      const key = lineKey(k); const l = r.lines[k]; const o = out[key] || (out[key] = { code: k, first: r.start, trips: 0, km: 0, cost: 0, week: 0 });
      o.trips += l.trips || 0; o.km += l.km || 0; o.cost += l.cost || 0;
    }));
    if (lastWeek) Object.keys(lastWeek.lines).forEach((k) => { const o = out[lineKey(k)]; if (o) o.week = lastWeek.lines[k].cost || 0; });
    Object.values(out).forEach((o) => { o.km = round2(o.km); o.cost = round2(o.cost); });
    return { lines: out, lastWeek: lastWeek ? lastWeek.period : null, firstPaid: R.length ? R[0].start : null };
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
    if (k.length < 3) return null;
    const first = (n) => (String(n || '').toLowerCase().replace(/['’`´]\s*s\b/g, '').match(/[a-z0-9]+/) || [''])[0];
    const fits = (a) => {
      const x = nameKey(a);
      // One name is the other plus extra words, but only extra words that never tell two BPs apart (Pvt Ltd, Mobility Solutions…).
      // "Sunny Sharma" ≠ "Sunny Holidays", "New Himalaya Travels" ≠ "New Himalaya Travels (Firm)": those are different BPs.
      return x.length >= 3 && x === k;
    };
    // Several BPs may fit (e.g. "Asian Shina…" and "Asian Travels"): take the one whose name is closest
    const cands = list.filter((c) => !c.archived && [c.bpName].concat(c.aliases || []).some(fits))
      .map((c) => ({ c, score: Math.max(...[c.bpName].concat(c.aliases || []).map((a) => nameScore(name, a))) }))
      .sort((a, b) => b.score - a.score);
    const sim = similarBps(list, name)[0];
    const near = cands.length ? (sim && sim.score > cands[0].score ? sim.c : cands[0].c) : null;
    // Only a name that is really the same counts. A merely similar name (Supreme Travels / Supreme Enterprises) is a
    // different BP until someone says otherwise: the form shows the "looks like an existing BP" note for that.
    return near ? { c: near, how: 'similar' } : null;
  }
  // Two PDFs belong to the same BP (used when several PDFs are attached together)
  function sameBp(a, b) {
    if (!a || !b) return true;
    const ka = nameKey(a), kb = nameKey(b);
    if (ka && ka === kb) return true;
    if (ka.length >= 5 && kb.length >= 5 && (ka.startsWith(kb) || kb.startsWith(ka))) return true;
    return nameScore(a, b) >= 0.9;
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
  // ---- What is already attached, per document (so adding the pending documents later never needs the earlier ones again) ----
  const latestDate = (...ds) => ds.filter(isDate).sort().pop() || null;
  const docName = (k) => (DOC_TYPES.find((d) => d[0] === k) || [k, k])[1];
  // c.contractDocs = { lines: { status, file, envelopeId, signedOn, effectiveFrom, at }, vehicles: {…}, … }.
  // BPs saved before this existed: worked out from the one contract record + the documents checklist.
  function knownDocs(c) {
    const out = {}; const saved = (c && c.contractDocs) || {};
    const con = c && c.contract; const docs = (c && c.docs) || {};
    const names = con ? String(con.documents || '').toLowerCase() : '';
    DOC_TYPES.forEach(([k, n]) => {
      if (saved[k]) { out[k] = Object.assign({}, saved[k]); return; }
      const inCon = con && names.includes(n.toLowerCase());
      if (!inCon && !(docs[k] && docs[k] !== 'missing')) return;
      out[k] = { status: docs[k] || 'copy', file: inCon ? con.file || '' : '', envelopeId: inCon && con.envelopeId && con.envelopeId.length > 8 ? con.envelopeId : null,
        signedOn: inCon ? latestDate(con.signedBy && con.signedBy.bp, con.signedBy && con.signedBy.surya) : null, effectiveFrom: inCon && k === 'lines' ? con.effectiveFrom || null : null, earlier: true };
    });
    return out;
  }
  // The documents in this upload, each with its own file, envelope and signing date
  function uploadDocs(r, docMap) {
    const parts = r.parts && r.parts.length ? r.parts : [{ file: (r.files || []).join(', '), docKeys: Object.keys(r.docMap || {}), envelopeId: r.envelopeId, signedBy: r.signedBy, signedOn: r.signedOn, effectiveFrom: r.effectiveFrom }];
    const out = {};
    parts.forEach((p) => (p.docKeys || []).forEach((k) => {
      if (!docMap[k]) return;
      const sb = p.signedBy || {};
      const o = { status: docMap[k], file: p.file || '', envelopeId: p.envelopeId || null, signedOn: latestDate(sb.bp, sb.surya, p.signedOn), effectiveFrom: k === 'lines' ? p.effectiveFrom || null : null };
      if (!out[k] || (DOC_RANK[o.status] || 0) > (DOC_RANK[out[k].status] || 0)) out[k] = o;
    }));
    return out;
  }
  // Is this upload's document older than the one already in the tracker? Signing date first, then (Lines Annex) the effective date.
  function olderDoc(k, inc, was, revised) {
    if (!was) return false;
    const a = inc.signedOn, b = was.signedOn;
    if (a && b && a !== b) return a < b;
    if (k === 'lines' && inc.effectiveFrom && was.effectiveFrom && inc.effectiveFrom !== was.effectiveFrom) return inc.effectiveFrom < was.effectiveFrom;
    // A less-signed copy of a document the tracker already has signed (and nothing in it changed) is an earlier version too
    return !revised && (DOC_RANK[inc.status] || 0) < (DOC_RANK[was.status] || 0);
  }
  // One contract record listing every document attached so far (the newest version of each)
  function mergeContract(old, add, replaced, hasLines) {
    if (!old) return add;
    const split = (s) => String(s || '').split(/\s*[;,]\s*(?=[A-Z])/).map((x) => x.trim()).filter((x) => x && x !== 'PDF');
    const typeOf = (x) => { const t = DOC_TYPES.find(([, n]) => x.toLowerCase().includes(n.toLowerCase().split(' ')[0].toLowerCase()) && x.toLowerCase().includes((n.split(' ')[1] || '').toLowerCase())); return t ? t[0] : null; };
    const oldDocs = split(old.documents).filter((x) => !replaced.includes(typeOf(x)));
    const docs = oldDocs.concat(split(add.documents).filter((x) => !oldDocs.some((y) => typeOf(y) && typeOf(y) === typeOf(x))));
    const order = (x) => { const t = typeOf(x); const i = DOC_TYPES.findIndex((d) => d[0] === t); return i < 0 ? 99 : i; };
    docs.sort((a, b) => order(a) - order(b));
    const fileType = (f) => { const t = DOC_TYPES.find(([, n]) => f.toLowerCase().includes(n.toLowerCase())); return t ? t[0] : null; };
    const oldFiles = String(old.file || '').split(/,\s*(?=\S)/).map((x) => x.trim()).filter(Boolean);
    const newFiles = String(add.file || '').split(/,\s*(?=\S)/).map((x) => x.trim()).filter(Boolean);
    const files = oldFiles.filter((f) => !replaced.includes(fileType(f)) && !newFiles.includes(f)).concat(newFiles);
    const stamped = add.envelopeId && add.envelopeId.length > 8;
    return Object.assign({}, old, {
      documents: docs.join(', ') || add.documents, file: files.join(', '),
      envelopeId: stamped ? add.envelopeId : old.envelopeId || add.envelopeId,
      effectiveFrom: hasLines ? add.effectiveFrom || old.effectiveFrom || '' : old.effectiveFrom || add.effectiveFrom || '',
      status: add.status || old.status || '', signedBy: stamped || !old.signedBy ? add.signedBy : old.signedBy,
    });
  }

  function planFromPdf(list, r, opts) {
    opts = opts || {};
    const target = !opts.forceNew && opts.targetId ? list.find((x) => x.id === opts.targetId) : null;
    // Which BP: the one picked by hand, else the name in the PDF, else the name in any of the attached PDFs
    // (a Vehicles Annex may say "V.M.TRAVELS - SYED AKBAR SYED NASEER" while the Lines Annex says "V.M. Travels"),
    // else the firm part of the name (before " - "), when exactly one BP fits
    let m = null;
    if (!opts.forceNew) {
      // Every name the PDFs give this BP: the entity name, and the names as written (e.g. with the owner: "Kishore Kumar_Reliance Travels")
      const allNames = [r.bpName, r.entityName].concat(r.names || [], ...(r.parts || []).map((p) => [p.bpName].concat(p.names || []))).filter((n, i, a) => n && a.indexOf(n) === i);
      if (target) m = { c: target, how: 'chosen' };
      if (!m) m = matchBp(list, r.bpName);
      if (!m) allNames.some((n) => { const x = matchBp(list, n); if (x) m = { c: x.c, how: 'similar' }; return !!x; });
      if (!m) allNames.some((n) => { const x = matchNamePart(list, n); if (x) m = { c: x, how: 'similar' }; return !!x; });
    }
    const c = m ? m.c : null;
    const lines = (r.lines || []).map((l) => normaliseLine({ code: l.code, route: l.route, rtKms: l.rtKms, minG: l.minG, rtAmt: l.rtAmt, from: r.effectiveFrom || null,
      calc: l.kmsWorkedOut ? 'rtKms' : l.amtWorkedOut ? 'rtAmt' : null, printed: !l.kmsWorkedOut && !l.amtWorkedOut && l.rtKms != null && l.minG != null && l.rtAmt != null, source: 'pdf' }));
    const stamped = !!r.envelopeId;
    let signed = r.stage === 'Signed' || (!stamped && opts.signedAnswer === true);
    const needsAnswer = !stamped && opts.signedAnswer === undefined;
    let flowStage = signed ? 'Signed' : r.stage || 'Merchant signature pending';
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
        bpType, docs: docMap, rcm: r.rcm || null, rcmClause: r.rcmClause || '', docsReceived: true, contractDocs: uploadDocs(r, docMap),
        aliases: (r.names || []).filter((n) => n && nameKey(n) !== nameKey(r.bpName)), entityName: r.entityName || '', historyNote: 'Added from contract PDF ' + contract.file + '. ' + signLabel + '.' };
      if (!r.bpName) plan.notes.push('The BP name was not found in the PDF: type it in.');
      return plan;
    }

    // Existing BP. A contract counts as older only if it starts earlier AND was not signed later than the one in the tracker
    // (a revised annex can be signed in July with an effective date in May).
    // Each document is compared with the SAME document already in the tracker (Vehicles Annex with Vehicles Annex…),
    // so adding the pending documents later never needs the ones that are already attached.
    const known = knownDocs(c);
    const incoming = uploadDocs(r, docMap);
    const incKeys = Object.keys(incoming);
    // A revised Lines Annex (other lines) or Vehicles Annex (other mileage) is never an earlier version, even when not signed yet
    const revised = { lines: lines.length > 0 && lineDiff(c.lines, lines).length > 0, vehicles: !!(r.annualMileage && r.annualMileage !== c.annualMileage) };
    const olderKeys = incKeys.filter((k) => olderDoc(k, incoming[k], known[k], revised[k]));
    const isOlder = incKeys.length > 0 && olderKeys.length === incKeys.length;
    plan.kept = DOC_TYPES.filter(([k]) => known[k] && !incoming[k]).map(([k, n]) => ({ key: k, name: n, status: known[k].status, signedOn: known[k].signedOn }));
    if (isOlder) {
      plan.kind = 'none';
      const k0 = olderKeys[0], a = incoming[k0], b = known[k0];
      plan.notes.push(olderKeys.length > 1 ? `Every document in this upload is an earlier version of one already in the tracker (${olderKeys.map(docName).join(', ')}), so nothing is changed.`
        : a.signedOn && b.signedOn && a.signedOn !== b.signedOn ? `This ${docName(k0)} was signed on ${a.signedOn}, before the one already in the tracker (signed ${b.signedOn}), so nothing is changed.`
        : a.effectiveFrom && b.effectiveFrom && a.effectiveFrom !== b.effectiveFrom ? `This ${docName(k0)} (effective ${a.effectiveFrom}) is older than the one already in the tracker (effective ${b.effectiveFrom}), so nothing is changed.`
        : `The tracker already has this ${docName(k0)} ${b.status === 'signed' ? 'signed' : 'in a later version'}, so nothing is changed.`);
      return plan;
    }
    // A document in this upload that is older than the one in the tracker is left out; the rest is used
    olderKeys.forEach((k) => {
      const a = incoming[k], b = known[k];
      plan.notes.push(a.signedOn && b.signedOn && a.signedOn !== b.signedOn ? `The ${docName(k)} in this upload is older than the one already in the tracker, so the tracker keeps its ${docName(k)}.`
        : `The tracker already has the ${docName(k)} ${b.status === 'signed' ? 'signed' : 'in a later version'}, so it keeps that one.`);
      delete docMap[k]; delete incoming[k];
    });
    if (olderKeys.includes('lines')) lines.splice(0, lines.length);
    if (olderKeys.includes('vehicles')) r = Object.assign({}, r, { annualMileage: null });
    // The stage then follows only the documents that are used
    if (olderKeys.length && Object.keys(incoming).length) {
      const st = Object.values(incoming).map((x) => x.status);
      const f2 = st.every((x) => x === 'signed') ? 'Signed' : st.some((x) => x === 'sent' || x === 'pending') ? 'Merchant signature pending' : st.some((x) => x === 'surya') ? 'Surya signature pending' : null;
      if (f2) { flowStage = f2; signed = f2 === 'Signed'; }
    }
    // RT kms are never filled in from the revenue report: a contract without them is flagged red in Needs attention
    const diff = lines.length ? lineDiff(c.lines, lines) : [];
    // Lines that didn't change keep the date they started
    lines.forEach((l) => { if (diff.some((d) => d.code === l.code)) return; const o = c.lines.find((x) => x.code === l.code); const f = o && lineFrom(c, o); if (f) l.from = f; else delete l.from; });
    const mileage = r.annualMileage && r.annualMileage !== c.annualMileage ? { from: c.annualMileage, to: r.annualMileage } : null;
    plan.mileageAfter = mileage ? mileage.to : c.annualMileage;
    const text = diff.map(describeDiff).filter(Boolean);
    plan.diff = diff;
    plan.unchanged = lines.length ? lines.filter((l) => !diff.some((d) => d.code === l.code)).map((l) => l.code) : [];
    if (mileage) text.push(`Annual mileage: ${mileage.from ? fmtN(mileage.from) + ' km' : 'empty'} → ${fmtN(mileage.to)} km`);
    const patch = {};
    // The names written in these PDFs are saved as other names of this BP, so the next PDF is recognised straight away
    const pdfNames = [r.bpName].concat(r.names || [], ...(r.parts || []).map((p) => [p.bpName].concat(p.names || []))).map((n) => String(n || '').trim()).filter((n, i, a) => n && a.indexOf(n) === i);
    const newNames = pdfNames.filter((n) => !findDuplicate([c], n));
    if (newNames.length && !opts.forceNew) { patch.aliases = (c.aliases || []).concat(newNames); plan.newNames = newNames; }
    if (r.entityName && r.entityName !== c.entityName) patch.entityName = r.entityName;
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
    const trustPdf = stamped && !isOlder;
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
    // "Signed" only when no other required document is still out for signature in DocuSign
    const reqDocs = requiredDocs({ bpType });
    const stageNow = patch.stage || c.stage;
    if (stageNow === 'Signed') {
      const waiting = reqDocs.filter((k) => !incoming[k] && ['sent', 'pending', 'surya'].includes(docsAfter[k]));
      if (waiting.length) {
        const st = waiting.some((k) => docsAfter[k] !== 'surya') ? 'Merchant signature pending' : 'Surya signature pending';
        for (let i = text.length - 1; i >= 0; i--) if (/^Stage: .* → Signed/.test(text[i])) text.splice(i, 1);
        if (st !== c.stage) { patch.stage = st; text.push(`Stage: ${c.stage} → ${st} (${waiting.map(docName).join(', ')} still waiting for signature)`); }
        else delete patch.stage;
      }
    }
    if (c.pendingContract) patch.pendingContract = null;
    // Keep every document attached before: the contract record lists them all, newest version of each
    const replacedDocs = incKeys.filter((k) => incoming[k]);
    plan.contractAfter = mergeContract(c.contract, contract, replacedDocs, lines.length > 0);
    const docsMem = {}; Object.keys(known).forEach((k) => { docsMem[k] = Object.assign({}, known[k]); delete docsMem[k].earlier; });
    incKeys.forEach((k) => { docsMem[k] = Object.assign({}, incoming[k], { at: (opts.now || new Date().toISOString()).slice(0, 10) }); });
    plan.contractDocsAfter = docsMem;
    if (!sameValue(c.contractDocs || null, docsMem)) patch.contractDocs = docsMem;
    if (text.length) patch.contract = plan.contractAfter;
    else if (!c.contract || c.contract.envelopeId !== contract.envelopeId) {
      if (contract.envelopeId.length > 8 || !c.contract) {
        patch.contract = plan.contractAfter;
        text.push('Lines, mileage and stage already match. Contract document recorded: ' + ((r.docs || []).join(', ') || contract.documents) + (contract.envelopeId.length > 8 ? ', envelope ' + contract.envelopeId.slice(0, 8) + '…' : ''));
      }
    }
    text.push(...docText);
    plan.changes = text;
    if (plan.newNames) text.push('Saved as another name of ' + c.bpName + ': ' + plan.newNames.join(', '));
    if (!Object.keys(patch).filter((k) => !['contractDocs', 'aliases', 'entityName'].includes(k)).length) { plan.kind = 'none'; plan.notes.push('Everything in this PDF already matches the tracker. Nothing to update.'); return plan; }
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
    STAGES, REJECTED, ALL_STAGES, OPTIONS, FIELDS, STALE_DAYS, MING_TOLERANCE,
    normaliseLine, editLine, createContract, updateContract, rejectContract, resendContract,
    latestRejection, daysInStage, checklist, flags, totals, mingCheck, seedContracts, blankContract, nameKey, findDuplicate, duplicateLines, matchBp, lineDiff, describeDiff, planFromPdf, DOC_TYPES, DOC_STATUS, BP_TYPES, requiredDocs, docCheck, mergeDocs, withDocDefaults, sameValue, similarBps, nameScore, lineFrom, fillFromReport, sameBp, lineKey,
    reportPeriod, normaliseReport, knownDocs, mergeContract, matchFirmPart, matchNamePart, addReport, deriveRevenueReport, contractFromReport, payoutBetween, fyQuarter, lineHistory, overlapDays,
  };
});
