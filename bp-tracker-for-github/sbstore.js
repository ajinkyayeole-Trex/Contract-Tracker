/*
 * Supabase storage for the BP Contract Tracker.
 * Everyone logs in with their work email + password (Supabase Auth). The database only lets logged-in team members
 * read, and only editors/admins change anything (row-level security, see supabase/supabase-setup.sql).
 * Talks to Supabase's REST API directly, so no extra library is needed.
 * Settings come from config.js: window.SUPABASE_URL and window.SUPABASE_ANON_KEY (the public "anon"/"publishable" key).
 */
(function (root) {
  'use strict';
  const SESS = 'flix-bp-tracker-supabase';
  const cfg = () => ({ url: String(root.SUPABASE_URL || '').replace(/\/+$/, ''), key: String(root.SUPABASE_ANON_KEY || '') });
  const configured = () => { const c = cfg(); return /^https:\/\/.+/.test(c.url) && c.key.length > 20 && !/PASTE/i.test(c.url + c.key); };

  let session = null; // { access_token, refresh_token, expires_at, user: { id, email } }
  const save = () => { try { if (session) localStorage.setItem(SESS, JSON.stringify(session)); else localStorage.removeItem(SESS); } catch (e) { /* blocked */ } };
  const load = () => { try { return JSON.parse(localStorage.getItem(SESS) || 'null'); } catch (e) { return null; } };

  async function call(path, opts) {
    opts = opts || {};
    const c = cfg();
    const headers = Object.assign({ apikey: c.key, 'Content-Type': 'application/json' }, opts.headers || {});
    if (opts.auth !== false) {
      await fresh();
      if (session) headers.Authorization = 'Bearer ' + session.access_token;
    }
    let res;
    try { res = await fetch(c.url + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' }); }
    catch (e) { throw new Error('Could not reach the database. Check your internet and try again.'); }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.error_description || data.msg || data.message || data.error)) || ('Error ' + res.status);
      const e = new Error(msg); e.status = res.status; e.data = data; throw e;
    }
    return data;
  }

  // ---------- Login ----------
  function setSession(d) {
    session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: { id: d.user.id, email: d.user.email } };
    save();
  }
  async function fresh() {
    if (!session) return;
    if (session.expires_at - 60 > Date.now() / 1000) return;
    try { setSession(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } })); }
    catch (e) { session = null; save(); const err = new Error('Your login has expired. Please log in again.'); err.loggedOut = true; throw err; }
  }
  async function login(email, password) {
    try { setSession(await call('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email: String(email).trim().toLowerCase(), password } })); }
    catch (e) { throw new Error(e.status === 400 ? 'Wrong email or password.' : e.message); }
    return profile();
  }
  async function restore() {
    session = load();
    if (!session) return null;
    try { return await profile(); } catch (e) { session = null; save(); return null; }
  }
  async function logout() {
    try { if (session) await call('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* already gone */ }
    session = null; save();
  }
  async function changePassword(pw) {
    if (String(pw).length < 8) throw new Error('Use at least 8 characters.');
    await call('/auth/v1/user', { method: 'PUT', body: { password: pw } });
  }
  // The logged-in person's name and role
  async function profile() {
    const rows = await call('/rest/v1/profiles?select=id,email,name,role&id=eq.' + encodeURIComponent(session.user.id));
    if (!rows || !rows.length) { const e = new Error('Your login works, but you have not been added to the team yet. Ask the admin to add you.'); e.noProfile = true; throw e; }
    return rows[0];
  }

  // ---------- Contracts ----------
  const toRow = (c) => ({ id: c.id, bp_name: c.bpName, region: c.region || null, stage: c.stage || null, data: c, rev: c.updatedAt || new Date().toISOString() });
  async function list() {
    const rows = await call('/rest/v1/contracts?select=data&order=bp_name.asc');
    return (rows || []).map((r) => r.data);
  }
  async function getOne(id) {
    const rows = await call('/rest/v1/contracts?select=data&id=eq.' + encodeURIComponent(id));
    return rows && rows.length ? rows[0].data : null;
  }
  async function insert(c) {
    try { const rows = await call('/rest/v1/contracts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: toRow(c) }); return rows[0].data; }
    catch (e) { throw friendly(e); }
  }
  // Save a changed BP, but only if nobody else saved it since `oldRev` (the updatedAt we started from)
  async function update(next, oldRev) {
    let rows;
    try {
      rows = await call('/rest/v1/contracts?id=eq.' + encodeURIComponent(next.id) + '&rev=eq.' + encodeURIComponent(oldRev),
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { data: next, rev: next.updatedAt, bp_name: next.bpName } });
    } catch (e) { throw friendly(e); }
    if (!rows || !rows.length) { const e = new Error('conflict'); e.conflict = true; throw e; }
    return rows[0].data;
  }
  // Many at once (used by the one-time import)
  async function upsertMany(list) {
    const out = [];
    for (let i = 0; i < list.length; i += 50) {
      const rows = await call('/rest/v1/contracts?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: list.slice(i, i + 50).map(toRow) });
      out.push(rows);
    }
    return list.length;
  }
  function friendly(e) {
    if (e.status === 401 || e.status === 403 || /row-level security|permission denied/i.test(e.message)) return new Error('You can only view the tracker. Ask the admin to make you an editor.');
    if (e.status === 409) return new Error('A BP with this ID already exists.');
    return e;
  }

  // ---------- Team (admin only) ----------
  async function team() { return call('/rest/v1/profiles?select=id,email,name,role,created_at&order=created_at.asc'); }
  async function setRole(id, role) {
    const rows = await call('/rest/v1/profiles?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { role } });
    if (!rows || !rows.length) throw new Error('Only the admin can change roles.');
    return rows[0];
  }
  async function setName(id, name) {
    const rows = await call('/rest/v1/profiles?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { name: String(name).trim() } });
    if (!rows || !rows.length) throw new Error('Only the admin can change names.');
    return rows[0];
  }

  root.SbStore = { configured, login, restore, logout, changePassword, profile, list, getOne, insert, update, upsertMany, team, setRole, setName, user: () => (session ? session.user : null) };
})(typeof self !== 'undefined' ? self : this);
