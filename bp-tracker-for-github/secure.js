/*
 * Login ID + password protection for the published dashboard.
 * The shared data file is stored encrypted (AES-256-GCM). One random data key encrypts the data; each login
 * gets its own copy of that key, locked with a key derived from its login ID + password (PBKDF2-SHA256).
 * Without a valid login the file is unreadable, even though the website itself is public.
 * Works in the browser (window.crypto) and in Node 18+ (globalThis.crypto) for the weekly script.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Secure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;
  const rand = (n) => (globalThis.crypto || require('crypto').webcrypto).getRandomValues(new Uint8Array(n));
  const ITER = 310000;
  const te = new TextEncoder(), td = new TextDecoder();
  const b64 = (u8) => { let s = ''; const a = new Uint8Array(u8); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const norm = (id) => String(id || '').trim().toLowerCase();

  async function loginHash(loginId) {
    const h = await subtle().digest('SHA-256', te.encode('bp-tracker:' + norm(loginId)));
    return b64(h).slice(0, 22);
  }
  async function userKey(loginId, password, salt) {
    const base = await subtle().importKey('raw', te.encode(norm(loginId) + ':' + String(password)), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function newDataKey() {
    return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function exportKey(k) { return b64(await subtle().exportKey('raw', k)); }
  async function importKey(rawB64) { return subtle().importKey('raw', unb64(rawB64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); }

  // A login's locked copy of the data key
  async function wrapFor(loginId, password, dataKey) {
    const salt = rand(16), iv = rand(12);
    const uk = await userKey(loginId, password, salt);
    const raw = await subtle().exportKey('raw', dataKey);
    const wk = await subtle().encrypt({ name: 'AES-GCM', iv }, uk, raw);
    return { id: await loginHash(loginId), entry: { salt: b64(salt), iv: b64(iv), wk: b64(wk) } };
  }
  // Open the data key with a login. Throws "Wrong login ID or password" if it doesn't fit.
  async function unlock(file, loginId, password) {
    const e = file.users && file.users[await loginHash(loginId)];
    if (!e) throw new Error('Wrong login ID or password.');
    try {
      const uk = await userKey(loginId, password, unb64(e.salt));
      const raw = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, uk, unb64(e.wk));
      return subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    } catch (err) { throw new Error('Wrong login ID or password.'); }
  }
  async function seal(payload, dataKey, users) {
    const iv = rand(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, dataKey, te.encode(JSON.stringify(payload)));
    return { protected: 1, v: 1, savedAt: payload.savedAt || new Date().toISOString(), users, iv: b64(iv), ct: b64(ct) };
  }
  async function open(file, dataKey) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, dataKey, unb64(file.ct));
    return JSON.parse(td.decode(pt));
  }
  const isProtected = (file) => !!(file && file.protected && file.ct);

  return { loginHash, wrapFor, unlock, seal, open, newDataKey, exportKey, importKey, isProtected, norm };
});
