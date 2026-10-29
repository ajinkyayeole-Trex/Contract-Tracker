/* Flix India BP Contract Tracker: dashboard UI */
(function () {
  'use strict';
  const C = window.Core;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmt = (n, d) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d == null ? 2 : d }));
  const inr = (n) => (n === null || n === undefined ? '—' : '₹' + fmt(n, 0));
  const lakh = (n) => (n >= 1e7 ? fmt(n / 1e7, 2) + '<span>Cr</span>' : fmt(n / 1e5, 1) + '<span>L</span>');
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isActive = (c) => c.accountActivation === 'Active' || c.accountActivation === 'Already active';
  const IN_PROGRESS = C.STAGES.slice(0, 4);
  // Groups used in the North/West vs South comparison
  const GROUPS = {
    pending: { label: 'Pending (not signed yet)', test: (c) => IN_PROGRESS.includes(c.stage) },
    ready: { label: 'Ready, not yet sent for signing', test: (c) => c.stage === 'Framework created' || c.stage === 'Peer approval' },
    out: { label: 'Out for signing', test: (c) => c.stage === 'Merchant signature pending' || c.stage === 'Surya signature pending' },
    revised: { label: 'Revised contract out for signing', test: (c) => GROUPS.out.test(c) && !!(C.latestRejection(c) || {}).resentAt },
  };
  const NO_REGION = '__none';
  const regionOf = (c) => c.region || NO_REGION;
  const regionName = (r) => (r === NO_REGION ? 'No region set' : r);

  const state = {
    contracts: [], me: { name: '', canEdit: true }, demo: false, syncedAt: null,
    scope: '', // '' = N/W + South, or just 'N/W' / 'South'
    f: { q: '', region: '', stage: '', group: '', attn: false },
    cf: {}, // column filters on the Contracts table
    sort: { key: 'stage', asc: true },
    openId: null, draft: null,
  };

  // ---------- Data: real server, or in-memory preview ----------
  const api = {
    async call(method, url, body) {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data.error || 'The server did not respond. Try again.'); e.current = data.current; throw e; }
      return data;
    },
    async init() {
      try {
        if (location.protocol === 'file:' || (window.GhStore && GhStore.repo())) throw new Error('no server');
        state.me = await this.call('GET', 'api/me');
        state.contracts = await this.call('GET', 'api/contracts');
        state.mode = 'server';
      } catch (e) {
        state.demo = true;
        if (window.GhStore && GhStore.repo()) await this.initGithub();
        else this.initLocal();
      }
      state.syncedAt = new Date();
    },
    // Published on GitHub Pages: everyone shares data.json in the repository
    async initGithub() {
      state.mode = 'github';
      // Login protection: if the shared data is locked, ask for a login ID + password before showing anything
      await GhStore.restoreSession();
      let locked = false;
      try { await GhStore.readForViewer(); } catch (e) { locked = !!e.locked; }
      if (locked) await gate();
      const ed = GhStore.editor.get();
      let d = null;
      if (ed) { try { d = await GhStore.readLatest(); } catch (e) { GhStore.editor.clear(); toastLater(e.message); } }
      const signedIn = !!(ed && d);
      if (!d) d = await GhStore.readForViewer().catch(() => ({ contracts: null }));
      state.contracts = d.contracts || C.seedContracts();
      state.saved = { at: d.savedAt, by: d.savedBy };
      state.me = signedIn ? { name: ed.name, canEdit: true } : { name: 'Viewer', canEdit: false };
      githubBanner();
    },
    // Opened as a file, or on another host: keep changes in this browser
    initLocal() {
      state.mode = 'local';
      state.me = { name: 'This browser', canEdit: true };
      const saved = local.load();
      state.contracts = saved || C.seedContracts();
      $('#preview-banner').hidden = false;
      $('#preview-banner').innerHTML = local.ok
        ? `Changes are saved <b>in this browser only</b>. Use “⬇ Excel” to share a copy. <button type="button" class="link-btn" id="btn-reset-local">Reset to starting data</button>`
        : 'Preview: changes are not saved and reset when you refresh.';
    },
    // Change one BP on top of the latest shared data
    async ghEdit(c, fn, message) {
      const by = state.me.name;
      const res = await GhStore.commit((list) => {
        const i = list.findIndex((x) => x.id === c.id);
        if (i < 0) { const e = new Error(`${c.bpName} is no longer in the tracker.`); e.latest = list; throw e; }
        const cur = list[i];
        if (cur.updatedAt !== c.updatedAt) {
          const last = (cur.history || []).slice(-1)[0];
          const e = new Error(`${cur.bpName} was just changed by ${last ? last.by : 'someone else'}. The latest version is shown now: make your change again.`);
          e.current = cur; e.latest = list; throw e;
        }
        const next = fn(cur, by); const l = list.slice(); l[i] = next;
        return { list: l, result: next, unchanged: next.updatedAt === cur.updatedAt };
      }, message + ' (' + by + ')', by, state.contracts);
      state.contracts = res.list; state.saved = { at: new Date().toISOString(), by };
      return res.result;
    },
    async create(body) {
      if (state.mode === 'github') {
        const by = state.me.name;
        const res = await GhStore.commit((list) => {
          const dup = C.findDuplicate(list, body.bpName);
          if (dup) { const e = new Error(`This BP is already in the tracker as “${dup.bpName}”. Open it from the list instead.`); e.latest = list; throw e; }
          const c = C.createContract(body, by);
          return { list: list.concat([c]), result: c };
        }, 'Add ' + body.bpName + ' (' + by + ')', by, state.contracts);
        state.contracts = res.list; state.saved = { at: new Date().toISOString(), by };
        return res.result;
      }
      if (state.demo) {
        const dup = C.findDuplicate(state.contracts, body.bpName);
        if (dup) throw new Error(`This BP is already in the tracker as “${dup.bpName}”. Open it from the list instead.`);
        return C.createContract(body, state.me.name);
      }
      return this.call('POST', 'api/contracts', body);
    },
    async update(c, changes) {
      if (state.mode === 'github') return this.ghEdit(c, (cur, by) => C.updateContract(cur, changes, by), 'Update ' + c.bpName);
      if (state.demo) return C.updateContract(c, changes, state.me.name);
      return this.call('PATCH', 'api/contracts/' + c.id, { changes, updatedAt: c.updatedAt });
    },
    async reject(c, body) {
      if (state.mode === 'github') return this.ghEdit(c, (cur, by) => C.rejectContract(cur, body, by), 'Reject ' + c.bpName);
      if (state.demo) return C.rejectContract(c, body, state.me.name);
      return this.call('POST', 'api/contracts/' + c.id + '/reject', Object.assign({ updatedAt: c.updatedAt }, body));
    },
    async resend(c) {
      if (state.mode === 'github') return this.ghEdit(c, (cur, by) => C.resendContract(cur, by), 'Resend ' + c.bpName);
      if (state.demo) return C.resendContract(c, state.me.name);
      return this.call('POST', 'api/contracts/' + c.id + '/resend', { updatedAt: c.updatedAt });
    },
  };

  // Browser storage, used only when there is no server
  const local = {
    KEY: 'flix-bp-tracker-v1',
    get ok() { try { const k = '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; } },
    load() { try { const d = JSON.parse(localStorage.getItem(this.KEY) || 'null'); return d && Array.isArray(d.contracts) ? d.contracts : null; } catch (e) { return null; } },
    save() { try { localStorage.setItem(this.KEY, JSON.stringify({ savedAt: new Date().toISOString(), contracts: state.contracts })); } catch (e) { /* storage full or blocked */ } },
    clear() { try { localStorage.removeItem(this.KEY); } catch (e) { /* ignore */ } },
  };
  const byId = (id) => state.contracts.find((x) => x.id === id);
  function upsert(c) {
    const i = state.contracts.findIndex((x) => x.id === c.id);
    if (i >= 0) state.contracts[i] = c; else state.contracts.push(c);
    if (state.mode === 'local') local.save();
  }
  function toastLater(msg) { setTimeout(() => toast(msg, true), 1500); }
  const timeIN = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function githubBanner() {
    const b = $('#preview-banner'); b.hidden = false;
    const last = state.saved && state.saved.at ? ` Last saved ${timeIN(state.saved.at)}${state.saved.by ? ' by ' + esc(state.saved.by) : ''}.` : '';
    b.className = 'banner ' + (state.me.canEdit ? 'ok' : '');
    const s = GhStore.session();
    const lock = s.protected
      ? ` · 🔒 Logged in as <b>${esc(s.loginId)}</b>${state.me.canEdit ? ` <button type="button" class="link-btn" id="btn-logins">Manage logins</button>` : ''} <button type="button" class="link-btn" id="btn-logout">Log out</button>`
      : (state.me.canEdit ? ` · <button type="button" class="link-btn" id="btn-protect">🔒 Turn on login protection</button>` : '');
    b.innerHTML = (state.me.canEdit
      ? `Signed in as <b>${esc(state.me.name)}</b>. Every change you make is saved for the whole team; others see it within a few minutes.${last} <button type="button" class="link-btn" id="btn-signout">Sign out</button>`
      : `<b>View only.</b> This shows everything the team has saved.${last} Editors: <button type="button" class="link-btn" id="btn-signin">🔑 sign in</button> to add or change BPs.`) + lock;
  }

  // ---------- Login screen (when the data is protected) ----------
  function gate() {
    const g = $('#gate'); g.hidden = false; document.body.classList.add('gated');
    const f = $('#form-gate'); $('[name=loginId]', f).focus();
    return new Promise((resolve) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = $('button[type=submit]', f); btn.disabled = true; btn.textContent = 'Checking…'; $('#gate-error').textContent = '';
        try {
          await GhStore.login($('[name=loginId]', f).value, $('[name=password]', f).value);
          $('[name=password]', f).value = ''; g.hidden = true; document.body.classList.remove('gated'); resolve();
        } catch (err) { $('#gate-error').textContent = err.message; $('[name=password]', f).select(); }
        finally { btn.disabled = false; btn.textContent = 'Log in'; }
      };
    });
  }

  // Editors: turn on protection the first time
  function openProtect() {
    const f = $('#form-protect'); f.reset(); $('#protect-error').textContent = '';
    $('#protect-step1').hidden = false; $('#protect-step2').hidden = true;
    $('#dlg-protect').showModal(); $('[name=loginId]', f).focus();
  }
  async function doProtect(e) {
    e.preventDefault();
    const f = e.target; const btn = $('button[type=submit]', f);
    const id = $('[name=loginId]', f).value.trim(), pw = $('[name=password]', f).value;
    if (pw !== $('[name=password2]', f).value) { $('#protect-error').textContent = 'The two passwords are not the same.'; return; }
    if (!confirm(`Turn on login protection?\n\nFrom now on everyone needs a login ID and password to open the tracker. Your first login is “${id}”. Write the password down: it cannot be recovered if it is lost.`)) return;
    btn.disabled = true; btn.textContent = 'Locking the data…'; $('#protect-error').textContent = '';
    try {
      // Save the built-in document checklist and RCM values into each BP first, so nothing depends on core.js any more
      const out = await GhStore.protect(id, pw, state.me.name, (list) => list.map((c) => C.withDocDefaults(Object.assign({}, c))), state.contracts);
      state.contracts = out.list; state.saved = { at: new Date().toISOString(), by: state.me.name };
      protectBackup = JSON.stringify(out.file, null, 1);
      $('#protect-step1').hidden = true; $('#protect-step2').hidden = false;
      githubBanner(); renderAll();
    } catch (err) { $('#protect-error').textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = 'Turn on login protection'; }
  }
  let protectBackup = '';
  function downloadBackup() {
    const text = protectBackup || JSON.stringify(GhStore.session().file, null, 1);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = 'data.json'; document.body.appendChild(a); a.click(); a.remove();
  }

  // Editors: add / remove logins, or set a new password
  function drawLogins() {
    const s = GhStore.session();
    $('#logins-list').innerHTML = s.logins.map((l) => `<li><b>${esc(l.id)}</b><span>added ${l.addedAt ? timeIN(l.addedAt) : ''}${l.addedBy ? ' by ' + esc(l.addedBy) : ''}</span><button type="button" class="link-btn" data-rm-login="${esc(l.id)}">Remove</button></li>`).join('') || '<li>No logins</li>';
  }
  function openLogins() {
    const f = $('#form-logins'); f.reset(); $('#logins-error').textContent = '';
    drawLogins(); $('#dlg-logins').showModal();
  }
  async function doSetLogin(e) {
    e.preventDefault();
    const f = e.target; const btn = $('button[type=submit]', f);
    const id = $('[name=loginId]', f).value.trim(), pw = $('[name=password]', f).value;
    const exists = GhStore.session().logins.some((l) => l.id.toLowerCase() === id.toLowerCase());
    btn.disabled = true; $('#logins-error').textContent = '';
    try {
      await GhStore.setLogin(id, pw, state.me.name);
      f.reset(); drawLogins(); toast(exists ? `New password set for ${id}` : `Login ${id} added. Share the password with them in person or on Teams.`);
    } catch (err) { $('#logins-error').textContent = err.message; }
    finally { btn.disabled = false; }
  }
  async function doRemoveLogin(id) {
    if (!confirm(`Remove the login “${id}”? It will stop working the next time someone opens the tracker with it.`)) return;
    $('#logins-error').textContent = '';
    try { await GhStore.removeLogin(id, state.me.name); drawLogins(); toast(`Login ${id} removed`); }
    catch (err) { $('#logins-error').textContent = err.message; }
  }
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function fail(e) {
    if (e.latest) state.contracts = e.latest;
    if (e.current) { upsert(e.current); if (state.openId === e.current.id) state.draft = clone(e.current); }
    renderAll();
    toast(e.message, true);
  }

  // ---------- Filters ----------
  const inScope = () => state.contracts.filter((c) => !state.scope || c.region === state.scope);
  // ---------- Column filters (one per column of the Contracts table, in the same order) ----------
  // KMs operated in the week of the latest Revenue Share Report (the BP's "Total KMs" grand total)
  const weekKm = (c) => (c.revenueReport && c.revenueReport.totalKm) || null;
  const YN = ['Yes', 'No'];
  const ynText = (b) => (b ? 'Yes' : 'No');
  const COLF = [
    { k: 'bpName', text: 'Search name', get: (c) => c.bpName + ' ' + (c.aliases || []).join(' ') + ' ' + (c.owner || '') },
    { k: 'region', opts: () => ['N/W', 'South', 'Not set'], get: (c) => c.region || 'Not set' },
    { k: 'stage', opts: () => C.ALL_STAGES, get: (c) => c.stage },
    { k: 'docs', opts: () => ['All signed', 'Missing documents', 'Not signed yet', 'New BP', 'Existing BP', 'Not decided'], test: (c, v) => {
      const d = C.docCheck(c);
      if (v === 'All signed') return d.type && d.done === d.total;
      if (v === 'Missing documents') return d.type && d.missing.length > 0;
      if (v === 'Not signed yet') return d.type && d.notSigned.length > 0;
      if (v === 'New BP') return d.type === 'new';
      if (v === 'Existing BP') return d.type === 'existing';
      return !d.type;
    } },
    { k: 'rcm', opts: () => ['Yes', 'No', 'Not checked'], get: (c) => (c.rcm === 'yes' ? 'Yes' : c.rcm === 'no' ? 'No' : 'Not checked') },
    { k: 'docsReceived', opts: () => YN, get: (c) => ynText(c.docsReceived) },
    { k: 'sfAccountCreated', opts: () => YN, get: (c) => ynText(c.sfAccountCreated) },
    { k: 'bankDetails', opts: () => C.OPTIONS.bankDetails, get: (c) => c.bankDetails },
    { k: 'onboardingForm', opts: () => YN, get: (c) => ynText(c.onboardingForm) },
    { k: 'docsPending', opts: () => C.OPTIONS.docsPending, get: (c) => c.docsPending },
    { k: 'lines', text: 'Line code', get: (c) => c.lines.map((l) => l.code + ' ' + (l.route || '')).join(' '), extra: ['MinG mismatch', 'No lines'] },
    { k: 'rtAmt', opts: () => ['Has RT amount', 'No RT amount'], get: (c) => (C.totals(c).rtAmt ? 'Has RT amount' : 'No RT amount') },
    { k: 'annualMileage', opts: () => ['Filled in', 'Missing'], get: (c) => (c.annualMileage ? 'Filled in' : 'Missing') },
    { k: 'weekKm', opts: () => ['In this week\'s report', 'Not in report'], get: (c) => (weekKm(c) ? 'In this week\'s report' : 'Not in report') },
    { k: 'comments', text: 'Search', get: (c) => c.comments || '' },
  ];
  function colMatch(c) {
    return COLF.every((f) => {
      const v = state.cf[f.k];
      if (!v) return true;
      if (f.k === 'lines' && v === '__mismatch') return C.mingCheck(c).status === 'mismatch' && c.lines.length;
      if (f.k === 'lines' && v === '__none') return !c.lines.length;
      if (f.test) return f.test(c, v);
      if (f.text) return f.get(c).toLowerCase().includes(v.toLowerCase());
      return f.get(c) === v;
    });
  }
  // A small funnel button on each column header (after BP name) opens a little list of choices.
  // Styles are inline as well, so it looks right even if a browser still has an old styles.css cached.
  const FUNNEL = '<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" style="display:block"><path fill="currentColor" d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/></svg>';
  const CFB_STYLE = 'margin-left:5px;padding:2px 3px;border:1px solid transparent;border-radius:4px;background:transparent;color:#8b949e;cursor:pointer;vertical-align:middle;display:inline-flex;align-items:center;line-height:1';
  const POP_STYLE = 'position:absolute;z-index:500;min-width:170px;max-height:320px;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);padding:5px;display:flex;flex-direction:column;gap:2px';
  const OPT_STYLE = 'text-align:left;background:transparent;border:0;color:#e6edf3;font:inherit;font-size:12px;padding:6px 9px;border-radius:5px;cursor:pointer';
  function buildColumnFilters() {
    $$('#edit-tbl thead th').forEach((th, i) => {
      const f = COLF[i]; if (!f || i === 0 || th.querySelector('.cfb')) return;
      th.insertAdjacentHTML('beforeend', `<button type="button" class="cfb" data-cfb="${f.k}" title="Filter this column" aria-label="Filter" style="${CFB_STYLE}">${FUNNEL}</button>`);
    });
    if (!$('#cf-pop')) document.body.insertAdjacentHTML('beforeend', `<div id="cf-pop" class="cf-pop" hidden style="${POP_STYLE};display:none"></div>`);
  }
  let cfOpen = null;
  function openColumnFilter(btn) {
    const k = btn.dataset.cfb; const f = COLF.find((x) => x.k === k); const pop = $('#cf-pop');
    if (cfOpen === k && !pop.hidden) { closePop(); return; }
    cfOpen = k;
    const cur = state.cf[k] || '';
    const item = (v, label) => `<button type="button" class="cf-opt ${cur === v ? 'on' : ''}" data-cfv="${esc(v)}" style="${OPT_STYLE}${cur === v ? ';color:#73d700;font-weight:600' : ''}">${cur === v ? '✓ ' : ''}${esc(label)}</button>`;
    let html = item('', 'All');
    if (f.text) {
      html += `<input class="ipt cf-text" placeholder="${esc(f.text)}…" value="${esc(cur.startsWith('__') ? '' : cur)}" style="font-size:12px;padding:6px 8px;margin:3px 0;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px">`;
      if (k === 'lines') html += item('__mismatch', 'MinG mismatch') + item('__none', 'No lines');
    } else html += f.opts().map((o) => item(o, o)).join('');
    pop.innerHTML = html; pop.hidden = false; pop.style.display = 'flex';
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.min(r.left + window.scrollX - 8, window.scrollX + document.documentElement.clientWidth - 200) + 'px';
    const t = $('.cf-text', pop); if (t) t.focus();
  }
  function closePop() { const pop = $('#cf-pop'); if (pop) { pop.hidden = true; pop.style.display = 'none'; } cfOpen = null; }
  function renderColumnFilterState() {
    const n = Object.values(state.cf).filter(Boolean).length;
    const b = $('#btn-clear-cf'); if (b) { b.hidden = !n; b.textContent = `✕ Clear ${n} filter${n === 1 ? '' : 's'}`; }
    $$('#edit-tbl .cfb').forEach((el) => {
      const on = !!state.cf[el.dataset.cfb]; el.classList.toggle('on', on);
      el.style.color = on ? '#73d700' : '#8b949e'; el.style.background = on ? 'rgba(115,215,0,.15)' : 'transparent'; el.style.borderColor = on ? 'rgba(115,215,0,.6)' : 'transparent';
      el.title = on ? 'Filtered: ' + state.cf[el.dataset.cfb].replace(/^__mismatch$/, 'MinG mismatch').replace(/^__none$/, 'No lines') + ' (click to change)' : 'Filter this column';
    });
  }

  function matches(c, opts) {
    const f = state.f; opts = opts || {};
    if (!colMatch(c)) return false;
    if (state.scope && c.region !== state.scope) return false;
    if (!opts.ignoreStage && f.stage && c.stage !== f.stage) return false;
    if (f.region && regionOf(c) !== f.region) return false;
    if (!opts.ignoreStage && f.group && !GROUPS[f.group].test(c)) return false;
    if (f.attn && !C.flags(c).some((x) => x.level >= 2)) return false;
    if (f.q) {
      const hay = [c.bpName, (c.aliases || []).join(' '), c.owner, c.comments, c.stage, c.lines.map((l) => l.code + ' ' + (l.route || '')).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }
  function sorted(list) {
    const { key, asc } = state.sort;
    const val = (c) => {
      if (key === 'stage') return c.stage === C.REJECTED ? -1 : C.STAGES.indexOf(c.stage);
      if (key === 'annualMileage') return c.annualMileage || 0;
      if (key === 'weekKm') return weekKm(c) || 0;
      if (key === 'rtAmt') return C.totals(c).rtAmt;
      return String(c[key] || '').toLowerCase();
    };
    return list.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      const r = x < y ? -1 : x > y ? 1 : a.bpName.localeCompare(b.bpName);
      return asc ? r : -r;
    });
  }

  function stagePill(s) {
    const cls = s === 'Signed' ? 'sp-s' : s === C.REJECTED ? 'sp-r' : s === C.STAGES[0] ? 'sp-b' : s === 'Peer approval' ? 'sp-u' : 'sp-p';
    return `<span class="sp ${cls}">${esc(s)}</span>`;
  }

  // ---------- Dashboard tab ----------
  function renderKpis() {
    const L = inScope();
    const signed = L.filter((c) => c.stage === 'Signed');
    const kpi = (ac, label, value, sub, group) => `<div class="kpi" style="--ac:${ac}"><div class="kl">${label}</div><div class="kv">${group ? `<button class="cell-link" data-goto-region="" data-group="${group}">${value}</button>` : value}</div><div class="ks">${sub}</div></div>`;
    const signedIn = (r) => L.filter((c) => c.stage === 'Signed' && c.region === r).length;
    const ofRegion = (r) => L.filter((c) => c.region === r).length;
    const cards = [kpi('var(--g)', state.scope ? `Signed – ${regionName(state.scope)}` : 'Contracts signed – N/W + South', signed.length + `<span>of ${L.length} BPs</span>`, `${L.length ? Math.round((signed.length / L.length) * 100) : 0}% signed`, 'Signed')];
    if (!state.scope) C.OPTIONS.region.forEach((r) => cards.push(kpi(r === 'South' ? 'var(--pu)' : 'var(--bl)', `Signed – ${regionName(r)}`,
      `<button class="cell-link" data-goto-region="${esc(r)}" data-group="Signed">${signedIn(r)}</button><span>of ${ofRegion(r)} BPs</span>`, `${ofRegion(r) ? Math.round((signedIn(r) / ofRegion(r)) * 100) : 0}% signed`)));
    // Annual KMs from the Vehicles Annex (Art. 2.1)
    const withKm = L.filter((c) => c.annualMileage);
    const km = withKm.reduce((a, c) => a + c.annualMileage, 0);
    cards.push(kpi('var(--am)', 'Annual KMs – Vehicles Annex', `${km >= 1e7 ? fmt(km / 1e7, 2) + '<span>Cr km</span>' : km >= 1e5 ? fmt(km / 1e5, 1) + '<span>L km</span>' : fmt(km, 0) + '<span>km</span>'}`, `${withKm.length} of ${L.length} BPs have the figure`));
    // Weekly discrepancies (contract MinG vs paid)
    const d = discrepancies();
    cards.push(kpi('var(--rd)', 'Weekly discrepancies', `<button class="cell-link" data-goto-disc>${d.rows.length}</button><span>line${d.rows.length === 1 ? '' : 's'} · ${d.bps} BP${d.bps === 1 ? '' : 's'}</span>`, d.period ? 'Revenue report ' + esc(d.period) : 'No revenue report yet'));
    $('#kpis').innerHTML = cards.join('');
  }

  // Lines where the paid ₹/km (latest Revenue Share Report) differs from the contract MinG, or a paid line not in the contract
  function discrepancies() {
    const rows = []; const periods = {}; const noAnnex = [];
    inScope().forEach((c) => {
      const m = C.mingCheck(c);
      if (m.status === 'no-report') return;
      periods[m.period] = (periods[m.period] || 0) + 1;
      // No Lines Annex in the tracker yet: nothing to compare against, so list the BP separately
      if (!c.lines.length) { if (m.extra.length) noAnnex.push({ c, n: m.extra.length }); return; }
      m.items.filter((i) => i.status === 'mismatch').forEach((i) => rows.push({ c, code: i.code, contract: i.contract, paid: i.paid, diff: i.diff, kind: i.diff > 0 ? 'Paid more than contract' : 'Paid less than contract' }));
      m.extra.forEach((x) => rows.push({ c, code: x.code, contract: null, paid: x.paid, diff: null, kind: 'Paid, but line not in the contract' }));
    });
    rows.sort((a, b) => a.c.bpName.localeCompare(b.c.bpName) || a.code.localeCompare(b.code));
    const period = Object.keys(periods).sort((a, b) => periods[b] - periods[a])[0] || '';
    return { rows, period, bps: new Set(rows.map((r) => r.c.id)).size, noAnnex };
  }
  function renderDiscrepancies() {
    const el = $('#disc-tbl'); if (!el) return;
    const d = discrepancies();
    $('#disc-period').textContent = d.period ? '· ' + d.period : '';
    if (!d.period) { el.innerHTML = '<tbody><tr><td class="empty" style="padding:16px">No Revenue Share Report checked yet.</td></tr></tbody>'; return; }
    const note = d.noAnnex.length ? `<tfoot><tr><td colspan="8" class="muted" style="padding:10px 12px;white-space:normal">Can't check yet, because no Lines Annex is in the tracker: ${d.noAnnex.map((x) => `<button class="cell-link" data-open="${esc(x.c.id)}">${esc(x.c.bpName)}</button> (${x.n} line${x.n === 1 ? '' : 's'} paid)`).join(', ')}. Add their Lines Annex to compare.</td></tr></tfoot>` : '';
    if (!d.rows.length) { el.innerHTML = '<tbody><tr><td class="empty" style="padding:16px">✓ No discrepancies this week: every paid ₹/km matches the contract.</td></tr></tbody>' + note; return; }
    el.innerHTML = `<thead><tr><th>BP</th><th>Region</th><th>Line code</th><th class="num">Contract MinG (₹/km)</th><th class="num">Paid (₹/km)</th><th class="num">Difference</th><th class="num">Annual KMs</th><th>What's wrong</th></tr></thead><tbody>` +
      d.rows.map((r) => `<tr class="row-bad"><td><button class="bp-link" data-open="${esc(r.c.id)}">${esc(r.c.bpName)}</button></td><td>${esc(r.c.region || '—')}</td><td class="mono">${esc(r.code)}</td>
        <td class="num">${r.contract != null ? r.contract.toFixed(2) : '—'}</td><td class="num">${r.paid.toFixed(2)}</td>
        <td class="num ${r.diff != null ? 'days-hot' : 'muted'}">${r.diff != null ? (r.diff > 0 ? '+' : '') + r.diff.toFixed(2) : '—'}</td>
        <td class="num">${r.c.annualMileage ? fmt(r.c.annualMileage, 0) : '<span class="muted">—</span>'}</td>
        <td><span class="sp sp-r">${esc(r.kind)}</span></td></tr>`).join('') + '</tbody>' + note;
  }

  // ---------- North/West vs South ----------
  function regionColumns() {
    const present = new Set(state.contracts.map(regionOf));
    present;
    return state.scope ? [state.scope] : C.OPTIONS.region.slice();
  }
  function regionStats(list) {
    const amt = (l) => l.reduce((a, c) => a + C.totals(c).rtAmt, 0);
    const signed = list.filter((c) => c.stage === 'Signed');
    const pending = list.filter(GROUPS.pending.test);
    const rej = list.filter((c) => c.stage === C.REJECTED);
    return {
      total: list.length, signed: signed.length, pending: pending.length,
      ready: list.filter(GROUPS.ready.test).length, out: list.filter(GROUPS.out.test).length, revised: list.filter(GROUPS.revised.test).length,
      rejected: rej.length,
      lines: list.reduce((a, c) => a + c.lines.length, 0),
      amt: amt(list), amtSigned: amt(signed), amtPending: amt(pending), amtRejected: amt(rej),
      km: list.reduce((a, c) => a + (c.annualMileage || 0), 0),
    };
  }
  // Rows of the comparison table: [label, key, group to open when clicked, is it a sub-row, is it money]
  const REG_ROWS = [
    ['BPs', 'total', '', 0],
    ['Signed', 'signed', 'Signed', 0],
    ['Out for signing', 'out', 'out', 0],
    ['of which: revised contract after a rejection', 'revised', 'revised', 1],
    ['Ready to send for signing', 'ready', 'ready', 0],
    ['Rejected, waiting on a revised contract', 'rejected', 'Rejected', 0],
    ['Total RT amount', 'amt', '', 0, 1],
    ['Signed RT amount', 'amtSigned', 'Signed', 1, 1],
    ['Annual KMs (Vehicles Annex)', 'km', '', 0, 2],
  ];
  function renderRegionCompare() {
    const cols = regionColumns();
    const stats = cols.map((r) => regionStats(state.contracts.filter((c) => regionOf(c) === r)));
    const all = regionStats(state.contracts.filter((c) => c.region));
    const cell = (r, row, s) => {
      const v = s[row[1]];
      const shown = row[4] === 2 ? (v ? fmt(v, 0) + ' km' : '—') : row[4] ? (v ? inr(v) : '—') : v;
      if (!row[2] || !v) return `<td class="num">${shown}</td>`;
      return `<td class="num"><button class="cell-link" data-goto-region="${esc(r)}" data-group="${esc(row[2])}">${shown}</button></td>`;
    };
    const showTotal = !state.scope;
    $('#reg-title').textContent = state.scope ? regionName(state.scope) : 'North/West vs South';
    $('#reg-tbl').innerHTML = `<thead><tr><th></th>${cols.map((r) => `<th class="num">${esc(regionName(r))}</th>`).join('')}${showTotal ? '<th class="num">Total</th>' : ''}</tr></thead><tbody>` +
      REG_ROWS.map((row) => `<tr class="${row[3] ? 'sub-row sub' + row[3] : 'main-row'}${row[1] === 'amt' ? ' money-row' : ''}"><td>${esc(row[0])}</td>` +
        cols.map((r, i) => cell(r, row, stats[i])).join('') + (showTotal ? cell('', row, all) : '') + '</tr>').join('') + '</tbody>';
    const none = state.scope ? [] : state.contracts.filter((c) => !c.region);
    $('#reg-note').hidden = !none.length;
    $('#reg-note').innerHTML = none.length ? `<span>Not counted above because no region is set yet: ${none.map((c) => `<button class="cell-link" data-open="${esc(c.id)}">${esc(c.bpName)}</button>`).join(', ')}. Pick N/W or South in Contracts.</span>` : '';
  }
  function exportRegionCsv() {
    const cols = regionColumns();
    const stats = cols.map((r) => regionStats(state.contracts.filter((c) => regionOf(c) === r)));
    const all = regionStats(state.contracts.filter((c) => c.region));
    const lines = [[''].concat(cols.map(regionName), ['Total'])].concat(REG_ROWS.map((row) =>
      [(row[3] ? '  '.repeat(row[3]) : '') + row[0] + (row[4] ? ' (₹)' : '')].concat(stats.map((s) => s[row[1]]), [all[row[1]]])));
    const csv = lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `bp-contracts-by-region-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); toast('Exported region comparison');
  }

  // ---------- Lines & MinG ----------
  const mingBad = (c, code) => { const m = C.mingCheck(c); return m.items.some((i) => i.code === code && i.status === 'mismatch'); };
  state.lf = { q: '', bad: false };
  function lineRowsData() {
    const out = [];
    inScope().slice().sort((a, b) => a.bpName.localeCompare(b.bpName)).forEach((c) => {
      const m = C.mingCheck(c);
      const rows = c.lines.map((l) => {
        const it = m.items.find((i) => i.code === l.code) || {};
        return { c, l, paid: it.paid ?? null, status: m.status === 'no-report' ? 'no-report' : it.status };
      }).concat(m.extra.map((x) => ({ c, l: { code: x.code, route: '', rtKms: null, minG: null, rtAmt: null }, paid: x.paid, status: c.lines.length ? 'extra' : 'paid-no-annex' })));
      if (!rows.length) rows.push({ c, l: null, status: 'no-lines' });
      rows.forEach((r) => out.push(r));
    });
    const q = state.lf.q.toLowerCase();
    return out.filter((r) => (!q || (r.c.bpName + ' ' + (r.l ? r.l.code + ' ' + (r.l.route || '') : '')).toLowerCase().includes(q))
      && (!state.lf.bad || r.status === 'mismatch' || r.status === 'extra'));
  }
  const CHECK = {
    ok: '<span class="sp sp-s">✓ Matches</span>', mismatch: '<span class="sp sp-r">✕ Mismatch</span>', extra: '<span class="sp sp-r">✕ Not in contract</span>',
    'not-in-report': '<span class="sp" style="color:var(--mt);border-color:var(--br2)">Not in report</span>', 'no-report': '<span class="muted">No report yet</span>', 'no-lines': '<span class="muted">Lines Annex needed</span>', 'paid-no-annex': '<span class="sp sp-p">Paid, Lines Annex needed</span>',
  };
  function renderLinesTab() {
    const el = $('#lines-rows'); if (!el) return;
    const rows = lineRowsData();
    let lastBp = null;
    el.innerHTML = rows.map((r, i) => {
      const first = r.c.id !== lastBp; lastBp = r.c.id;
      const span = first ? rows.filter((x) => x.c.id === r.c.id).length : 0;
      const l = r.l;
      const diff = r.paid != null && l && l.minG != null ? r.paid - l.minG : null;
      return `<tr class="${first ? 'bp-start' : ''} ${r.status === 'mismatch' || r.status === 'extra' ? 'row-bad' : ''}">
        ${first ? `<td rowspan="${span}" class="bp-cell"><button class="bp-link" data-open="${esc(r.c.id)}">${esc(r.c.bpName)}</button><span class="sub">${esc(r.c.region || '')}, ${esc(r.c.stage)}</span></td>
          <td rowspan="${span}" class="num bp-cell">${r.c.annualMileage ? fmt(r.c.annualMileage, 0) : '<span class="muted">Vehicles Annex needed</span>'}</td>` : ''}
        <td class="mono">${l ? esc(l.code) : '—'}</td><td class="wrap">${l ? esc(l.route || '') : ''}</td>
        <td class="num">${l && l.rtKms != null ? fmt(l.rtKms) : '—'}</td>
        <td class="num">${l && l.minG != null ? l.minG.toFixed(2) : '—'}</td>
        <td class="num">${l && l.rtAmt != null ? fmt(l.rtAmt) : '—'}</td>
        <td class="num ${diff ? 'days-hot' : ''}">${r.paid != null ? r.paid.toFixed(2) + (diff ? ` <small>(${diff > 0 ? '+' : ''}${diff.toFixed(2)})</small>` : '') : '—'}</td>
        <td class="c">${CHECK[r.status] || ''}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="empty" style="padding:16px">No lines match.</td></tr>';
    const all = inScope(); let bad = 0, checked = 0;
    all.forEach((c) => { const m = C.mingCheck(c); if (m.status !== 'no-report' && c.lines.length) { checked++; if (m.status === 'mismatch') bad++; } });
    const period = (all.find((c) => c.revenueReport) || {}).revenueReport;
    $('#ming-summary').innerHTML = period ? `Revenue Share Report <b>${esc(period.period)}</b>: ${checked} BPs checked, <b>${bad}</b> with a MinG discrepancy.` : 'No revenue share report checked yet.';
    const cnt = $('#ming-count'); cnt.textContent = bad; cnt.hidden = !bad;
    $('#l-bad').classList.toggle('active', state.lf.bad);
  }
  function exportLinesCsv() {
    const head = ['BP', 'Region', 'Stage', 'Annual mileage (km)', 'Line code', 'Route', 'RT kms', 'MinG (₹/km)', 'RT amount (₹)', 'Revenue report MinG', 'Check'];
    const rows = lineRowsData().map((r) => [r.c.bpName, r.c.region, r.c.stage, r.c.annualMileage ?? '', r.l ? r.l.code : '', r.l ? r.l.route || '' : '', r.l ? r.l.rtKms ?? '' : '', r.l ? r.l.minG ?? '' : '', r.l ? r.l.rtAmt ?? '' : '', r.paid ?? '', r.status]);
    const csv = [head].concat(rows).map((x) => x.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `bp-lines-ming-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); toast('Exported lines & MinG');
  }

  // ---------- Region filter (N/W + South / N/W / South) ----------
  function renderScope() {
    $$('[data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.scope));
    document.title = 'Flix India – BP Contract Tracker' + (state.scope ? ' – ' + regionName(state.scope) : '');
  }
  function setScope(v) {
    state.scope = v; state.f.region = '';
    renderAll();
  }

  function renderRoute() {
    $('#route').innerHTML = C.ALL_STAGES.map((s) => {
      const inStage = state.contracts.filter((c) => c.stage === s);
      const names = inStage.map((c) => c.bpName).sort();
      const shown = names.slice(0, 4).map(esc).join('<br>') + (names.length > 4 ? `<br>and ${names.length - 4} more` : '');
      const cls = ['stop', s === C.REJECTED ? 'rejected' : '', s === 'Signed' ? 'signed' : '', inStage.length ? '' : 'is-empty'].join(' ');
      return `<button class="${cls}" data-goto-stage="${esc(s)}">
        <span class="stop-count">${inStage.length}</span>
        <span class="stop-track"><span class="stop-dot"></span></span>
        <span class="stop-name">${esc(s)}</span>
        <span class="stop-bps">${shown || (s === C.REJECTED ? 'None' : '&nbsp;')}</span></button>`;
    }).join('');
  }

  function renderStageTable() {
    let tot = { n: 0, lines: 0, amt: 0 };
    const rows = C.ALL_STAGES.map((s) => {
      const list = state.contracts.filter((c) => c.stage === s);
      const lines = list.reduce((n, c) => n + c.lines.length, 0);
      const amt = list.reduce((n, c) => n + C.totals(c).rtAmt, 0);
      const wait = list.length && s !== 'Signed' ? Math.max.apply(null, list.map((c) => C.daysInStage(c))) : null;
      tot = { n: tot.n + list.length, lines: tot.lines + lines, amt: tot.amt + amt };
      return `<tr><td>${stagePill(s)}</td><td class="num">${list.length}</td><td class="num">${lines}</td><td class="num">${amt ? inr(amt) : '—'}</td>
        <td class="num ${wait > C.STALE_DAYS ? 'days-hot' : ''}">${wait === null ? '—' : wait}</td></tr>`;
    }).join('');
    $('#stage-tbl').innerHTML = `<thead><tr><th>Stage</th><th class="num">BPs</th><th class="num">Lines</th><th class="num">RT amount</th><th class="num">Longest wait (days)</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Total</td><td class="num">${tot.n}</td><td class="num">${tot.lines}</td><td class="num">${inr(tot.amt)}</td><td></td></tr></tfoot>`;
  }

  function bar(label, right, pct, color) {
    return `<div class="brow"><div class="brt"><span>${esc(label)}</span><b>${right}</b></div><div class="trk"><div class="fil" style="width:${Math.round(pct)}%;background:${color || 'var(--g)'}"></div></div></div>`;
  }

  function renderSideCards() {
    const L = state.contracts; const n = L.length || 1;
    const items = C.checklist(C.blankContract()).map((x) => x.label);
    $('#checklist-bars').innerHTML = items.map((label, i) => {
      const done = L.filter((c) => C.checklist(c)[i].ok).length;
      const pct = (done / n) * 100;
      return bar(label, `${done} / ${L.length}`, pct, pct >= 80 ? 'var(--g)' : pct >= 50 ? 'var(--am)' : 'var(--rd)');
    }).join('');

    const all = []; L.forEach((c) => (c.rejections || []).forEach((r) => all.push(r)));
    if (!all.length) {
      $('#rej-bars').innerHTML = '<p class="empty">No rejections logged yet. When a BP rejects a contract, set its stage to “Rejected” and pick a reason. It shows up here.</p>';
    } else {
      const by = {}; all.forEach((r) => { by[r.category] = (by[r.category] || 0) + 1; });
      const max = Math.max.apply(null, Object.values(by));
      $('#rej-bars').innerHTML = `<p class="empty">${all.length} rejections so far. A revised contract went out for ${all.filter((r) => r.resentAt).length} of them.</p><div class="bbs">` +
        Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => bar(k, v, (v / max) * 100, 'var(--rd)')).join('') + '</div>';
    }

    const reg = {};
    L.forEach((c) => { const k = c.region || 'No region set'; reg[k] = reg[k] || { n: 0, s: 0 }; reg[k].n++; if (c.stage === 'Signed') reg[k].s++; });
    $('#region-bars').innerHTML = Object.entries(reg).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => bar(k, `${v.s} of ${v.n} signed`, (v.s / v.n) * 100)).join('');
  }

  // ---------- Contracts tab (inline editing) ----------
  function renderStageFilters() {
    const base = state.contracts.filter((c) => matches(c, { ignoreStage: true }));
    const pill = (val, label, n, extra) => `<button class="fb ${extra || ''} ${state.f.stage === val ? 'active' : ''}" data-filter-stage="${esc(val)}">${esc(label)}<b>${n}</b></button>`;
    const groupPill = state.f.group ? `<button class="fb active" data-filter-stage="">${esc(GROUPS[state.f.group].label)} ✕</button>` : '';
    $('#f-region').value = state.f.region;
    $('#stage-filters').innerHTML = groupPill + pill('', 'All', base.length).replace('fb  active', state.f.group ? 'fb ' : 'fb  active') +
      C.ALL_STAGES.map((s) => pill(s, s, base.filter((c) => c.stage === s).length, s === C.REJECTED ? 'red' : '')).join('') +
      `<button class="fb red ${state.f.attn ? 'active' : ''}" id="f-attn">⚠ Needs attention</button>`;
  }

  function yn(c, k) {
    const v = !!c[k];
    return `<button class="yn ${v ? 'on' : 'off'}" data-toggle="${k}" data-id="${esc(c.id)}" ${state.me.canEdit ? '' : 'disabled'} aria-pressed="${v}">${v ? 'Yes' : 'No'}</button>`;
  }
  function sel(c, k, list, cls) {
    return `<select class="sel ${cls || ''}" data-field="${k}" data-id="${esc(c.id)}" ${state.me.canEdit ? '' : 'disabled'}>${list.map((o) => `<option value="${esc(o)}"${o === c[k] ? ' selected' : ''}>${esc(o || '—')}</option>`).join('')}</select>`;
  }

  function stageCell(c) {
    if (c.stage === C.REJECTED) {
      const r = C.latestRejection(c) || {};
      return `<span class="sp sp-r" title="${esc(r.category + (r.reason ? ': ' + r.reason : ''))}">Rejected: ${esc(r.category || '')}</span>` +
        (state.me.canEdit ? `<button class="rs-btn" data-resend="${esc(c.id)}">↻ Send revised</button>` : '');
    }
    const cls = c.stage === 'Signed' ? 'st-signed' : c.stage === C.STAGES[0] ? 'st-start' : 'st-wait';
    return sel(c, 'stage', C.ALL_STAGES, cls);
  }

  function renderRows() {
    const list = sorted(state.contracts.filter((c) => matches(c)));
    const ro = !state.me.canEdit;
    $('#rows').innerHTML = list.map((c) => {
      const t = C.totals(c);
      return `<tr>
        <td><button class="bp-link" data-open="${esc(c.id)}">${esc(c.bpName)}</button><span class="sub">${esc(c.owner || '')}</span></td>
        <td>${sel(c, 'region', c.region ? C.OPTIONS.region : [''].concat(C.OPTIONS.region), c.region ? '' : 'st-none')}</td>
        <td>${stageCell(c)}</td>
        <td class="c">${docBadge(c)}</td>
        <td class="c">${rcmBadge(c)}</td>
        <td class="c">${yn(c, 'docsReceived')}</td>
        <td class="c">${yn(c, 'sfAccountCreated')}</td>
        <td>${sel(c, 'bankDetails', C.OPTIONS.bankDetails)}</td>
        <td class="c">${yn(c, 'onboardingForm')}</td>
        <td>${sel(c, 'docsPending', C.OPTIONS.docsPending)}</td>
        <td class="codes">${c.lines.length ? c.lines.map((l) => `<span class="code-chip ${mingBad(c, l.code) ? 'bad' : ''}" title="${esc((l.route || '') + (l.minG != null ? ' · MinG ₹' + l.minG.toFixed(2) + '/km' : ''))}">${esc(l.code || '?')}</span>`).join('') : '<span class="muted">—</span>'}</td>
        <td class="num">${t.rtAmt ? inr(t.rtAmt) : '<span class="muted">—</span>'}</td>
        <td class="num">${c.annualMileage ? fmt(c.annualMileage, 0) : '<span class="muted">—</span>'}</td>
        <td class="num" title="${esc(c.revenueReport && c.revenueReport.period ? 'Revenue Share Report ' + c.revenueReport.period : '')}">${weekKm(c) ? fmt(weekKm(c), 2) : '<span class="muted">—</span>'}</td>
        <td><input class="ipt ipt-note" data-note="${esc(c.id)}" value="${esc(c.comments)}" ${ro ? 'disabled' : ''} placeholder="Add a note…"></td>
      </tr>`;
    }).join('') || `<tr><td colspan="15" class="empty" style="padding:18px">${state.contracts.length ? 'No BPs match these filters. Clear the search or pick another stage.' : 'No contracts yet. Click “＋ Add contract” to add the first one from Salesforce.'}</td></tr>`;
    $('#row-count').textContent = `${list.length} of ${inScope().length} BPs${state.scope ? ' in ' + regionName(state.scope) : ''}`;
    $$('#edit-tbl th[data-sort]').forEach((th) => {
      const on = th.dataset.sort === state.sort.key;
      th.style.color = on ? 'var(--g)' : '';
      th.dataset.dir = on ? (state.sort.asc ? '▲' : '▼') : '';
    });
  }

  async function saveField(id, field, value) {
    const c = byId(id); if (!c) return;
    try {
      const next = await api.update(c, { [field]: value });
      upsert(next); state.syncedAt = new Date(); renderAll(); toast(`${c.bpName}: ${C.FIELDS[field]} saved`);
    } catch (e) { fail(e); }
  }

  // ---------- Needs attention tab ----------
  function renderAttention() {
    const items = [];
    inScope().forEach((c) => C.flags(c).forEach((f) => items.push({ c, f })));
    items.sort((a, b) => b.f.level - a.f.level || a.c.bpName.localeCompare(b.c.bpName));
    $('#attn-count').textContent = items.filter((x) => x.f.level >= 2).length;
    $('#attention').innerHTML = items.length
      ? items.map(({ c, f }) => `<li><button class="l${f.level}" data-open="${esc(c.id)}"><b>${esc(c.bpName)}</b><span>${esc(f.text)}</span></button></li>`).join('')
      : '<li class="empty">Nothing is blocked. Every contract is moving.</li>';
    const rej = inScope().filter((c) => c.stage === C.REJECTED);
    $('#rej-waiting').innerHTML = rej.length
      ? '<ul class="att">' + rej.map((c) => { const r = C.latestRejection(c); return `<li><button class="l3" data-open="${esc(c.id)}"><b>${esc(c.bpName)}</b><span>${esc(r.category)}, ${C.daysInStage(c) ? C.daysInStage(c) + " days ago" : "today"}</span></button></li>`; }).join('') + '</ul>'
      : '<p class="empty">No contracts are waiting on a revised version.</p>';
  }

  function renderHeader() {
    $('#who').textContent = state.me.canEdit ? `${state.me.name || 'Signed in'} · Editor` : `${state.me.name} · View only`;
    const live = $('#live-badge');
    const isLive = !state.demo || state.mode === 'github';
    live.className = isLive ? 'bdg bdg-g' : 'bdg bdg-a';
    live.innerHTML = `<span class="dot"></span>${isLive ? 'Live' : 'Preview'}`;
    $('#last-upd').textContent = state.syncedAt ? 'Synced ' + state.syncedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
    $$('[data-edit]').forEach((el) => { el.hidden = !state.me.canEdit; });
    $('#btn-signin-hdr').hidden = !(state.mode === 'github' && !state.me.canEdit);
  }

  function renderAll() {
    state.contracts.forEach(C.withDocDefaults);
    renderHeader(); renderScope(); renderKpis(); renderRegionCompare(); renderDiscrepancies(); renderLinesTab();
    renderStageFilters(); renderRows(); renderAttention();
    if (state.openId) renderDrawer();
  }

  // ---------- Contract documents checklist (6 documents; existing BPs only need Lines + Vehicles Annex) ----------
  const DOC_ICON = { signed: '✓', surya: '◐', sent: '⏳', pending: '⏳', copy: '⚠', missing: '✗' };
  function docList(c, editable) {
    const dc = C.docCheck(c);
    const opts = ['missing', 'copy', 'pending', 'signed'];
    return `<ul class="doclist">${dc.rows.map((r) => {
      const cls = !dc.type ? 'unk' : !r.required ? 'nn' : r.status === 'signed' ? 'ok' : r.status === 'missing' ? 'bad' : 'warn';
      const right = editable
        ? `<select class="sel sm" data-doc="${r.key}">${opts.map((o) => `<option value="${o}"${o === r.status ? ' selected' : ''}>${esc(C.DOC_STATUS[o])}</option>`).join('')}</select>`
        : `<span>${esc(C.DOC_STATUS[r.status])}</span>`;
      return `<li class="${cls}"><b>${dc.type && !r.required && r.status === 'missing' ? '–' : DOC_ICON[r.status]}</b><span class="dl">${esc(r.label)}${dc.type && !r.required ? ' <i>not needed (existing BP)</i>' : ''}</span>${right}</li>`;
    }).join('')}</ul>`;
  }
  function rcmBadge(c) {
    if (c.rcm === 'yes') return `<span class="dbadge ok" title="RCM clause in Commercial Annex Art. ${esc(c.rcmClause || '8.12.7')} (GST Charge Mechanism)">Yes</span>`;
    if (c.rcm === 'no') return '<span class="dbadge bad" title="No RCM clause in the Commercial Annex (older template: tax clauses stop at 8.12.5)">No</span>';
    return '<span class="dbadge unk" title="Commercial Annex not checked yet: attach it to the BP">—</span>';
  }
  function docBadge(c) {
    const dc = C.docCheck(c);
    if (!dc.type) return '<span class="dbadge unk" title="Tick “Existing BP” or mark as new BP">?</span>';
    const ok = dc.done === dc.total;
    const tip = ok ? 'All required documents signed' : [].concat(dc.missing.map((r) => 'Missing: ' + r.label), dc.notSigned.map((r) => 'Not signed: ' + r.label)).join('\n');
    return `<span class="dbadge ${ok ? 'ok' : dc.missing.length ? 'bad' : 'warn'}" title="${esc(tip)}">${dc.done}/${dc.total}</span>`;
  }

  // ---------- Lines editor (used in drawer and in Add contract) ----------
  const COLS = [['rtKms', 'RT kms'], ['minG', 'MinG (₹/km)'], ['rtAmt', 'RT amount (₹)']];
  function linesTable(lines, scope, ro, opt) {
    opt = opt || {};
    const dis = ro ? 'disabled' : '';
    const notes = opt.notes || {};
    const body = lines.map((l, i) => { const pdfCls = opt.pdf && l.source === 'pdf' ? 'pdf' : ''; const n = notes[l.code]; return `<tr data-row="${i}">
      <td><input class="ipt ${pdfCls}" data-k="code" value="${esc(l.code || '')}" ${dis} placeholder="IN0121C" aria-label="Line code">${l.route ? `<span class="sub">${esc(l.route)}${opt.pdf ? '' : l.source === 'contract' ? ' · from signed contract' : l.source === 'pdf' ? ' · from contract PDF' : ''}</span>` : ''}</td>
      ${COLS.map(([k, label]) => `<td><input class="ipt num ${l.calc === k ? 'auto' : pdfCls}" data-k="${k}" value="${l[k] ?? ''}" ${dis} inputmode="decimal" aria-label="${label}" title="${l.calc === k ? 'Worked out automatically' : ''}">${k === 'minG' && n ? `<span class="calc ${n.cls || ''}">${esc(n.text)}</span>` : ''}</td>`).join('')}
      <td>${ro ? '' : `<button type="button" class="del-btn" data-del-line="${i}" aria-label="Remove line">×</button>`}</td></tr>`; }).join('')
      + (opt.removed || []).map((r) => `<tr class="gone"><td><s>${esc(r.code)}</s><span class="sub">${esc(r.route || '')}${r.by ? ' · replaced by ' + esc(r.by) : ''}</span></td>
        <td class="num"><s>${r.rtKms ?? ''}</s></td><td class="num"><s>${r.minG ?? ''}</s></td><td class="num"><s>${r.rtAmt ?? ''}</s></td><td><span class="sp sp-r gone-tag">Removed</span></td></tr>`).join('');
    return `<div class="tw"><table class="dt lines" data-lines="${scope}">
      <thead><tr><th>Line code</th>${COLS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th></th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="empty">No lines yet.</td></tr>'}</tbody>
      <tfoot><tr>${lineTotals(lines)}</tr></tfoot></table></div>
      <p class="sn" style="margin-top:6px"><span>Fill in any two of RT kms, MinG and RT amount and the third is worked out. <span style="color:var(--g)">Green dashed</span> = worked out.</span></p>`;
  }
  function lineTotals(lines) {
    const n = lines.map(C.normaliseLine);
    const amt = n.reduce((a, l) => a + (l.rtAmt || 0), 0);
    const kms = n.reduce((a, l) => a + (l.rtAmt !== null ? l.rtKms || 0 : 0), 0);
    return `<td>${n.length} lines</td><td class="num">${fmt(n.reduce((a, l) => a + (l.rtKms || 0), 0))}</td><td class="num">${kms ? fmt(amt / kms) + ' avg' : '—'}</td><td class="num">${inr(amt)}</td><td></td>`;
  }
  // Update a line while typing without re-drawing (so the cursor stays put).
  function onLineInput(lines, input) {
    const tr = input.closest('tr[data-row]'); if (!tr) return;
    const i = Number(tr.dataset.row); const k = input.dataset.k;
    if (k === 'code') { lines[i].code = input.value; return; }
    lines[i] = C.editLine(lines[i], k, input.value);
    COLS.forEach(([key]) => {
      const el = $(`[data-k="${key}"]`, tr);
      if (el !== input) el.value = lines[i][key] ?? '';
      el.classList.toggle('auto', lines[i].calc === key);
      el.title = lines[i].calc === key ? 'Worked out automatically' : '';
    });
    input.classList.remove('auto');
    $('tfoot tr', tr.closest('table')).innerHTML = lineTotals(lines);
  }
  const blankLine = () => ({ code: '', rtKms: '', minG: '', rtAmt: '', calc: null });

  // ---------- BP drawer ----------
  function openDrawer(id) {
    const c = byId(id); if (!c) return;
    state.openId = id; state.draft = clone(c);
    $('#drawer').hidden = false; renderDrawer();
    $('#d-body .x-btn').focus();
  }
  function closeDrawer() {
    if (isDirty() && !confirm('You have changes that are not saved. Close anyway?')) return;
    state.openId = null; state.draft = null; $('#drawer').hidden = true;
  }
  const normalised = (k, v) => (k === 'lines' ? v.map(C.normaliseLine).filter((l) => l.code || l.rtAmt !== null || l.rtKms !== null) : v);
  function changes() {
    const c = byId(state.openId); const out = {};
    if (!c || !state.draft) return out;
    ['bpName', 'owner', 'stage', 'comments', 'lines', 'annualMileage', 'bpType', 'docs', 'rcm'].forEach((k) => {
      let v = normalised(k, state.draft[k]);
      if (k === 'annualMileage') v = v === '' || v == null ? null : Number(String(v).replace(/[,\s]/g, '')) || null;
      if (JSON.stringify(v) !== JSON.stringify(c[k])) out[k] = v;
    });
    return out;
  }
  const isDirty = () => Object.keys(changes()).length > 0;

  function renderDrawer() {
    const c = byId(state.openId); const d = state.draft;
    if (!c || !d) return;
    const ro = !state.me.canEdit; const dis = ro ? 'disabled' : '';
    const rej = C.latestRejection(c);
    const idx = C.STAGES.indexOf(d.stage);
    const route = `<div class="mini-route" role="group" aria-label="Contract stage">${C.STAGES.map((s, i) =>
      `<button type="button" data-set-stage="${esc(s)}" class="${i < idx ? 'done' : ''} ${s === d.stage ? 'here' : ''}" ${ro || c.stage === C.REJECTED ? 'disabled' : ''}>${esc(s)}</button>`).join('')}</div>`;
    let callout = '';
    if (c.stage === C.REJECTED && rej) {
      callout = `<div class="callout red"><h3>Rejected at “${esc(rej.fromStage)}”</h3>
        <div class="row"><p><b>${esc(rej.category)}</b>${rej.reason ? ': ' + esc(rej.reason) : ''}<br><span class="muted">Logged by ${esc(rej.by)}, ${when(rej.at)}. Revised contract not sent yet.</span></p>
        ${ro ? '' : `<button class="svb" data-resend="${esc(c.id)}">↻ Send revised contract for signing</button>`}</div></div>`;
    } else if (rej && rej.resentAt) {
      callout = `<div class="callout green"><h3>Revised contract sent for signing</h3><p class="muted">Sent by ${esc(rej.resentBy)}, ${when(rej.resentAt)}, after a rejection for “${esc(rej.category)}”.</p></div>`;
    }
    const flags = C.flags(c).map((f) => `<span class="sp ${f.level >= 3 ? 'sp-r' : f.level === 2 ? 'sp-p' : 'sp-b'}">${esc(f.text)}</span>`).join(' ');

    $('#d-body').innerHTML = `
      <div class="dh"><div><h2 id="d-title">${esc(c.bpName)}</h2>
        <div class="meta">${stagePill(c.stage)}<span class="sp sp-b">${esc(c.region || 'No region')}</span></div></div>
        <button class="x-btn" data-close aria-label="Close">×</button></div>
      ${flags ? `<div>${flags}</div>` : ''}
      <div class="card"><div class="ct"><span>Stage</span>${!ro && c.stage !== C.REJECTED ? '<button class="rd-btn" id="btn-reject">✕ Mark as rejected</button>' : ''}</div>${route}</div>
      ${callout}
      ${c.pendingContract ? `<div class="callout amber"><h3>Revised contract out for signing</h3><p class="muted">The signed contract below stays in force. These changes are applied automatically when you upload the signed PDF:</p>
        <ul class="pend">${(c.pendingContract.changes || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      ${c.contract ? `<div class="card"><div class="ct"><span>DocuSign envelope</span>${c.contract.status === 'Sent' ? `<span class="sp sp-p">${c.contract.signedBy && c.contract.signedBy.bp ? 'BP signed, waiting for Surya' : 'Sent, waiting for the BP'}</span>` : c.contract.envelopeId.length > 8 ? '<span class="sp sp-s">Signed in DocuSign</span>' : '<span class="sp sp-p">No DocuSign stamp</span>'}</div>
        <div class="fgrid ro-grid"><div><span class="kl">Documents</span>${esc(c.contract.documents)}</div><div><span class="kl">Effective from</span>${c.contract.effectiveFrom ? esc(new Date(c.contract.effectiveFrom).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) : '—'}</div>
        <div><span class="kl">DocuSign envelope</span><span class="mono">${esc(c.contract.envelopeId)}</span></div>
        ${c.contract.signedBy ? `<div><span class="kl">Signatures</span>BP: ${c.contract.signedBy.bp ? '✓ ' + esc(c.contract.signedBy.bp) : '⏳ not yet'} · Surya: ${c.contract.signedBy.surya ? '✓ ' + esc(c.contract.signedBy.surya) : '⏳ not yet'}</div>` : ''}<div><span class="kl">Source</span>${esc(c.contract.file)}</div></div></div>` : ''}
      <div class="card"><div class="ct"><span>Contract documents</span>${docBadge(d)}</div>
        <label class="chk"><input type="checkbox" data-bptype ${d.bpType === 'existing' ? 'checked' : ''} ${dis}> <b>Existing BP?</b> <span>Moved to a new route: only the Lines Annex and Vehicles Annex need signing.</span></label>
        ${!d.bpType ? `<p class="sn" style="margin:4px 0">Not decided yet. Tick the box for an existing BP, or <button type="button" class="link-btn" data-bpnew ${dis}>mark as a new BP</button> (all 6 documents).</p>` : ''}
        ${docList(d, !ro)}
        <label class="rcm-row">RCM clause in Commercial Annex <select class="sel sm" data-rcm ${dis}>${[['', 'Not checked'], ['yes', 'Yes'], ['no', 'No']].map(([v, l]) => `<option value="${v}"${(d.rcm || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <span class="muted">${d.rcm === 'yes' ? 'Art. ' + esc(d.rcmClause || '8.12.7') + ' GST Charge Mechanism' : d.rcm === 'no' ? 'Older template: tax clauses stop at 8.12.5' : ''}</span></label></div>
      <div class="card"><div class="ct"><span>Lines</span>${ro ? '' : '<button class="add-btn" id="d-add-line">＋ Add line</button>'}</div>
        ${linesTable(d.lines, 'd', ro)}</div>
      <div class="card"><div class="ct"><span>Details</span></div><div class="fgrid">
        <label>BP name<input class="ipt" data-df="bpName" value="${esc(d.bpName)}" ${dis}></label>
        <label>Owner<input class="ipt" data-df="owner" value="${esc(d.owner)}" ${dis} placeholder="Who is handling this BP"></label>
        <label>Annual mileage (km) – Vehicles Annex<input class="ipt" data-df="annualMileage" inputmode="numeric" value="${d.annualMileage ?? ''}" ${dis} placeholder="e.g. 311563"></label>
        <label class="full">Comments<textarea class="ipt" data-df="comments" rows="2" ${dis}>${esc(d.comments)}</textarea></label>
      </div></div>
      <div class="card"><div class="ct"><span>History</span></div>
        <ul class="hist">${c.history.slice().reverse().map((h) => `<li><time>${when(h.at)}, ${esc(h.by)}</time>${esc(h.text)}</li>`).join('')}</ul></div>
      ${ro ? '' : `<div class="savebar"><span id="dirty-note"></span><button class="gh-btn" id="btn-discard">Discard</button><button class="svb" id="btn-save">Save changes</button></div>`}`;
    updateDirty();
  }
  function updateDirty() {
    const b = $('#btn-save'); if (!b) return;
    const dirty = isDirty();
    b.disabled = !dirty; $('#btn-discard').disabled = !dirty;
    const n = $('#dirty-note'); n.textContent = dirty ? '● You have changes that are not saved' : 'Everything is saved'; n.className = dirty ? 'dirty' : '';
  }
  async function saveDraft() {
    const c = byId(state.openId); const ch = changes();
    if (!Object.keys(ch).length) return;
    try { const next = await api.update(c, ch); upsert(next); state.draft = clone(next); state.syncedAt = new Date(); renderAll(); toast('Changes saved'); }
    catch (e) { fail(e); }
  }

  // ---------- Reject / resend ----------
  let rejectFor = null;
  function openReject(id) {
    rejectFor = id; const c = byId(id); const f = $('#form-reject'); f.reset();
    $('[name=category]', f).innerHTML = '<option value="">Choose a reason</option>' + C.OPTIONS.rejectionCategory.map((o) => `<option>${esc(o)}</option>`).join('');
    $('#reject-sub').textContent = `${c.bpName} rejected the contract at “${c.stage}”. This is logged with today's date and your name.`;
    $('#reject-error').textContent = '';
    $('#dlg-reject').showModal(); $('[name=category]', f).focus();
  }
  async function resend(id) {
    if (state.openId === id && isDirty()) await saveDraft();
    try { const next = await api.resend(byId(id)); upsert(next); if (state.openId === id) state.draft = clone(next); renderAll(); toast(`${next.bpName}: revised contract sent for signing`); }
    catch (e) { fail(e); }
  }

  // ---------- Add contract (type it in, or attach the contract PDF to fill it in) ----------
  let newLines = [];
  let pdf = null; // { r: parsed PDF, opts, plan, files }
  const fld = (n) => $('[name=' + n + ']', $('#form-new'));
  function openNew() {
    const f = $('#form-new'); f.reset();
    fld('region').innerHTML = C.OPTIONS.region.map((o) => `<option${o === state.scope ? ' selected' : ''}>${esc(o)}</option>`).join('');
    fld('stage').innerHTML = C.STAGES.map((o) => `<option>${esc(o)}</option>`).join('');
    fld('owner').value = myName();
    newLines = [blankLine()]; clearPdf(); $('#new-error').textContent = '';
    $('#dlg-new').showModal(); fld('bpName').focus();
  }
  const myName = () => (state.me.name && !/preview user|unknown|this browser/i.test(state.me.name) ? state.me.name : '');
  function drawNewLines() {
    const opt = { pdf: !!pdf };
    if (pdf && pdf.plan) {
      const p = pdf.plan; opt.notes = {}; opt.removed = [];
      (p.diff || []).forEach((d) => {
        if (d.type === 'added') opt.notes[d.code] = { text: 'new line', cls: 'new' };
        if (d.type === 'changed') opt.notes[d.code] = { text: d.fields.includes('minG') ? 'was ' + d.from.minG : 'changed: ' + d.fields.map((k) => ({ rtKms: 'km', minG: 'MinG', rtAmt: 'amount' })[k]).join(', '), cls: 'chg' };
        if (d.type === 'replaced') opt.notes[d.code] = { text: 'new · replaces ' + d.replaces, cls: 'new' };
        if (d.type === 'removed' || d.type === 'replaced-old') opt.removed.push(Object.assign({}, d.from, { code: d.code, by: d.by }));
      });
      (p.unchanged || []).forEach((c) => { if (p.kind === 'update') opt.notes[c] = { text: '✓ no change' }; });
      newLines.forEach((l) => {
        if (opt.notes[l.code] || l.source !== 'pdf') return;
        const k = C.normaliseLine(l);
        if (l.calc === 'rtKms') opt.notes[l.code] = { text: 'km worked out: blank in contract', cls: 'chg' };
        else if (k.rtAmt && k.rtKms) { const q = Math.round(k.rtAmt / k.rtKms * 100) / 100; opt.notes[l.code] = q === k.minG ? { text: `✓ ${fmt(k.rtAmt)} ÷ ${fmt(k.rtKms)} = ${k.minG.toFixed(2)}` } : { text: `rate as printed (÷ gives ${q.toFixed(2)})`, cls: 'chg' }; }
      });
    }
    $('#new-lines').innerHTML = linesTable(newLines, 'n', false, opt);
  }
  function formDocs() {
    const existing = $('#new-existing').checked;
    const docs = pdf && pdf.plan ? (pdf.plan.docsAfter || pdf.plan.docMap || {}) : (pdf && pdf.plan && pdf.plan.bp ? pdf.plan.bp.docs : {});
    return { bpType: existing ? 'existing' : 'new', docs: Object.assign({}, docs) };
  }
  function drawDocPreview() {
    const f = formDocs();
    $('#new-docs').innerHTML = `<div class="ct"><span>Contract documents</span>${docBadge(f)}</div>${docList(f, false)}`;
  }
  function setTag(name, on) { const t = $(`[data-tag="${name}"]`); if (t) t.hidden = !on; const el = fld(name); if (el) el.classList.toggle('pdf', !!on); }
  function setWas(name, text) { const w = $(`[data-was="${name}"]`); w.hidden = !text; w.textContent = text ? 'was: ' + text : ''; }
  function clearPdf() {
    pdf = null;
    ['bpName', 'region', 'stage', 'annualMileage'].forEach((n) => setTag(n, false));
    setWas('stage', ''); setWas('annualMileage', '');
    $('#pdf-banner').hidden = true; $('#pdf-banner').innerHTML = '';
    $('#pdf-attach').classList.remove('done'); $('#pdf-ic').textContent = 'PDF';
    $('#pdf-attach-text').innerHTML = '<b>Attach contract PDF (optional)</b>Attach the Lines Annex / Vehicles Annex or the DocuSign PDF and the form fills in by itself. Leave it empty to enter everything by hand. The PDF is read on your computer and not uploaded anywhere.';
    $('#pdf-remove').hidden = true; $('#pdf-pick').textContent = 'Choose PDF';
    $('#btn-new-submit').textContent = 'Add contract';
    $('#new-existing').checked = false;
    drawNewLines(); drawDocPreview();
  }
  async function attachPdfs(files) {
    files = Array.from(files || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    $('#new-error').textContent = '';
    if (!files.length) { $('#new-error').textContent = 'Pick a PDF file.'; return; }
    $('#pdf-attach-text').innerHTML = `<b>Reading ${files.length > 1 ? files.length + ' PDFs' : esc(files[0].name)}…</b>This takes a few seconds.`;
    try {
      const parsed = (pdf ? pdf.parsed : []).slice();
      for (const f of files) parsed.push(await PdfParse.readPdf(f));
      const opts = pdf ? pdf.opts : {};
      pdf = { parsed, r: PdfParse.merge(parsed, C.nameKey), opts };
      fillFromPdf();
    } catch (err) {
      $('#new-error').textContent = err.message || 'Could not read this PDF.';
      if (!pdf) clearPdf(); else fillFromPdf();
    }
  }
  function fillFromPdf() {
    const { r, opts } = pdf;
    const p = pdf.plan = C.planFromPdf(state.contracts, r, opts);
    const c = p.bp;
    const yes = (v) => v !== null && v !== undefined && v !== '';
    if (c) {
      // Existing BP: start from what is in the tracker, then apply what the PDF changes
      fld('bpName').value = c.bpName; fld('region').value = c.region || 'N/W'; fld('owner').value = c.owner || myName(); fld('comments').value = c.comments || '';
      const stage = (p.patch && p.patch.stage) || c.stage;
      fld('stage').innerHTML = C.ALL_STAGES.map((o) => `<option>${esc(o)}</option>`).join(''); fld('stage').value = stage;
      const am = p.kind !== 'none' && r.annualMileage ? r.annualMileage : c.annualMileage;
      fld('annualMileage').value = yes(am) ? am : '';
      newLines = p.kind !== 'none' && p.lines.length ? p.lines.map((l) => Object.assign({}, l)) : c.lines.map((l) => Object.assign({}, l));
      setTag('bpName', false); setTag('region', false);
      setTag('stage', stage !== c.stage); setWas('stage', stage !== c.stage ? c.stage : '');
      setTag('annualMileage', am !== c.annualMileage); setWas('annualMileage', am !== c.annualMileage && c.annualMileage ? fmt(c.annualMileage, 0) + ' km' : '');
      $('#btn-new-submit').textContent = 'Update ' + c.bpName;
    } else {
      if (r.bpName) fld('bpName').value = r.bpName;
      if (r.region) fld('region').value = r.region;
      fld('stage').innerHTML = C.STAGES.map((o) => `<option>${esc(o)}</option>`).join('');
      fld('stage').value = p.body ? p.body.stage : fld('stage').value;
      if (r.annualMileage) fld('annualMileage').value = r.annualMileage;
      if (p.lines.length) newLines = p.lines.map((l) => Object.assign({}, l));
      setTag('bpName', !!r.bpName); setTag('region', !!r.region); setTag('stage', true); setTag('annualMileage', !!r.annualMileage);
      setWas('stage', ''); setWas('annualMileage', '');
      $('#btn-new-submit').textContent = 'Add ' + (fld('bpName').value || 'contract');
    }
    // Banner: what was found and what will happen
    const list = (items) => `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
    const items = [];
    const sbx = p.signedBy || {};
    const fmtD = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : d);
    if (sbx.source) items.push(`<span class="sigline"><span class="${sbx.bp ? 'ok' : 'no'}">${sbx.bp ? '✓' : '⏳'} BP${sbx.bpName ? ' (' + esc(sbx.bpName) + ')' : ''}: ${sbx.bp ? 'signed ' + esc(fmtD(sbx.bp)) : 'not signed yet'}</span><span class="${sbx.surya ? 'ok' : 'no'}">${sbx.surya ? '✓' : '⏳'} Surya: ${sbx.surya ? 'signed ' + esc(fmtD(sbx.surya)) : 'not signed yet'}</span></span>`);
    items.push('Contract stage: <b>' + esc(p.signed ? 'Signed' : (p.patch && p.patch.stage) || (p.body && p.body.stage) || (p.bp && p.bp.stage) || '') + '</b>' + (sbx.source ? '' : ' (' + esc(p.signLabel) + ')'));
    if (p.needsAnswer) items.push('Is this contract signed by both the BP and Surya? <button type="button" class="gh-btn sm" data-signed="yes">Yes, signed</button> <button type="button" class="gh-btn sm" data-signed="no">Not yet</button>');
    let cls, title;
    if (!c) {
      cls = 'new'; title = `✓ New BP – read from “${esc(r.files.join(', '))}”`;
      items.push(`${p.lines.length} line${p.lines.length === 1 ? '' : 's'}${r.annualMileage ? ', annual mileage ' + fmt(r.annualMileage, 0) + ' km (Vehicles Annex Art. 2.1)' : ''}. Check the green fields, change anything you need, then click Add.`);
      if (r.rcm) items.push('RCM clause in the Commercial Annex: <b>' + (r.rcm === 'yes' ? 'Yes</b> (Art. ' + esc(r.rcmClause || '8.12.7') + ' GST Charge Mechanism)' : 'No</b> (older template, no RCM clause)'));
    } else if (p.kind === 'none') {
      cls = 'upd'; title = `${esc(c.bpName)} is already in the tracker`;
      p.notes.forEach((n) => items.push(esc(n)));
    } else {
      cls = 'upd'; title = `↻ ${esc(c.bpName)} is already in the tracker – this will update it`;
      p.changes.forEach((t) => items.push(esc(t)));
      (p.unchanged || []).forEach((code) => items.push(esc(code) + ': no change'));
      if (p.match && p.match.how === 'similar') items.push(`Name in the PDF: “${esc(r.bpName)}”. <button type="button" class="link-btn" id="pdf-not-same">It's a different BP</button>`);
    }
    const warns = r.warnings.map((w) => !c ? w : /^No Vehicles Annex/.test(w) ? 'This PDF has no Vehicles Annex, so annual mileage is left as it is.' : /^No Lines Annex/.test(w) ? 'This PDF has no Lines Annex, so the lines are left as they are.' : w);
    $('#pdf-banner').hidden = false;
    $('#pdf-banner').innerHTML = `<div class="bar ${cls}"><b>${title}</b>${list(items)}</div>` + (warns.length ? `<div class="bar warn"><b>Please check</b>${list(warns.map(esc))}</div>` : '');
    $('#pdf-attach').classList.add('done'); $('#pdf-ic').textContent = 'PDF ✓';
    $('#pdf-attach-text').innerHTML = `<b>${esc(r.files.join(', '))}</b>Read just now. The fields marked “from PDF” were filled in from it.`;
    $('#pdf-remove').hidden = false; $('#pdf-pick').textContent = 'Add another PDF';
    $('#btn-new-submit').disabled = !!p.needsAnswer;
    $('#new-existing').checked = p.bpType === 'existing';
    drawNewLines(); drawDocPreview();
  }
  async function submitNew(e) {
    e.preventDefault();
    const v = (n) => fld(n).value.trim();
    $('#new-error').textContent = '';
    try {
      if (!v('bpName')) { $('#new-error').textContent = 'Enter the BP name.'; return; }
      const am = Number(v('annualMileage').replace(/[,\s]/g, ''));
      const fd = formDocs();
      const body = { bpName: v('bpName'), region: v('region'), owner: v('owner'), stage: v('stage'), comments: v('comments'), lines: newLines, annualMileage: am > 0 ? am : null, bpType: fd.bpType, docs: fd.docs };
      const p = pdf && pdf.plan;
      if (p && pdf.r.rcm) { body.rcm = pdf.r.rcm; body.rcmClause = pdf.r.rcmClause || ''; }
      let saved;
      if (p && p.bp) {
        const c = byId(p.bp.id);
        const ch = Object.assign({}, body);
        if (p.kind !== 'none') ch.contract = p.patch && p.patch.contract ? p.patch.contract : p.contract;
        if (c.pendingContract) ch.pendingContract = null;
        ch.historyNote = 'Updated from contract PDF ' + p.contract.file + '. ' + p.signLabel + '.' + (p.changes.length ? ' ' + p.changes.join('; ') : '');
        saved = await api.update(c, ch);
        if (saved.updatedAt === c.updatedAt) { $('#new-error').textContent = 'Nothing changed.'; return; }
      } else {
        if (p) { body.contract = p.contract; body.docsReceived = true; body.historyNote = 'Added from contract PDF ' + p.contract.file + '. ' + p.signLabel + '.'; }
        saved = await api.create(body);
      }
      upsert(saved); $('#dlg-new').close(); renderAll(); openDrawer(saved.id);
      toast(p && p.bp ? `${saved.bpName} updated` : `${saved.bpName} added`);
    } catch (err) { $('#new-error').textContent = err.message; }
  }

  // Paste: "code, kms, minG, amount", in that order; any one of the numbers may be blank.
  function parsePasted(text) {
    return text.split(/\r?\n/).filter((r) => r.trim()).map((row) => {
      const parts = (row.includes('\t') ? row.split('\t') : row.split(/[;,]|\s+/)).map((p) => p.trim());
      if (!row.includes('\t')) while (parts.length && parts[parts.length - 1] === '') parts.pop();
      let l = { code: parts[0] || '', rtKms: '', minG: '', rtAmt: '', calc: null };
      [['rtKms', parts[1]], ['minG', parts[2]], ['rtAmt', parts[3]]].forEach(([k, v]) => { if (v) l = C.editLine(l, k, v.replace(/[₹\s]/g, '')); });
      return l;
    });
  }

  // ---------- Export ----------
  function exportCsv() {
    const head = ['BP name', 'Region', 'Owner', 'Contract stage', 'Docs received', 'Account created on SF', 'Bank details updated', 'Onboarding form filled',
      'Docs pending', 'Comments', 'Line codes', 'RT Kms', 'MinG', 'RT Amt', 'Total RT Amt', 'Annual mileage (km)', 'Weekly KMs (revenue report)', 'Rejection reason', 'Rejection details', 'Revised sent for signing', 'Last updated'];
    const yn2 = (b) => (b ? 'Yes' : 'No');
    const list = sorted(state.contracts.filter((c) => matches(c)));
    const rows = list.map((c) => {
      const r = C.latestRejection(c);
      const per = (k) => c.lines.map((l) => `${l.code}:${l[k] ?? ''}`).join(', ');
      return [c.bpName, c.region, c.owner, c.stage, yn2(c.docsReceived), yn2(c.sfAccountCreated), c.bankDetails, yn2(c.onboardingForm),
        c.docsPending, c.comments, c.lines.map((l) => l.code).join(', '), per('rtKms'), per('minG'), per('rtAmt'), C.totals(c).rtAmt, c.annualMileage ?? '', weekKm(c) ?? '',
        r ? r.category : '', r ? r.reason : '', r ? (r.resentAt ? 'Yes, ' + r.resentAt.slice(0, 10) : 'No') : '', String(c.updatedAt).slice(0, 10)];
    });
    const csv = [head].concat(rows).map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `bp-contracts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); toast(`Exported ${rows.length} BPs`);
  }

  // ---------- Events ----------
  function showTab(name) {
    $$('.tn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  function bind() {
    buildColumnFilters();
    const cfApply = () => { renderStageFilters(); renderRows(); renderColumnFilterState(); };
    const pop = $('#cf-pop');
    $('#edit-tbl thead').addEventListener('click', (e) => {
      const btn = e.target.closest('.cfb'); if (!btn) return;
      e.stopPropagation(); openColumnFilter(btn);
    });
    pop.addEventListener('click', (e) => {
      const o = e.target.closest('[data-cfv]'); if (!o) return;
      state.cf[cfOpen] = o.dataset.cfv; closePop(); cfApply();
    });
    let cfTimer = null;
    pop.addEventListener('input', (e) => {
      if (!e.target.classList.contains('cf-text')) return;
      state.cf[cfOpen] = e.target.value.trim(); clearTimeout(cfTimer); cfTimer = setTimeout(cfApply, 200);
    });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') closePop(); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('#cf-pop') && !e.target.closest('.cfb')) closePop(); });
    window.addEventListener('scroll', (e) => { if (!pop.hidden && !(e.target.closest && e.target.closest('#cf-pop'))) closePop(); }, true);
    $('#btn-clear-cf').addEventListener('click', () => { state.cf = {}; closePop(); cfApply(); });
    $$('.tn').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); }));
    if (/^#(dash|edit|lines|attn)$/.test(location.hash)) showTab(location.hash.slice(1));
    $('#f-region').innerHTML += C.OPTIONS.region.map((r) => `<option>${esc(r)}</option>`).join('');
    $('#btn-export-region').addEventListener('click', exportRegionCsv);
    $('#q').addEventListener('input', (e) => { state.f.q = e.target.value; renderStageFilters(); renderRows(); });
    $('#f-region').addEventListener('change', (e) => { state.f.region = e.target.value; renderStageFilters(); renderRows(); });
    $$('[data-export]').forEach((b) => b.addEventListener('click', exportCsv));
    $('#btn-new').addEventListener('click', openNew);
    $$('[data-scope]').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
    $('#lq').addEventListener('input', (e) => { state.lf.q = e.target.value; renderLinesTab(); });
    $('#l-bad').addEventListener('click', () => { state.lf.bad = !state.lf.bad; renderLinesTab(); });
    $('#btn-export-lines').addEventListener('click', exportLinesCsv);


    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-goto-disc], #btn-disc-all')) { state.lf.bad = !!e.target.closest('[data-goto-disc]'); state.lf.q = ''; $('#lq').value = ''; showTab('lines'); renderLinesTab(); return; }
      const go = e.target.closest('[data-goto-stage]');
      if (go) { state.f.stage = go.dataset.gotoStage; state.f.group = ''; state.f.region = ''; state.f.attn = false; showTab('edit'); renderStageFilters(); renderRows(); return; }
      const fs = e.target.closest('[data-filter-stage]');
      if (fs) { state.f.stage = fs.dataset.filterStage; state.f.group = ''; renderStageFilters(); renderRows(); return; }
      const gr = e.target.closest('[data-goto-region]');
      if (gr) {
        const g = gr.dataset.group || '';
        state.f.region = gr.dataset.gotoRegion; state.f.attn = false; state.f.q = ''; $('#q').value = '';
        state.f.group = GROUPS[g] ? g : ''; state.f.stage = GROUPS[g] ? '' : g;
        showTab('edit'); renderStageFilters(); renderRows(); return;
      }
      if (e.target.closest('#f-attn')) { state.f.attn = !state.f.attn; renderStageFilters(); renderRows(); return; }
      const op = e.target.closest('[data-open]');
      if (op) { openDrawer(op.dataset.open); return; }
      const rs = e.target.closest('[data-resend]');
      if (rs) { resend(rs.dataset.resend); return; }
      const tg = e.target.closest('[data-toggle]');
      if (tg && !tg.disabled) { const c = byId(tg.dataset.id); saveField(c.id, tg.dataset.toggle, !c[tg.dataset.toggle]); return; }
      if (e.target.closest('.cfb')) return;
      const th = e.target.closest('#edit-tbl th[data-sort]');
      if (th) { const k = th.dataset.sort; state.sort = { key: k, asc: state.sort.key === k ? !state.sort.asc : k === 'bpName' || k === 'stage' }; renderRows(); }
    });

    // Inline dropdowns save straight away
    $('#rows').addEventListener('change', (e) => {
      const s = e.target.closest('select[data-field]'); if (!s) return;
      if (s.dataset.field === 'stage' && s.value === C.REJECTED) { openReject(s.dataset.id); return; }
      saveField(s.dataset.id, s.dataset.field, s.value);
    });
    // Notes save when you press Enter or leave the box
    const saveNote = (el) => { const c = byId(el.dataset.note); if (c && el.value.trim() !== (c.comments || '')) saveField(c.id, 'comments', el.value.trim()); };
    $('#rows').addEventListener('keydown', (e) => { if (e.target.dataset.note && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('#rows').addEventListener('focusout', (e) => { if (e.target.dataset.note) saveNote(e.target); });

    // Drawer
    $('#drawer').addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return closeDrawer();
      const st = e.target.closest('[data-set-stage]');
      if (st && !st.disabled) { state.draft.stage = st.dataset.setStage; renderDrawer(); return; }
      const del = e.target.closest('[data-del-line]');
      if (del) { state.draft.lines.splice(Number(del.dataset.delLine), 1); renderDrawer(); return; }
      if (e.target.closest('#d-add-line')) { state.draft.lines.push(blankLine()); renderDrawer(); $$('[data-lines="d"] [data-k="code"]').pop().focus(); return; }
      if (e.target.closest('#btn-save')) return saveDraft();
      if (e.target.closest('#btn-discard')) { state.draft = clone(byId(state.openId)); renderDrawer(); return; }
      if (e.target.closest('#btn-reject')) return openReject(state.openId);
      if (e.target.closest('[data-bpnew]')) { state.draft.bpType = 'new'; renderDrawer(); return; }
    });
    $('#drawer').addEventListener('change', (e) => {
      const el = e.target;
      if (el.matches('[data-rcm]')) { state.draft.rcm = el.value || null; renderDrawer(); }
      if (el.matches('[data-bptype]')) { state.draft.bpType = el.checked ? 'existing' : 'new'; renderDrawer(); }
      if (el.dataset.doc) { state.draft.docs = Object.assign({}, state.draft.docs); if (el.value === 'missing') delete state.draft.docs[el.dataset.doc]; else state.draft.docs[el.dataset.doc] = el.value; renderDrawer(); }
    });
    $('#drawer').addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset.df) state.draft[el.dataset.df] = el.value;
      if (el.dataset.k && el.closest('[data-lines="d"]')) onLineInput(state.draft.lines, el);
      updateDirty();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#drawer').hidden && !document.querySelector('dialog[open]')) closeDrawer();
      if (e.key === 's' && (e.ctrlKey || e.metaKey) && state.openId) { e.preventDefault(); saveDraft(); }
    });

    // Add contract dialog
    const dlgNew = $('#dlg-new');
    $('#new-lines').addEventListener('input', (e) => { if (e.target.dataset.k) onLineInput(newLines, e.target); });
    $('#new-lines').addEventListener('click', (e) => { const d = e.target.closest('[data-del-line]'); if (d) { newLines.splice(Number(d.dataset.delLine), 1); drawNewLines(); } });
    // Enter in the last box of the last line adds a new line
    $('#new-lines').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.dataset.k) return;
      e.preventDefault();
      const tr = e.target.closest('tr'); if (tr.nextElementSibling) return;
      newLines.push(blankLine()); drawNewLines(); $$('[data-lines="n"] [data-k="code"]').pop().focus();
    });
    $('#btn-add-line').addEventListener('click', () => { newLines.push(blankLine()); drawNewLines(); $$('[data-lines="n"] [data-k="code"]').pop().focus(); });
    $('#btn-paste').addEventListener('click', () => {
      const parsed = parsePasted($('#paste-lines').value); if (!parsed.length) return;
      newLines = newLines.filter((l) => l.code || l.rtAmt || l.rtKms || l.minG).concat(parsed);
      $('#paste-lines').value = ''; drawNewLines(); toast(`Added ${parsed.length} lines`);
    });
    dlgNew.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => dlgNew.close()));
    $('#pdf-pick').addEventListener('click', () => $('#pdf-file').click());
    $('#pdf-remove').addEventListener('click', () => { const f = $('#form-new'); const keepOwner = fld('owner').value; f.reset(); fld('owner').value = keepOwner; fld('stage').innerHTML = C.STAGES.map((o) => `<option>${esc(o)}</option>`).join(''); newLines = [blankLine()]; clearPdf(); });
    $('#pdf-file').addEventListener('change', (e) => { attachPdfs(e.target.files); e.target.value = ''; });
    const att = $('#pdf-attach');
    ['dragenter', 'dragover'].forEach((t) => att.addEventListener(t, (e) => { e.preventDefault(); att.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => att.addEventListener(t, (e) => { e.preventDefault(); att.classList.remove('over'); }));
    att.addEventListener('drop', (e) => attachPdfs(e.dataTransfer.files));
    $('#pdf-banner').addEventListener('click', (e) => {
      const s = e.target.closest('[data-signed]'); if (s && pdf) { pdf.opts.signedAnswer = s.dataset.signed === 'yes'; fillFromPdf(); return; }
      if (e.target.closest('#pdf-not-same') && pdf) { pdf.opts.forceNew = true; fillFromPdf(); }
    });
    // Typing over a field that came from the PDF removes its "from PDF" tag
    $('#form-new').addEventListener('input', (e) => { const n = e.target.name; if (n && $(`[data-tag="${n}"]`)) setTag(n, false); if (n === 'bpName' && pdf && pdf.plan && !pdf.plan.bp) $('#btn-new-submit').textContent = 'Add ' + (e.target.value || 'contract'); });
    $('#new-existing').addEventListener('change', () => {
      if (pdf) { pdf.opts.existingBp = $('#new-existing').checked; pdf.plan = C.planFromPdf(state.contracts, pdf.r, pdf.opts); }
      drawDocPreview();
    });
    $('#form-new').addEventListener('submit', submitNew);

    // Reject dialog
    const dlgRej = $('#dlg-reject');
    dlgRej.querySelector('[data-cancel]').addEventListener('click', () => { dlgRej.close(); renderRows(); });
    dlgRej.addEventListener('cancel', () => setTimeout(renderRows));
    $('#form-reject').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        if (state.openId === rejectFor && isDirty()) await saveDraft();
        const next = await api.reject(byId(rejectFor), { category: $('[name=category]', f).value, reason: $('[name=reason]', f).value });
        upsert(next); if (state.openId === next.id) state.draft = clone(next);
        dlgRej.close(); renderAll(); toast(`${next.bpName} marked as rejected`);
      } catch (err) { $('#reject-error').textContent = err.message; }
    });
  }

  // Refresh every minute so leadership always sees the latest.
  async function poll() {
    if (state.mode === 'github') return pollGithub();
    if (state.demo || document.hidden || isDirty() || document.querySelector('dialog[open]')) return;
    if (document.activeElement && document.activeElement.closest('#rows')) return;
    try {
      state.contracts = await api.call('GET', 'api/contracts'); state.syncedAt = new Date();
      if (state.openId) { const c = byId(state.openId); if (c) state.draft = clone(c); else { state.openId = null; $('#drawer').hidden = true; } }
      renderAll();
    } catch (e) { /* keep showing the last data */ }
  }

  async function pollGithub() {
    if (document.hidden || isDirty() || document.querySelector('dialog[open]')) return;
    if (document.activeElement && document.activeElement.closest('#rows')) return;
    try {
      const d = state.me.canEdit ? await GhStore.readLatest() : await GhStore.readForViewer();
      if (!d.contracts) return;
      state.contracts = d.contracts; state.saved = { at: d.savedAt, by: d.savedBy }; state.syncedAt = new Date();
      if (state.openId) { const c = byId(state.openId); if (c) state.draft = clone(c); else { state.openId = null; $('#drawer').hidden = true; } }
      githubBanner(); renderAll();
    } catch (e) { /* keep showing the last data */ }
  }

  // ---------- Editor sign-in (GitHub) ----------
  function openSignin() {
    const r = GhStore.repo();
    $('#signin-repo').textContent = r.owner + '/' + r.name;
    $('#signin-owner').textContent = r.owner;
    $('#signin-error').textContent = '';
    $('#dlg-signin').showModal(); $('[name=edName]', $('#form-signin')).focus();
  }
  async function doSignin(e) {
    e.preventDefault();
    const f = e.target; const btn = $('button[type=submit]', f);
    btn.disabled = true; btn.textContent = 'Checking…'; $('#signin-error').textContent = '';
    try {
      const ed = await GhStore.signIn($('[name=edToken]', f).value, $('[name=edName]', f).value);
      const d = await GhStore.readLatest();
      if (d.contracts) { state.contracts = d.contracts; state.saved = { at: d.savedAt, by: d.savedBy }; }
      state.me = { name: ed.name, canEdit: true };
      $('#dlg-signin').close(); githubBanner(); renderAll(); toast('Signed in as ' + ed.name + '. Your changes are saved for the whole team.');
    } catch (err) { $('#signin-error').textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  }

  api.init().then(() => {
    bind(); renderAll(); setInterval(poll, 60000);
    $('#preview-banner').addEventListener('click', (e) => {
      if (e.target.closest('#btn-signin')) openSignin();
      if (e.target.closest('#btn-protect')) openProtect();
      if (e.target.closest('#btn-logins')) openLogins();
      if (e.target.closest('#btn-logout')) { GhStore.logout(); location.reload(); }
      if (e.target.closest('#btn-signout') && confirm('Sign out? You will see the tracker as view only on this computer.')) {
        GhStore.editor.clear(); state.me = { name: 'Viewer', canEdit: false }; state.openId = null; $('#drawer').hidden = true; githubBanner(); renderAll();
      }
    });
    $('#btn-signin-hdr').addEventListener('click', openSignin);
    if ($('#form-signin')) {
      $('#form-signin').addEventListener('submit', doSignin);
      $('#dlg-signin [data-cancel]').addEventListener('click', () => $('#dlg-signin').close());
    }
    if ($('#form-protect')) {
      $('#form-protect').addEventListener('submit', doProtect);
      $$('#dlg-protect [data-cancel]').forEach((b) => b.addEventListener('click', () => $('#dlg-protect').close()));
      $('#btn-backup').addEventListener('click', downloadBackup);
      $('#form-logins').addEventListener('submit', doSetLogin);
      $('#dlg-logins [data-cancel]').addEventListener('click', () => $('#dlg-logins').close());
      $('#logins-list').addEventListener('click', (e) => { const b = e.target.closest('[data-rm-login]'); if (b) doRemoveLogin(b.dataset.rmLogin); });
    }
    const rb = $('#btn-reset-local');
    if (rb) rb.addEventListener('click', () => {
      if (!confirm('Go back to the starting data? Everything you added or changed in this browser will be removed.')) return;
      local.clear(); state.contracts = C.seedContracts(); state.openId = null; $('#drawer').hidden = true; renderAll(); toast('Back to the starting data');
    });
  });
})();
