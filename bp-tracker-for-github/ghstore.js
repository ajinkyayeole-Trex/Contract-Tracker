/*
 * Shared storage on GitHub, for when the tracker is published with GitHub Pages.
 * All entries live in data.json in the same repository, so everyone who opens the link sees the same data.
 * Editors connect once with a GitHub token; every save is written straight into data.json.
 *
 * Login protection (secure.js): once turned on, data.json is stored encrypted. Opening the dashboard then needs
 * a login ID + password; without one the file is unreadable. Saves keep the file encrypted.
 */
(function (root) {
  'use strict';
  const KEY = 'flix-bp-tracker-editor';
  const SESS = 'flix-bp-tracker-login';
  const FILE = 'data.json';
  const S = () => root.Secure;

  // Which repository is this page from? owner.github.io/repo/ → owner/repo. Can be set by hand in index.html.
  // The page may sit in a sub-folder of the repository (owner.github.io/repo/folder/); data.json lives next to it.
  function repo() {
    if (root.TRACKER_REPO) { const [owner, name] = String(root.TRACKER_REPO).split('/'); return { owner, name, dir: root.TRACKER_DIR || '' }; }
    const h = location.hostname;
    if (!/\.github\.io$/i.test(h)) return null;
    const owner = h.split('.')[0];
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length && /\.html?$/i.test(parts[parts.length - 1])) parts.pop();
    const userSite = !parts.length;
    const name = userSite ? owner + '.github.io' : parts[0];
    const dir = (userSite ? parts : parts.slice(1)).map((p) => decodeURIComponent(p) + '/').join('');
    return { owner, name, dir };
  }
  const filePath = () => '/contents/' + repo().dir.split('/').map(encodeURIComponent).join('/') + FILE;

  const enc = (str) => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, '')), (c) => c.charCodeAt(0)));

  const editor = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* blocked */ } },
    clear() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
  };

  // ---------- Login session (only while this browser tab is open) ----------
  const sess = { key: null, loginId: '', users: null, logins: [], protected: false, file: null };
  function saveSession(rawKey, loginId) { try { sessionStorage.setItem(SESS, JSON.stringify({ k: rawKey, id: loginId })); } catch (e) { /* ignore */ } }
  async function restoreSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESS) || 'null');
      if (!s || !s.k) return false;
      sess.key = await S().importKey(s.k); sess.loginId = s.id || '';
      return true;
    } catch (e) { return false; }
  }
  function logout() { sess.key = null; sess.loginId = ''; try { sessionStorage.removeItem(SESS); } catch (e) { /* ignore */ } }
  const lockedError = () => { const e = new Error('Log in to see the tracker.'); e.locked = true; return e; };

  async function gh(path, opts) {
    const r = repo(); const ed = editor.get();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (ed && ed.token) headers.Authorization = 'Bearer ' + ed.token;
    if (opts && opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.name}${path}`, Object.assign({ headers, cache: 'no-store' }, opts || {}));
    return res;
  }

  // Turn the stored file into { contracts, savedAt, savedBy }, unlocking it if it is protected
  async function decode(file) {
    sess.file = file;
    if (!S() || !S().isProtected(file)) { sess.protected = false; return { contracts: file.contracts, savedAt: file.savedAt, savedBy: file.savedBy }; }
    sess.protected = true; sess.users = file.users;
    if (!sess.key) throw lockedError();
    let p;
    try { p = await S().open(file, sess.key); } catch (e) { logout(); throw lockedError(); }
    sess.logins = p.logins || [];
    return { contracts: p.contracts, savedAt: p.savedAt || file.savedAt, savedBy: p.savedBy };
  }

  // Latest data with its version id (sha). Editors read through the API so it's always fresh.
  async function readLatest() {
    const res = await gh(filePath() + '?t=' + Date.now());
    if (res.status === 404) { sess.protected = false; return { contracts: null, sha: null }; }
    if (!res.ok) throw new Error(res.status === 401 ? 'Your GitHub token is no longer valid. Sign in again.' : 'Could not reach GitHub (' + res.status + '). Check your internet and try again.');
    const j = await res.json();
    let text = j.content ? dec(j.content) : null;
    if (!text && j.download_url) text = await (await fetch(j.download_url + '?t=' + Date.now(), { cache: 'no-store' })).text();
    const d = await decode(JSON.parse(text));
    return Object.assign(d, { sha: j.sha });
  }

  // Viewers: try the API once (freshest); if GitHub limits it, read the published data.json.
  async function readForViewer() {
    try { const d = await readLatest(); if (d.contracts) return d; } catch (e) { if (e.locked) throw e; /* else fall back */ }
    const res = await fetch(FILE + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return { contracts: null };
    return decode(await res.json());
  }

  // Is the shared file protected? Reads it once (without needing a login).
  async function isProtected() {
    try { await readForViewer(); } catch (e) { if (e.locked) return true; throw e; }
    return sess.protected;
  }

  // Check a login ID + password against the protected file, then remember it for this tab
  async function login(loginId, password) {
    if (!sess.file || !S().isProtected(sess.file)) await isProtected();
    const key = await S().unlock(sess.file, loginId, password);
    sess.key = key; sess.loginId = String(loginId).trim();
    saveSession(await S().exportKey(key), sess.loginId);
    return readForViewer();
  }

  async function fileFor(contracts, by, meta) {
    const savedAt = new Date().toISOString();
    if (!sess.protected) return { savedAt, savedBy: by, contracts };
    const users = (meta && meta.users) || sess.users;
    const logins = (meta && meta.logins) || sess.logins;
    return S().seal({ savedAt, savedBy: by, contracts, logins }, sess.key, users);
  }

  async function write(contracts, sha, message, by, meta) {
    const file = await fileFor(contracts, by, meta);
    const body = { message, content: enc(JSON.stringify(file, null, 1)) };
    if (sha) body.sha = sha;
    const res = await gh(filePath(), { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) { const e = new Error('conflict'); e.conflict = true; throw e; }
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new Error('GitHub refused the save. Check that you were added to the project and your token can write to it, then sign in again.');
    if (!res.ok) throw new Error('Saving to GitHub failed (' + res.status + '). Try again.');
    if (meta) { sess.users = file.users || null; sess.logins = (meta && meta.logins) || sess.logins; }
    sess.file = file;
    return { sha: (await res.json()).content.sha, file };
  }

  // Apply one change on top of the very latest data, so two editors never overwrite each other.
  // change(list) returns { list, result }. Retries if someone saved in between.
  async function commit(change, message, by, fallback) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await readLatest();
      const out = change(latest.contracts || fallback || []);
      if (out.unchanged) return out;
      try {
        await write(out.list, latest.sha, message, by);
        return Object.assign({ list: out.list }, out);
      } catch (e) { if (!e.conflict) throw e; }
    }
    throw new Error('Someone else is saving at the same moment. Wait a few seconds and try again.');
  }

  // ---------- Login management (editors only) ----------
  function checkNew(loginId, password) {
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(String(loginId || '').trim())) throw new Error('Login ID: at least 3 characters, letters, numbers, dot, dash, @ or underscore only (no spaces).');
    if (String(password || '').length < 8) throw new Error('Password: at least 8 characters.');
  }

  // First time: lock the data with a first login. prepare(list) can tidy the records before they are locked.
  async function protect(loginId, password, by, prepare, fallback) {
    checkNew(loginId, password);
    const latest = await readLatest();
    if (sess.protected) throw new Error('Login protection is already on.');
    const list = prepare(latest.contracts || fallback || []);
    const key = await S().newDataKey();
    const w = await S().wrapFor(loginId, password, key);
    sess.key = key; sess.protected = true; sess.loginId = String(loginId).trim();
    const meta = { users: { [w.id]: w.entry }, logins: [{ id: String(loginId).trim(), addedBy: by, addedAt: new Date().toISOString() }] };
    try {
      const out = await write(list, latest.sha, 'Turn on login protection (' + by + ')', by, meta);
      saveSession(await S().exportKey(key), sess.loginId);
      return { list, file: out.file };
    } catch (e) { logout(); sess.protected = false; throw e.conflict ? new Error('Someone saved at the same moment. Try again.') : e; }
  }

  // Add a login, or set a new password for an existing one
  async function setLogin(loginId, password, by) {
    checkNew(loginId, password);
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await readLatest();
      const w = await S().wrapFor(loginId, password, sess.key);
      const id = String(loginId).trim();
      const users = Object.assign({}, sess.users, { [w.id]: w.entry });
      const logins = sess.logins.filter((l) => S().norm(l.id) !== S().norm(id)).concat([{ id, addedBy: by, addedAt: new Date().toISOString() }]);
      try { await write(latest.contracts, latest.sha, 'Login ' + id + ' set (' + by + ')', by, { users, logins }); return logins; } catch (e) { if (!e.conflict) throw e; }
    }
    throw new Error('Someone else is saving at the same moment. Try again.');
  }

  async function removeLogin(loginId, by) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await readLatest();
      if (sess.logins.length <= 1) throw new Error('This is the last login. Add another one before removing it.');
      const h = await S().loginHash(loginId);
      const users = Object.assign({}, sess.users); delete users[h];
      const logins = sess.logins.filter((l) => S().norm(l.id) !== S().norm(loginId));
      try { await write(latest.contracts, latest.sha, 'Login ' + loginId + ' removed (' + by + ')', by, { users, logins }); return logins; } catch (e) { if (!e.conflict) throw e; }
    }
    throw new Error('Someone else is saving at the same moment. Try again.');
  }

  // Check a token: who is it, and can it write to this repository?
  async function signIn(token, name) {
    const r = repo();
    const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token.trim() };
    const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.name}`, { headers, cache: 'no-store' });
    if (res.status === 401) throw new Error('GitHub did not accept this token. Copy it again, without spaces.');
    if (!res.ok) throw new Error('Could not find the project ' + r.owner + '/' + r.name + ' with this token.');
    const j = await res.json();
    if (!j.permissions || !(j.permissions.push || j.permissions.admin)) throw new Error('This GitHub account can only view the project. Ask ' + r.owner + ' to add you as a collaborator, accept the invite, then try again.');
    const u = await (await fetch('https://api.github.com/user', { headers })).json().catch(() => ({}));
    const ed = { token: token.trim(), name: String(name || '').trim() || u.name || u.login || 'Editor', login: u.login || '' };
    editor.set(ed);
    return ed;
  }

  root.GhStore = {
    repo, editor, readLatest, readForViewer, commit, signIn,
    isProtected, login, logout, restoreSession, protect, setLogin, removeLogin,
    session: () => ({ protected: sess.protected, loginId: sess.loginId, logins: sess.logins.slice(), file: sess.file }),
  };
})(typeof self !== 'undefined' ? self : this);
