/* ============================================================================
   Tizon Books · הנהלת חשבונות לכל העסקים
   A standalone app. It touches nothing of the store: not its code, not its
   Firebase, not its rules.

   Two ways to keep the data:
     · on this computer (the default) — works the moment it is opened, with
       a backup file that can be downloaded and restored at any time;
     · in its own Firebase project — pasted in under "גיבוי וענן", and from
       then on the data is in the cloud, behind a login, on every device.

   Every business is a "book":
     books/{book}                   name, dealer type, VAT, tax id, owners
     books/{book}/incomes/{id}      income
     books/{book}/expenses/{id}     expenses and their deductible VAT
     books/{book}/suppliers/{id}    who is paid
     books/{book}/banktx/{id}       bank statement lines and their matches

   A book can be linked to the store (tenants/{t} in the store's Firebase):
   its paid orders are then read as income. Read-only — see store() below.
   ==========================================================================*/

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import LOGO from './logo.png';
import MARK from './mark.png';
import { initializeApp } from 'firebase/app';
import {
  initializeFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, query, where, runTransaction
} from 'firebase/firestore';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail
} from 'firebase/auth';

const VERSION = '1.31.0';
const BUILD_DATE = '30.09.26';
const OLD_ERP_URL = 'https://tizon-event-default-rtdb.firebaseio.com/tizon_live_data.json';
const CLOUD_KEY = 'tzbooks_cloud';
const LOCAL_KEY = 'tzbooks_data';
const BACKUP_KEY = 'tzbooks_lastbackup';

/* ------------------------------------------------------------- storage */
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); if (SYNCED.includes(k)) prefPush(k, v); };

/* Settings that follow the user to every device, kept in prefs/{uid} in the
   cloud: the software registration, the tours and what's new, and when the
   weekly backup and monthly archive were last sent (so two devices do not
   send them twice). They are also kept in this browser, so everything keeps
   working offline. The device lock (PIN) follows too, so every device asks
   for the same code. The store is linked for every device on the server. */
const SYNCED = ['tzbooks_software', 'tzbooks_archive', 'tzbooks_autobk', 'tzbooks_lastbackup', 'tzbooks_tours', 'tzbooks_seen_version', 'tzbooks_pin', 'tzbooks_taxprofile'];
/* Removed on one device, removed on all: kept in the cloud as false. */
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } if (SYNCED.includes(k)) prefPush(k, false); };
let prefUid = null, prefQueue = {}, prefTimer = null, prefErr = '';
function prefPush(k, v) {
  if (!prefUid || !cloud) return;
  prefQueue[k] = v === undefined ? null : v;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(async () => {
    const out = { ...prefQueue, updatedAt: new Date().toISOString() }; prefQueue = {};
    try { await setDoc(doc(cloud.db, 'prefs', prefUid), clean(out), { merge: true }); prefErr = ''; }
    catch (e) { prefErr = e?.code || 'error'; console.warn('prefs sync', e); }
  }, 600);
}
/* After login: what is in the cloud wins; a first device uploads what it has. */
async function prefPull(user) {
  if (!cloud || !user?.uid) return;
  prefUid = user.uid;
  try {
    const snap = await withTimeout(getDoc(doc(cloud.db, 'prefs', prefUid)), 8000);
    const remote = snap.exists() ? snap.data() : {};
    const up = {};
    for (const k of SYNCED) {
      if (remote[k] === false) localStorage.removeItem(k);
      else if (remote[k] !== undefined && remote[k] !== null) localStorage.setItem(k, JSON.stringify(remote[k]));
      else { const v = lsGet(k, undefined); if (v !== undefined) up[k] = v; }
    }
    if (Object.keys(up).length) { await setDoc(doc(cloud.db, 'prefs', prefUid), clean({ ...up, updatedAt: new Date().toISOString() }), { merge: true }); }
    prefErr = '';
  } catch (e) { prefErr = e?.code || 'error'; console.warn('prefs pull', e); }
}

/* The cloud. BUILT_IN_CLOUD is the books' own Firebase project (tizonfinance),
   so every device connects by itself and only asks for a login. These values
   are public by design: what protects the data is the login and
   firestore.rules. A device can still choose to work locally ("נתק"), and a
   project pasted in the settings takes precedence. */
const BUILT_IN_CLOUD = {
  apiKey: 'AIzaSyAOph6_Dr2ChyEi2iFF4yDT-p9jk3uDd3k',
  authDomain: 'tizonfinance.firebaseapp.com',
  projectId: 'tizonfinance',
  storageBucket: 'tizonfinance.firebasestorage.app',
  messagingSenderId: '438117852802',
  appId: '1:438117852802:web:9ef80f02c71901c16b769b',
};
const LOCAL_ONLY_KEY = 'tzbooks_local_only';
let cloud = null;
const cloudCfg = lsGet(CLOUD_KEY, null) || (lsGet(LOCAL_ONLY_KEY, false) ? null : BUILT_IN_CLOUD);
if (cloudCfg?.apiKey && cloudCfg?.projectId) {
  try {
    const app = initializeApp(cloudCfg);
    cloud = { db: initializeFirestore(app, { experimentalAutoDetectLongPolling: true }), auth: getAuth(app), cfg: cloudCfg };
  } catch (e) { console.warn('cloud config', e); }
}
const MODE = cloud ? 'cloud' : 'local';
const hasLocalData = () => Object.keys(lsGet(LOCAL_KEY, {})).length > 0;

/* One small interface over both, addressed by path ("books", "books/x/expenses"). */
const kidsOf = (o, path) => Object.keys(o).filter(k => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'));
const local = {
  async list(path) { const o = lsGet(LOCAL_KEY, {}); return kidsOf(o, path).map(k => ({ ...o[k], id: k.split('/').pop() })); },
  async put(path, id, data) {
    const o = lsGet(LOCAL_KEY, {}); o[path + '/' + id] = data;
    try { lsSet(LOCAL_KEY, o); } catch { throw new Error('האחסון בדפדפן מלא. עבור לענן או מחק נתונים ישנים.'); }
  },
  async del(path, id) { const o = lsGet(LOCAL_KEY, {}); delete o[path + '/' + id]; lsSet(LOCAL_KEY, o); },
  async books() { return this.list('books'); },
  async patch(path, id, fields) { const o = lsGet(LOCAL_KEY, {}); o[path + '/' + id] = { ...(o[path + '/' + id] || {}), ...fields }; lsSet(LOCAL_KEY, o); },
  /* The next number and the document, written together. */
  async issue(bookId, key, start, rec) {
    const o = lsGet(LOCAL_KEY, {});
    if (o[`books/${bookId}/documents/${rec.id}`]) return o[`books/${bookId}/documents/${rec.id}`];
    const ck = `books/${bookId}/counters/${key}`;
    const n = Math.max(Number(o[ck]?.next) || 0, start);
    const d = { ...rec, number: n };
    o[`books/${bookId}/documents/${rec.id}`] = d; o[ck] = { next: n + 1 };
    lsSet(LOCAL_KEY, o);
    return d;
  },
};
const remote = {
  async list(path) { const s = await getDocs(collection(cloud.db, ...path.split('/'))); return s.docs.map(d => ({ ...d.data(), id: d.id })); },
  put: (path, id, data) => setDoc(doc(cloud.db, ...path.split('/'), id), data),
  del: (path, id) => deleteDoc(doc(cloud.db, ...path.split('/'), id)),
  patch: (path, id, fields) => updateDoc(doc(cloud.db, ...path.split('/'), id), fields),
  /* In one transaction, so two devices can never take the same number and a
     failed write never leaves a gap. */
  issue(bookId, key, start, rec) {
    const ck = doc(cloud.db, 'books', bookId, 'counters', key);
    const dk = doc(cloud.db, 'books', bookId, 'documents', rec.id);
    return runTransaction(cloud.db, async (tx) => {
      /* The same document tried again after a timeout: it was already issued. */
      const was = await tx.get(dk);
      if (was.exists()) return { ...was.data(), id: rec.id };
      const snap = await tx.get(ck);
      const n = Math.max(snap.exists() ? Number(snap.data().next) || 0 : 0, start);
      const d = { ...rec, number: n };
      tx.set(ck, { next: n + 1 });
      tx.set(dk, d);
      return d;
    });
  },
  /* Books I own, and books I was given to read (an accountant). */
  async books(email) {
    const e = email.toLowerCase();
    const [own, clerk, view] = await Promise.all([
      getDocs(query(collection(cloud.db, 'books'), where('owners', 'array-contains', e))),
      getDocs(query(collection(cloud.db, 'books'), where('clerks', 'array-contains', e))).catch(() => ({ docs: [] })),
      getDocs(query(collection(cloud.db, 'books'), where('viewers', 'array-contains', e))).catch(() => ({ docs: [] })),
    ]);
    const m = {}; [...own.docs, ...clerk.docs, ...view.docs].forEach(d => { m[d.id] = { ...d.data(), id: d.id }; });
    return Object.values(m);
  },
};
const DB = cloud ? remote : local;

/* ------------------------------------------------------------ the store */
/* The store's own Firebase. Signed in with the same user as the store's
   console, so the store's existing rules decide what can be read — its
   orders, documents and customers, for whoever runs it.
   It writes in exactly one place, storeAddCustomer() below: a NEW customer,
   on an explicit press, never overwriting a record that is already there.
   Nothing else in this code writes to the store. */
const STORE_FB = {
  apiKey: "AIzaSyDiXMoYgZfMKV5vL58Viyxuztl3RI3DsB0",
  authDomain: "tizonshoponline.firebaseapp.com",
  projectId: "tizonshoponline",
  storageBucket: "tizonshoponline.firebasestorage.app",
  messagingSenderId: "310366165947",
  appId: "1:310366165947:web:2e92ebe528b1c4d256829e"
};
let storeConn = null;
function store() {
  if (!storeConn) {
    const app = initializeApp(STORE_FB, 'store');
    storeConn = { db: initializeFirestore(app, { experimentalAutoDetectLongPolling: true }), auth: getAuth(app) };
  }
  return storeConn;
}
/* Who is signed in to the store on this device, once Firebase has looked. */
const storeUser = () => new Promise(res => { const un = onAuthStateChanged(store().auth, u => { un(); res(u || null); }); });
/* The store's own id for a customer — its docId() of the email — so a later
   purchase with the same email lands on the same record. */
const storeDocId = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 90);
/* The store's id of a shop is a short word ("main"). A web address typed in
   its place (https://www.drzilber.com/) means the one shop, "main". */
const tenantId = (v) => { const t = String(v || '').trim(); return !t ? '' : /[/:.]/.test(t) ? 'main' : t; };
/* When the store is linked on the server, every device reads it through there
   and needs no store login of its own. */
let statusP = null;
const serverStatus = (fresh) => (fresh || !statusP) ? (statusP = fnStatus()) : statusP;
const storeViaServer = async () => !!(cloud && (await serverStatus())?.store?.linked);
async function storeAddCustomer(tenant, c) {
  tenant = tenantId(tenant);
  if (await storeViaServer()) return (await fnCall({ action: 'store-add-customer', tenant, customer: c })).id;
  let id = storeDocId(c.email) || ('c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  /* Only ever a new record: if the id is taken, a new one, never an update. */
  for (let i = 0; i < 3; i++) {
    const ex = await getDoc(doc(store().db, 'tenants', tenant, 'customers', id));
    if (!ex.exists()) break;
    id = (storeDocId(c.email) || 'c') + '_' + Math.random().toString(36).slice(2, 7);
  }
  const rec = clean({
    name: c.name, email: c.email || '', phone: c.phone || '',
    address: [c.address, c.city].filter(Boolean).join(', '),
    notes: 'נוסף מ-Tizon Books', createdAt: todayIso(), source: 'tizon-books',
  });
  await setDoc(doc(store().db, 'tenants', tenant, 'customers', id), rec);
  return id;
}
async function storeRead(tenant, name) {
  tenant = tenantId(tenant);
  if (await storeViaServer()) return (await fnCall({ action: 'store-read', tenant, name })).rows || [];
  const s = await getDocs(collection(store().db, 'tenants', tenant, name));
  return s.docs.map(d => ({ ...d.data(), id: d.id }));
}

const COLS = ['incomes', 'expenses', 'suppliers', 'banktx', 'documents', 'counters', 'log', 'customers', 'items', 'payreqs', 'archive', 'recurring'];

/* History imported from iCount is kept packed: a few hundred documents to a
   record in books/{book}/archive, instead of one record each. Thousands of
   old documents then cost a handful of reads each time a business opens,
   not thousands (the free plan allows 50,000 reads a day). They are read
   only, so nothing is lost by packing them; in memory they are ordinary
   documents. */
const ARCH_BYTES = 600 * 1024;
const utf8Len = (s) => new TextEncoder().encode(s).length;
function archiveDocs(chunks) {
  const by = new Map();
  (chunks || []).filter(c => c.kind === 'documents').sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) || String(a.id).localeCompare(String(b.id)))
    .forEach(c => { try { JSON.parse(c.data || '[]').forEach(d => by.set(d.id, { ...d, _arch: true })); } catch { /* a damaged chunk is skipped */ } });
  /* One copy of each document, even if a write was cut off between two generations of the pack. */
  return [...by.values()];
}
/* A new generation of the pack is written in full before the old one is
   removed: if the connection drops halfway, the old pack is still whole and
   reading merges the two without doubling. */
async function archiveWrite(bookId, docs, oldChunks = []) {
  const col = bookCol(bookId, 'archive');
  const list = [...new Map([...docs].map(({ _arch, ...d }) => [d.id, d])).values()]
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)));
  const chunks = []; let cur = [], size = 2;
  for (const d of list) {
    const j = JSON.stringify(d), n = utf8Len(j) + 1;
    if (cur.length && size + n > ARCH_BYTES) { chunks.push(cur); cur = []; size = 2; }
    cur.push(j); size += n;
  }
  if (cur.length) chunks.push(cur);
  const old = oldChunks.filter(c => c.kind === 'documents');
  const datas = chunks.map(c => '[' + c.join(',') + ']');
  /* Nothing changed: nothing to write. */
  if (old.length === datas.length && datas.every(d => old.some(c => c.data === d))) return list.length;
  const gen = Date.now().toString(36), at = new Date().toISOString();
  for (let i = 0; i < datas.length; i++)
    await withTimeout(col.put(`docs_${gen}_${String(i).padStart(3, '0')}`, { kind: 'documents', n: chunks[i].length, data: datas[i], gen, updatedAt: at }), 30000);
  for (const c of old) await col.del(c.id).catch(() => {});
  return list.length;
}
/* Adds imported documents to the packed history, without doubling. */
async function archiveAdd(bookId, data, docs) {
  /* The pack as stored now, not as loaded: the history may still be arriving in the background. */
  const fresh = await withTimeout(bookCol(bookId, 'archive').list(), 30000).catch(() => null);
  /* Never write the pack without having read it: it would replace what is there. */
  if (!fresh) throw new Error('archive not loaded');
  data = { ...data, archive: fresh };
  const have = archiveDocs(data.archive);
  const ids = new Set(have.map(d => d.id));
  const all = [...have, ...docs.filter(d => !ids.has(d.id))];
  await archiveWrite(bookId, all, data.archive || []);
  return all.length - have.length;
}
/* Imported documents still kept one per record (before this version) move into the pack, once. */
async function archiveMigrate(book, data, onStep) {
  const loose = (data.documents || []).filter(d => d.series === 'import' && !d._arch);
  if (!loose.length) return 0;
  await archiveAdd(book.id, data, loose);
  let n = 0;
  for (let i = 0; i < loose.length; i += 25) {
    await Promise.all(loose.slice(i, i + 25).map(d => bookCol(book.id, 'documents').del(d.id).then(() => n++).catch(() => {})));
    onStep?.(Math.min(i + 25, loose.length), loose.length);
  }
  return n;
}
const bookCol = (bookId, name) => ({
  list: () => DB.list(`books/${bookId}/${name}`),
  put: (id, data) => DB.put(`books/${bookId}/${name}`, id, data),
  del: (id) => DB.del(`books/${bookId}/${name}`, id),
});
const listBooks = (email) => DB.books(email);
const putBook = (b) => DB.put('books', b.id, b);
const delBook = (id) => DB.del('books', id);

/* Everything, as one file: every book with its records. Same shape from
   either storage, and restorable into either. */
async function exportAll(email, src = DB) {
  const books = await src.books(email);
  const out = { app: 'tizon-books', version: VERSION, exportedAt: new Date().toISOString(), books: [] };
  for (const b of books) {
    const data = {};
    for (const c of COLS) data[c] = await src.list(`books/${b.id}/${c}`);
    out.books.push({ ...b, data });
  }
  return out;
}
async function importAll(file, me) {
  if (!file || file.app !== 'tizon-books' || !Array.isArray(file.books)) throw new Error('זה לא קובץ גיבוי של המערכת');
  let n = 0;
  for (const bk of file.books) {
    const { data = {}, ...b } = bk;
    const owners = [...new Set([...(b.owners || []), ...(me ? [me.toLowerCase()] : [])])];
    await putBook(clean({ ...b, owners }));
    /* What is there now wins where going back would lose something: an issued
       document is never replaced by an older copy of itself, a counter never
       goes back, and the packed history is merged rather than overwritten. */
    const now = {};
    for (const c of ['documents', 'counters']) now[c] = await bookCol(b.id, c).list().catch(() => []);
    for (const c of COLS.filter(c => c !== 'archive')) for (const r of (data[c] || [])) {
      const { id, ...rest } = r;
      if (c === 'documents' && now.documents.some(x => x.id === id)) continue;
      if (c === 'counters') { const was = now.counters.find(x => x.id === id); if (was && Number(was.next) >= Number(rest.next)) continue; }
      // Payment pages are written only by the server in the cloud; a restore skips them there.
      try { await bookCol(b.id, c).put(id, clean(rest)); n++; } catch (e) { if (c !== 'payreqs') throw e; }
    }
    const packed = archiveDocs(data.archive || []);
    if (packed.length) n += await archiveAdd(b.id, {}, packed);
  }
  return { books: file.books.length, records: n };
}
function saveJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* The config Firebase shows under Project settings, pasted as it is — the
   whole <script> block, the object, or JSON. */
function parseFirebaseConfig(text) {
  const out = {};
  ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'].forEach(k => {
    const m = String(text).match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`));
    if (m) out[k] = m[1];
  });
  return out.apiKey && out.projectId ? out : null;
}

const KINDS = { store: 'חנות', clinic: 'קליניקה', platform: 'פלטפורמה', other: 'אחר' };
const DEALERS = { exempt: 'עוסק פטור', licensed: 'עוסק מורשה', company: 'חברה בע״מ' };
const INC_CATS = ['טיפולים', 'ייעוץ', 'סדנאות וקורסים', 'מנויים ורישיונות', 'מוצרים', 'הרצאות', 'אחר'];
const EXP_CATS = ['מלאי וחומרי גלם', 'שכירות', 'שיווק ופרסום', 'ציוד', 'שכר', 'ביטוח', 'רכב ונסיעות',
                  'תוכנה ומנויים', 'משלוחים', 'עמלות סליקה', 'הנהלת חשבונות', 'אחר'];
const PAY_METHODS = ['העברה בנקאית', 'כרטיס אשראי', 'ביט', 'פייבוקס', 'מזומן', 'צ׳ק', 'הוראת קבע'];
const BOOK_COLORS = ['#8a6331', '#3f7a2a', '#2b4bb8', '#8a2450', '#35318a', '#1f5a5a'];

/* ------------------------------------------------------------------ helpers */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
/* The minus sign stays in front of the shekel sign inside Hebrew text. */
const fmt = (n) => (r2(n) < 0 ? '\u200E-' : '') + '₪' + Math.abs(r2(n)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
/* Dates as the business sees them: Israel time, not UTC (at 01:30 on the 1st
   UTC is still in the previous month, and so would the VAT period be). */
const IL_TZ = 'Asia/Jerusalem';
const ilDate = (d) => { try { return new Date(d).toLocaleDateString('sv-SE', { timeZone: IL_TZ }); } catch { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; } };
const todayIso = () => ilDate(Date.now());
const thisMonth = () => todayIso().slice(0, 7);
const clean = (o) => JSON.parse(JSON.stringify(o));
const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const withTimeout = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function d10(v) {
  if (!v) return '';
  const s = String(v).trim();
  /* A moment in time (with its hour and zone) falls on its day in Israel. */
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const t = Date.parse(s); if (!isNaN(t)) return ilDate(t); }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  const t = Date.parse(s);
  return isNaN(t) ? '' : ilDate(t);
}
const heDate = (d) => d ? d.split('-').reverse().join('/') : '—';
const monthName = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('he-IL', { month: 'short', year: '2-digit' });
};
const addMonths = (ym, k) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
/* Israeli bi-monthly VAT periods start on odd months: Jan–Feb, Mar–Apr … */
const biStart = (ym) => { const [y, m] = ym.split('-').map(Number); return `${y}-${pad(m % 2 ? m : m - 1)}`; };
const inMonths = (date, from, to) => { const m = (date || '').slice(0, 7); return m >= from && m <= to; };
const vatOf = (gross, rate) => rate > 0 ? r2(gross * rate / (100 + rate)) : 0;
const num = (s) => {
  let t = String(s ?? '').replace(/[₪,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  const n = parseFloat(t);
  return isNaN(n) ? NaN : (neg ? -Math.abs(n) : n);
};
/* Who I am in a business. On this computer only (no cloud) there is one user,
   and they own everything. */
const ROLES = { owner: 'בעלים', clerk: 'מפיק מסמכים', viewer: 'צפייה בלבד' };
const roleOf = (book, email) => {
  if (!cloud) return 'owner';
  const e = String(email || '').toLowerCase();
  return (book?.owners || []).includes(e) ? 'owner' : (book?.clerks || []).includes(e) ? 'clerk' : 'viewer';
};
const rateOf = (book) => book?.dealerType === 'exempt' ? 0 : (Number(book?.vatRate) || 0);
const paidOnPage = (o) => o?.paidVia === 'icount' || o?.payProvider === 'icountpay';
const isPaidOrder = (o) => o && o.payStatus === 'paid' && o.status !== 'cancelled';

function downloadCSV(name, rows) {
  const body = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function splitLine(line, sep) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    /* A quote opens a quoted field only at its start: inside a word it is a
       Hebrew abbreviation typed with a plain quote (מק"ט, מע"מ). */
    if (ch === '"') {
      if (q) { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else if (!cur.trim()) q = true; else cur += '"';
    }
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/* A bank statement CSV into { date, desc, amount }. Israeli banks split money
   out and in (חובה / זכות); others use one signed column. */
function parseBankCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const sep = [',', ';', '\t'].map(s => [s, lines[0].split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = lines.map(l => splitLine(l, sep));
  const hi = rows.findIndex(r => r.some(c => /תאריך|date/i.test(c)));
  const head = hi >= 0 ? rows[hi] : null;
  const col = (re) => head ? head.findIndex(c => re.test(c)) : -1;
  const cDate = col(/תאריך|date/i), cDesc = col(/תיאור|פרטים|הפעולה|description|details/i);
  const cDebit = col(/חובה|debit|חיוב/i), cCredit = col(/זכות|credit|זיכוי/i);
  const cAmt = col(/סכום|amount/i);
  const out = [];
  rows.slice(hi >= 0 ? hi + 1 : 0).forEach(r => {
    const date = d10(cDate >= 0 ? r[cDate] : r.find(c => d10(c) && /\d/.test(c)));
    if (!date) return;
    let amount = NaN;
    if (cDebit >= 0 || cCredit >= 0) {
      const dr = cDebit >= 0 ? num(r[cDebit]) : NaN, cr = cCredit >= 0 ? num(r[cCredit]) : NaN;
      amount = (isNaN(cr) ? 0 : Math.abs(cr)) - (isNaN(dr) ? 0 : Math.abs(dr));
      if (isNaN(dr) && isNaN(cr)) amount = NaN;
    } else if (cAmt >= 0) amount = num(r[cAmt]);
    else amount = r.map(num).find((n, i) => !isNaN(n) && !d10(r[i]));
    if (isNaN(amount) || amount === 0) return;
    const desc = cDesc >= 0 ? r[cDesc]
      : r.filter(c => isNaN(num(c)) && !d10(c)).sort((a, b) => b.length - a.length)[0] || '';
    out.push({ date, desc: String(desc).slice(0, 120), amount: r2(amount) });
  });
  return out;
}

/* ------------------------------------------------------------ the ledger */
/* One list of income and one of expenses for a book, whatever their source. */
function buildLedger(book, data) {
  const rate = rateOf(book);
  const docByOrder = Object.fromEntries((data?.docs || []).map(d => [d.orderId, d]));
  /* A store order whose invoice came from iCount is already counted by the
     imported iCount document: by its invoice number, or — for orders paid on
     iCount's own page, which carry no number — by the same total within two
     days. Each imported document can stand for one order only. */
  const impTypes = book?.dealerType === 'exempt' ? ['400'] : ['305', '320'];
  const imp = (data?.documents || []).filter(d => d.series === 'import' && impTypes.includes(d.type));
  const impNums = new Set(imp.map(d => String(d.number)));
  const impUsed = new Set();
  const inICount = (o) => {
    if (!imp.length) return false;
    if (o.invoiceNo && impNums.has(String(o.invoiceNo))) return true;
    if (!paidOnPage(o)) return false;
    const t = Date.parse(d10(o.paidAt) || d10(o.createdIso) || d10(o.createdAt));
    const hit = imp.find(d => !impUsed.has(d.id) && Math.abs(d.total - r2(o.total)) < 0.01 && Math.abs(Date.parse(d.date) - t) <= 2 * 86400000);
    if (hit) { impUsed.add(hit.id); return true; }
    return false;
  };
  const fromShop = (data?.orders || []).filter(isPaidOrder).filter(o => !inICount(o)).map(o => {
    const gross = r2(o.total);
    const d = docByOrder[o.id];
    return {
      id: 'o:' + o.id, src: 'shop', date: d10(o.paidAt) || d10(o.createdIso) || d10(o.createdAt),
      desc: `הזמנה ${o.code || o.id}${o.customerName ? ' · ' + o.customerName : ''}`,
      cat: 'מכירות בחנות', pay: o.payment || '', gross,
      vat: rate === 0 ? 0 : (d && d.vat != null ? r2(d.vat) : vatOf(gross, rate)),
      docNo: o.invoiceNo || (paidOnPage(o) ? 'iCount' : ''),
    };
  });
  const manual = (data?.incomes || []).map(i => ({
    ...i, src: i.src || 'manual', gross: r2(i.gross),
    vat: rate === 0 || i.noVat ? 0 : (i.vat != null ? r2(i.vat) : vatOf(i.gross, rate)),
  }));
  /* Documents issued here, in real mode: invoices are income on their date,
     credit notes take it back. A receipt is income only for an exempt
     dealer, whose receipt is the document of the sale. Test documents never. */
  const fromDocs = (data?.documents || []).filter(d => (d.series === 'live' || d.series === 'import') && !d.cancelled).flatMap(d => {
    const sign = d.type === '330' ? -1 : 1;
    const counts = ['305', '320', '330'].includes(d.type) || (d.type === '400' && book?.dealerType === 'exempt' && !d.refId);
    if (!counts) return [];
    return [{ id: 'd:' + d.id, src: 'doc', date: d.date, desc: `${docTitle(d)} · ${d.customer?.name || ''}`,
              cat: 'מסמכים שהופקו', pay: (d.payments || []).map(p => p.kind).join(', '),
              gross: sign * r2(d.total), vat: rate === 0 ? 0 : sign * r2(d.vat), docNo: docNum(d) }];
  });
  const income = [...fromShop, ...fromDocs, ...manual].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const outgo = (data?.expenses || []).map(e => ({ ...e, gross: r2(e.gross), vat: rate === 0 ? 0 : r2(e.vat) }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { income, outgo, rate };
}
function totals(ledger, from, to) {
  const inc = ledger.income.filter(i => inMonths(i.date, from, to));
  const exp = ledger.outgo.filter(e => inMonths(e.date, from, to));
  const incGross = inc.reduce((a, i) => a + i.gross, 0), incVat = inc.reduce((a, i) => a + i.vat, 0);
  const expGross = exp.reduce((a, e) => a + e.gross, 0), expVat = exp.reduce((a, e) => a + e.vat, 0);
  return { inc, exp, incGross, incVat, incNet: incGross - incVat, expGross, expVat, expNet: expGross - expVat,
           profit: (incGross - incVat) - (expGross - expVat), vatDue: incVat - expVat };
}
function alertsOf(data, ledger) {
  return {
    unmatched: (data?.banktx || []).filter(b => !b.matchId && !b.ignored).length,
    noDocOrders: (data?.orders || []).filter(o => isPaidOrder(o) && !o.invoiceNo && !paidOnPage(o)).length,
    noDocExp: ledger.outgo.filter(e => !e.docNo && !e.hasDoc).length,
    review: [...(data?.incomes || []), ...(data?.expenses || [])].filter(x => x.review).length,
    unpaid: (data?.orders || []).filter(o => o && o.payStatus !== 'paid' && o.status !== 'cancelled'),
  };
}


/* A business opens in two steps: its own records first (a few reads, shown at
   once), then in the background the packed history and the store's orders,
   which are merged in as they arrive. loadBook does both, for callers that
   need everything before they go on. */
const CORE = COLS.filter(c => c !== 'archive');
async function loadCore(book) {
  const res = await Promise.all(CORE.map(c => withTimeout(bookCol(book.id, c).list()).catch(() => null)));
  const out = { errors: [], orders: [], docs: [], storeErr: '', storeLogin: false, archive: [], histPending: true, storePending: !!tenantId(book.tenant) };
  CORE.forEach((c, i) => { out[c] = res[i] || []; if (!res[i]) out.errors.push(c); });
  return out;
}
async function loadHistory(book) {
  const archive = await withTimeout(bookCol(book.id, 'archive').list()).catch(() => null);
  return { archive: archive || [], packed: archiveDocs(archive || []), failed: !archive };
}
function withHistory(d, h) {
  /* A failed read keeps whatever history was already on screen. */
  if (h.failed) return { ...d, histPending: false, histErr: true, errors: [...new Set([...(d.errors || []), 'archive'])] };
  const ids = new Set((d.documents || []).map(x => x.id));
  return { ...d, archive: h.archive, histPending: false, histErr: h.failed,
           documents: [...(d.documents || []).filter(x => !x._arch), ...h.packed.filter(x => !ids.has(x.id))],
           errors: h.failed ? [...new Set([...(d.errors || []), 'archive'])] : (d.errors || []).filter(e => e !== 'archive') };
}
async function loadStore(book) {
  const out = { orders: [], docs: [], storeErr: '', storeLogin: false, storePending: false };
  const t = tenantId(book.tenant);
  if (!t) return out;
  try {
    if (!(await storeViaServer())) {
      const u = await withTimeout(storeUser(), 10000);
      if (!u) { out.storeLogin = true; return out; }
    }
    /* Documents are a nicety (the VAT figure of each invoice); without them
       VAT is worked out from the order total. */
    const [orders, docs] = await Promise.all([withTimeout(storeRead(t, 'orders'), 25000),
                                              withTimeout(storeRead(t, 'documents'), 25000).catch(() => [])]);
    out.orders = orders; out.docs = docs;
    out.storeAt = new Date().toISOString();
  } catch (e) {
    const c = String(e?.code || e?.message || e);
    out.storeErr = c.includes('permission')
      ? `המשתמש שמחובר לחנות לא מנהל את החנות "${t}". בדוק את מזהה החנות, או התחבר עם משתמש אחר.`
      : `לא הצלחתי לקרוא את ההזמנות של החנות "${t}" (${c}).`;
  }
  return out;
}
async function loadBook(book) {
  const [core, hist, store] = await Promise.all([loadCore(book), loadHistory(book), loadStore(book)]);
  return { ...withHistory(core, hist), ...store };
}

/* ================================================================== styles */
const CSS = `
.tz-pick input{padding-inline-end:34px}
.tz-pick-x{position:absolute;inset-inline-end:6px;top:50%;transform:translateY(-50%);border:0;background:transparent;font-size:20px;line-height:1;color:var(--muted);cursor:pointer;padding:4px 6px}
.tz-pick-list{position:absolute;z-index:60;inset-inline:0;top:calc(100% + 4px);background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.14);max-height:320px;overflow:auto}
.tz-pick-row{padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--line)}
.tz-pick-row:last-child{border-bottom:0}
.tz-pick-row.on{background:rgba(79,143,53,.10)}
.tz-pick-row .t{font-weight:600}
.tz-pick-row .s{font-size:.85em;color:var(--muted);direction:rtl;unicode-bidi:plaintext}
.tz-pick-row.empty{color:var(--muted);cursor:default;font-size:.92em}
@media (max-width:820px){.tz-pick-row{padding:13px 14px}.tz-pick-list{max-height:46vh}}
:root{--bg:#f7f3ea;--card:#fff;--ink:#2b2a26;--muted:#6b6557;--line:#e8dfcc;--green:#2f5d27;--green2:#4f8f35;
  --gold:#a8783f;--bronze1:#8a6331;--bronze2:#c4a36e;--warn:#a2680f;--bad:#b3261e;--soft:#f1ece2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'Assistant','Segoe UI',system-ui,sans-serif;font-size:15px}
button,input,select,textarea{font-family:inherit;font-size:14px}
input,select,textarea{border:1.5px solid var(--line);border-radius:10px;padding:9px 11px;background:#fff;color:var(--ink);width:100%;outline:none}
input:focus,select:focus{border-color:var(--gold)}
.shell{display:flex;min-height:100vh}
.side{width:250px;background:#fffdf8;color:var(--ink);padding:18px 12px;flex-shrink:0;display:flex;flex-direction:column;gap:4px;
  border-inline-end:1px solid var(--line);box-shadow:0 0 24px rgba(120,90,40,.06)}
.brand{padding:0 8px 12px;text-align:center;border-bottom:1px solid var(--line);margin-bottom:6px}
.brand img.full{width:100%;max-width:190px;display:block;margin:0 auto}
.brand img.mark{display:none;width:34px;height:34px}
.brand small{display:block;font-size:13px;color:var(--gold);font-weight:700;margin-top:6px;letter-spacing:.02em}
.side .sec{font-size:11px;letter-spacing:.08em;color:var(--muted);padding:12px 10px 4px}
.side button.bk{display:flex;align-items:center;gap:10px;width:100%;text-align:right;background:none;border:0;color:inherit;
  padding:10px;border-radius:10px;cursor:pointer;font-size:14px}
.side button.bk:hover{background:#f6efe1}
.side button.bk.on{background:linear-gradient(90deg,#f3e6cc,#faf4e8);color:#6e4d22;font-weight:800}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.side .foot{margin-top:auto;font-size:12px;color:var(--muted);padding:10px;line-height:1.7;border-top:1px solid var(--line)}
.side .foot button{background:none;border:0;color:var(--gold);cursor:pointer;padding:0;text-decoration:underline;font-weight:700}
.main{flex:1;padding:24px 28px;min-width:0}
.mg-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px;padding:20px 22px;border-radius:20px;color:#fff;
  background:linear-gradient(135deg,var(--h1,#8a6331),var(--h2,#c4a36e));box-shadow:0 12px 30px rgba(120,90,40,.18)}
.mg-h > div:first-child{flex:1}
.mg-h h2{margin:0;font-family:'Frank Ruhl Libre',serif;font-size:26px}
.mg-h .sub{opacity:.9;font-size:14px;margin-top:4px}
.mg-h .mg-btn{background:#fff;color:#6e4d22}
.mg-h .mg-btn.ghost{background:rgba(255,255,255,.15);color:#fff;border:1.5px solid rgba(255,255,255,.4)}
.mg-tabs{display:flex;gap:6px;flex-wrap:wrap}
.mg-tab{background:#fff;border:1.5px solid var(--line);border-radius:999px;padding:7px 15px;cursor:pointer;font-weight:600;color:var(--muted)}
.mg-tab.on{background:var(--gold);border-color:var(--gold);color:#fff}
.mg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:12px}
.mg-stat{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--gold);border-radius:16px;padding:16px 18px}
.mg-stat:nth-child(4n+2){border-top-color:#2b4bb8}.mg-stat:nth-child(4n+3){border-top-color:#d9822b}.mg-stat:nth-child(4n+4){border-top-color:var(--green2)}
.mg-stat .lb{font-size:13px;font-weight:700;color:var(--muted)}
.mg-stat .vl{font-size:26px;font-weight:800;margin:6px 0 2px}
.mg-stat .dl{font-size:12px;color:var(--muted)}
.mg-card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px 20px}
.mg-card h3{font-size:16px}
.mg-note{background:var(--soft);border-radius:12px;padding:11px 14px;border-inline-start:4px solid var(--green2);font-size:14px;line-height:1.6}
.mg-note.warn{background:#fbf3e4;border-inline-start-color:#d9822b}
.mg-note.bad{background:#fbeceb;border-inline-start-color:var(--bad)}
.mg-empty{border:2px dashed var(--line);border-radius:14px;padding:18px;text-align:center;color:var(--muted);background:#fff}
.mg-tblwrap{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:16px}
.mg-tbl{width:100%;border-collapse:collapse}
.mg-tbl th{background:var(--soft);text-align:right;padding:10px 12px;font-size:13px;white-space:nowrap}
.mg-tbl td{padding:10px 12px;border-top:1px solid #f0ebe0;font-size:14px;vertical-align:middle}
.mg-tbl tr:hover td{background:#fbf9f4}
.mg-tbl tfoot td{font-weight:800;background:var(--soft)}
.mg-btn{display:inline-flex;align-items:center;gap:6px;background:var(--green);color:#fff;border:0;border-radius:11px;padding:9px 15px;
  cursor:pointer;font-weight:700;white-space:nowrap}
.mg-btn:disabled{opacity:.45;cursor:not-allowed}
.mg-btn.ghost{background:#fff;color:var(--green);border:1.5px solid var(--line)}
.mg-btn.sm{padding:5px 10px;font-size:13px;border-radius:9px}
.mg-btn.danger{background:var(--bad)}
.mg-chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;background:var(--soft);color:var(--muted)}
.mg-chip.ok{background:#e3f1e8;color:#1f5a3d}.mg-chip.warn{background:#fbecd2;color:#8a5a0c}.mg-chip.bad{background:#fbe3e1;color:var(--bad)}
.mg-fld{display:flex;flex-direction:column;gap:4px;min-width:150px}
.mg-fld label{font-size:12px;font-weight:700;color:var(--muted)}
.mg-linkish{background:none;border:0;color:var(--green2);text-decoration:underline;cursor:pointer;padding:0;font-weight:700}
.mg-mod{position:fixed;inset:0;background:rgba(20,30,25,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
.mg-mod-in{background:#fff;border-radius:20px;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column}
.mg-mod-h{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line)}
.mg-mod-h h3{margin:0}
.mg-mod-b{padding:18px 20px;overflow-y:auto}
.mg-mod-f{display:flex;gap:8px;padding:14px 20px;border-top:1px solid var(--line)}
.sf-x{background:none;border:0;font-size:22px;cursor:pointer;color:var(--muted)}
.mlab{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;max-width:100%}
@media (max-width:600px){.mlab{font-size:11px}}
.ro .mg-btn:not(.keep),.ro .mg-linkish:not(.keep),.ro td select{display:none!important}
.flash{position:fixed;bottom:20px;left:76px;background:#16271e;color:#fff;padding:12px 18px;border-radius:12px;z-index:60;
  box-shadow:0 10px 30px rgba(0,0,0,.25);max-width:380px}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;
  background:radial-gradient(circle at 30% 10%,#fffdf8,#efe4cc 70%)}
.login img{width:200px;display:block;margin:0 auto 4px}
.login .card{background:#fff;border-radius:22px;padding:30px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px}
.seg{display:flex;background:var(--soft);border-radius:12px;padding:4px;gap:4px}
.seg button{flex:1;border:0;background:none;padding:9px;border-radius:9px;cursor:pointer;font-weight:700;color:var(--muted)}
.seg button.on{background:#fff;color:#6e4d22;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.exp-ranges{display:flex;flex-wrap:wrap;gap:6px}
.mg-chipbtn{border:1px solid var(--line,#e6dcc8);background:#fff;border-radius:999px;padding:7px 14px;font:inherit;font-size:14px;font-weight:700;color:#5b5346;cursor:pointer}
.mg-chipbtn.on{background:#6e4d22;border-color:#6e4d22;color:#fff}
.exp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px}
.exp-card{display:flex;flex-direction:column}.exp-card h3{margin:4px 0 6px}.exp-card p{margin:0 0 12px;font-size:14px;color:#5b5346;line-height:1.6;flex:1}
.exp-ic{font-size:28px;line-height:1}
.login-foot{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px;margin-top:4px}
.login h1{margin:0;font-family:'Frank Ruhl Libre',serif;color:var(--gold);text-align:center;font-size:24px}
.tour{position:fixed;inset:0;z-index:70}
.tour-block{position:absolute;inset:0;background:rgba(30,24,12,.55)}
.tour-spot{position:fixed;border-radius:14px;box-shadow:0 0 0 9999px rgba(30,24,12,.55);outline:2px solid var(--gold);pointer-events:none;
  transition:top .25s,left .25s,width .25s,height .25s}
.tour-card{position:fixed;background:#fff;border-radius:16px;padding:14px 16px 12px;box-shadow:0 18px 50px rgba(0,0,0,.28);
  border-top:4px solid var(--gold);transition:top .25s,right .25s}
.tour-top{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);font-weight:700}
.tour-top span:first-child{flex:1}
.tour-x{border:0;background:none;cursor:pointer;color:var(--muted);font-size:15px;padding:2px 4px}
.tour-card h4{margin:8px 0 4px;font-size:17px;color:#6e4d22}
.tour-card p{margin:0 0 10px;font-size:14px;line-height:1.7}
.tour-dots{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}
.tour-dots i{width:7px;height:7px;border-radius:50%;background:var(--line)}
.tour-dots i.on{background:var(--gold)}
.tour-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tour-off{margin-inline-start:auto;border:0;background:none;color:var(--muted);font-size:12px;cursor:pointer;text-decoration:underline}
.help-btn{position:fixed;bottom:20px;left:20px;width:44px;height:44px;border-radius:50%;border:0;background:var(--gold);color:#fff;
  font-size:21px;font-weight:800;cursor:pointer;box-shadow:0 8px 22px rgba(120,90,40,.35);z-index:40}
.help-btn:hover{background:var(--bronze1)}
.help-btn .nd{position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;background:var(--bad);border:2px solid #fff}
.tour-news{max-width:520px;width:100%;max-height:85vh;overflow:auto}
@media print{.help-btn,.tour,.topbar,.side-dim{display:none}}
.ledger-item{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:right;background:none;border:0;border-radius:9px;padding:8px 10px;cursor:pointer;font-size:14px;color:var(--ink)}
.ledger-item:hover{background:#f6efe1}.ledger-item.on{background:#f3e6cc;font-weight:700}.ledger-item b{font-size:13px;color:var(--green)}.ledger-item b.owe{color:var(--bad)}
@media (max-width:820px){.ledger-grid{grid-template-columns:1fr !important}.ledger-item{font-size:16px}}
/* Phones: noticeably larger type everywhere (inputs at 17px also stop iOS from zooming in). */
@media (max-width:820px){
  body{font-size:18px;line-height:1.55}
  button,input,select,textarea{font-size:17px}
  input,select,textarea{padding:11px 12px}
  .side button.bk{font-size:16.5px}
  .side .foot{font-size:14.5px}
  .mg-h{padding:18px}
  .mg-h h2{font-size:29px}
  .mg-h .sub{font-size:16.5px}
  .mg-tab{font-size:16.5px;padding:9px 16px}
  .mg-stat .lb{font-size:15.5px}
  .mg-stat .vl{font-size:31px}
  .mg-stat .dl{font-size:14.5px}
  .mg-card h3{font-size:20px}
  .mg-note{font-size:16.5px}
  .mg-tbl th{font-size:15.5px;padding:11px 12px}
  .mg-tbl td{font-size:16.5px;padding:12px}
  .mg-btn{font-size:17px;padding:11px 16px}
  .mg-btn.sm{font-size:15.5px;padding:8px 12px}
  .mg-chip{font-size:14px;padding:3px 10px}
  .mg-fld label{font-size:15px}
  .mg-empty{font-size:16.5px}
  .mlab{font-size:12px}
  .login h1{font-size:28px}
  .login-foot{font-size:14.5px}
  .flash{font-size:16.5px}
  .tour-top{font-size:14.5px}
  .tour-card h4{font-size:20px}
  .tour-card p{font-size:17px}
  .tour-off{font-size:14.5px}
  /* sizes set inline in the screens */
  :is(.shell,.mg-mod,.login) [style*="font-size: 12px"]{font-size:14.5px !important}
  :is(.shell,.mg-mod,.login) [style*="font-size: 13px"]{font-size:15.5px !important}
  :is(.shell,.mg-mod,.login) [style*="font-size: 14px"]{font-size:16.5px !important}
}
/* ================================================================ layout for every screen */
.topbar,.side-dim{display:none}
.mg-tabs{scrollbar-width:none}.mg-tabs::-webkit-scrollbar{display:none}
.mg-tblwrap{-webkit-overflow-scrolling:touch}
.mg-btn,.mg-tab,.side button.bk{touch-action:manipulation}
/* Tablets (landscape) and small laptops */
@media (min-width:821px) and (max-width:1280px){
  body{font-size:16px}
  button,input,select,textarea{font-size:15.5px}
  .side{width:224px;padding:16px 10px}
  .brand img.full{max-width:132px}
  .brand small{font-size:12px}
  .side button.bk{font-size:15.5px;padding:11px 10px}
  .main{padding:20px 22px}
  .mg-h{padding:18px 20px}.mg-h h2{font-size:26px}
  .mg-tabs.book-tabs{flex-wrap:nowrap;overflow-x:auto;margin-inline:-4px;padding:2px 4px 6px}
  .mg-tab{font-size:15.5px;padding:9px 16px;flex-shrink:0}
  .mg-stats{grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))}
  .mg-stat .vl{font-size:clamp(22px,2.6vw,28px)}
  .mg-stat .lb{font-size:14px}
  .mg-tbl th{font-size:14px}.mg-tbl td{font-size:15.5px;padding:11px 12px}
  .mg-btn{font-size:15.5px;padding:10px 15px}.mg-btn.sm{font-size:14px;padding:7px 11px}
  .mg-note{font-size:15px}.mg-card h3{font-size:18px}
  .mg-fld label{font-size:13.5px}
}
/* Phones and tablets upright: a top bar, the menu slides in from the side */
@media (max-width:820px){
  .shell{flex-direction:column}
  .topbar{display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:45;background:rgba(255,253,248,.96);
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--line);
    padding:10px 14px;padding-top:max(10px,env(safe-area-inset-top))}
  .tb-menu{width:44px;height:44px;border:1.5px solid var(--line);border-radius:12px;background:#fff;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:5px;cursor:pointer;flex-shrink:0}
  .tb-menu span{display:block;width:20px;height:2.5px;border-radius:2px;background:#6e4d22}
  .tb-title{flex:1;font-size:19px;color:#6e4d22;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tb-mark{width:36px;height:36px}
  .side-dim{display:block;position:fixed;inset:0;background:rgba(30,24,12,.45);z-index:55}
  .side{position:fixed;top:0;bottom:0;right:0;z-index:56;width:min(84vw,330px);flex-direction:column;flex-wrap:nowrap;align-items:stretch;
    padding:18px 12px;padding-top:max(18px,env(safe-area-inset-top));overflow-y:auto;transform:translateX(105%);transition:transform .25s ease;
    box-shadow:-12px 0 40px rgba(0,0,0,.18)}
  .side.open{transform:none}
  .side .sec,.side .foot small{display:block}
  .brand{padding:0 8px 12px;border-bottom:1px solid var(--line);margin-bottom:6px}
  .brand img.full{display:block;max-width:170px}.brand img.mark{display:none}.brand small{display:block}
  .side button.bk{width:100%;padding:13px 12px;font-size:17px}
  .side .foot{margin-top:auto;padding:12px 10px}
  .main{padding:14px;padding-bottom:90px}
  .mg-h{padding:16px;border-radius:18px;gap:8px}
  .mg-h > div:first-child{flex-basis:100%}
  .mg-h h2{font-size:26px}
  .mg-h .mg-btn{flex:1 1 auto;justify-content:center}
  .mg-tabs{flex-wrap:nowrap;overflow-x:auto;margin-inline:-14px;padding:2px 14px 8px}
  .mg-tab{flex-shrink:0}
  .mg-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .mg-stat{padding:12px 14px;border-radius:14px}
  .mg-stat .vl{font-size:clamp(20px,6.2vw,28px);overflow-wrap:anywhere}
  .mg-card{padding:14px 14px;border-radius:16px}
  .main .mg-fld{flex:1 1 140px;min-width:0}
  .flash{left:16px;right:16px;top:calc(72px + env(safe-area-inset-top));bottom:auto;max-width:none;text-align:center}
  .help-btn{left:14px;bottom:max(14px,env(safe-area-inset-bottom));width:50px;height:50px;font-size:23px}
  /* dialogs become sheets from the bottom */
  .mg-mod{padding:0;align-items:flex-end}
  .mg-mod-in{max-width:100% !important;max-height:94vh;border-radius:22px 22px 0 0}
  .mg-mod-h{padding:14px 16px}.mg-mod-h h3{font-size:19px}
  .mg-mod-b{padding:14px 16px}
  .mg-mod-f{padding:12px 16px;padding-bottom:max(12px,env(safe-area-inset-bottom));flex-wrap:wrap}
  .mg-mod-f .mg-btn{flex:1 1 auto;justify-content:center}
  .sf-x{font-size:30px;width:44px;height:44px}
  .tour-news{border-radius:22px 22px 0 0}
}
/* Phones: tables as cards */
@media (max-width:640px){
  .mg-tblwrap{overflow:visible;background:transparent;border:0;border-radius:0}
  .mg-tbl.has-labels,.mg-tbl.has-labels tbody,.mg-tbl.has-labels tfoot,.mg-tbl.has-labels tr{display:block;width:100%}
  .mg-tbl.has-labels thead{display:none}
  .mg-tbl.has-labels tr{background:#fff;border:1px solid var(--line);border-radius:14px;padding:8px 14px;margin-bottom:10px;box-shadow:0 2px 10px rgba(120,90,40,.05)}
  .mg-tbl.has-labels tfoot tr{background:var(--soft)}
  .mg-tbl.has-labels td{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border:0;border-bottom:1px dashed #efe7d6;
    text-align:left;white-space:normal !important;min-height:36px}
  .mg-tbl.has-labels td:last-child{border-bottom:0}
  .mg-tbl.has-labels td[data-label]::before{content:attr(data-label);font-weight:700;color:var(--muted);font-size:14.5px;text-align:right;flex-shrink:0;max-width:45%}
  .mg-tbl.has-labels td:not([data-label]){justify-content:flex-start;flex-wrap:wrap}
  .mg-tbl.has-labels td:empty{display:none}
  .mg-tbl.has-labels td > input,.mg-tbl.has-labels td > select{flex:1;min-width:0;max-width:62%}
  .mg-tbl.has-labels tr:hover td{background:transparent}
  .mg-tbl.has-labels td:first-child{font-size:17.5px}
  .mg-tbl.has-labels td[data-select]{justify-content:flex-start;border-bottom:0;padding-bottom:0;min-height:0}
  .mg-tbl.has-labels td[data-select]::before{content:none}
}


/* Phones and tablets: sharper. Darker text and labels, clearer field
   borders, heavier weights; outdoor light and small screens wash out the
   soft tones that read well on a desktop monitor. */
@media (max-width:1280px){
  :root{--ink:#121110;--muted:#3a352c;--line:#d9cbad;--bg:#faf7f0}
  body{font-weight:500;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
  input,select,textarea{border:1.6px solid #b9a782;color:#0d0c0a;font-weight:600;background:#fff}
  input:focus,select:focus,textarea:focus{border-color:var(--green2);box-shadow:0 0 0 3px rgba(79,143,53,.18)}
  input::placeholder,textarea::placeholder{color:#7d7361;font-weight:500;opacity:1}
  input:disabled,select:disabled{color:#3a352c;background:#f3eee4}
  .mg-fld label{color:#221f1a;font-weight:800}
  .mg-tab{color:#3a352c;border-color:#d2c29f}
  .mg-tab.on{color:#fff}
  .mg-mod-h h3,.mg-card h3,.mg-card h4,h4{color:#0d0c0a;font-weight:800}
  .mg-h h2,.tb-title{font-weight:700}
  .mg-tbl td{color:#121110}
  .mg-tbl th{color:#2c2821;font-weight:800}
  .mg-tbl.has-labels td[data-label]::before{color:#2c2821;font-weight:800}
  .mg-tbl.has-labels tr{border-color:#d6c6a3}
  .mg-note{color:#16140f}
  .mg-stat .lb{color:#2c2821}.mg-stat .dl{color:#3a352c}.mg-stat .vl{color:#0d0c0a}
  .mg-btn.ghost{color:#23461d;border-color:#9fb58f;font-weight:700}
  .side button{color:#1c1a16;font-weight:600}.side .sec{color:#3a352c;font-weight:700}
  .tz-pick-row .t{color:#0d0c0a;font-weight:700}.tz-pick-row .s{color:#3a352c}
  .mg-chip{color:#2c2821}
}

/* Phones: nothing may be wider than the screen. A long button wraps to a
   second line, and should anything still overflow, it is clipped inside the
   page instead of pushing the whole page sideways. */
@media (max-width:820px){
  .mg-btn{white-space:normal;max-width:100%;text-align:center;line-height:1.3}
  .shell,main{max-width:100vw;overflow-x:clip}
  main img,main table,main pre,main textarea{max-width:100%}
  .mg-note,.mg-card{overflow-wrap:anywhere}
}

/* The quick button: bottom-left, above everything but dialogs. */
.fab{position:fixed;left:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:48;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
/* The help button moves to the other corner, so the two never cover each other. */
.help-btn{left:auto !important;right:20px}
@media (max-width:820px){.help-btn{right:14px}}
.fab-btn{width:60px;height:60px;border-radius:50%;border:0;background:var(--green);color:#fff;font-size:32px;line-height:1;cursor:pointer;
  box-shadow:0 8px 24px rgba(30,60,25,.35);display:flex;align-items:center;justify-content:center;touch-action:manipulation;transition:transform .15s}
.fab.open .fab-btn{background:#3a352c;transform:rotate(90deg)}
.fab-menu{display:flex;flex-direction:column;gap:8px;align-items:flex-end;animation:fabIn .14s ease-out}
.fab-item{border:0;background:#fff;color:#121110;font-weight:700;font-size:16px;padding:12px 18px;border-radius:999px;cursor:pointer;white-space:nowrap;
  box-shadow:0 4px 16px rgba(0,0,0,.18);font-family:inherit}
.fab-item.main{background:var(--green);color:#fff}
.fab-back{position:fixed;inset:0;background:rgba(20,20,15,.25);z-index:47}
@keyframes fabIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (max-width:820px){
  .hdr-act{display:none !important}
  .hdr-set{padding:8px 12px !important;min-width:0 !important;width:auto !important;flex:0 0 auto !important}
  .hdr-set-t{display:none}
  main{padding-bottom:96px}
  .mg-h{flex-direction:row !important;align-items:center !important;flex-wrap:nowrap !important}
  .mg-h > div:first-child{flex:1;min-width:0}
}
@media print{.fab,.fab-back{display:none}}

@media (max-width:820px){[data-tour=ledger-kind]{flex-wrap:wrap !important;overflow:visible !important;margin-inline:0 !important;padding-inline:0 !important}}

@media (max-width:640px){.mg-tbl.has-labels td.stack{flex-direction:column;align-items:flex-start;gap:4px}.mg-tbl.has-labels td.stack::before{display:none}}

/* The business's tabs: a grouped side bar on a computer. */
.tab-group{display:none}
@media (min-width:1100px){
  .book-body{display:grid;grid-template-columns:200px minmax(0,1fr);gap:22px;align-items:start}
  .book-tabs.mg-tabs{flex-direction:column;flex-wrap:nowrap;overflow:visible;position:sticky;top:14px;margin:0 !important;padding:8px;
    background:#fff;border:1px solid var(--line);border-radius:16px;gap:2px;max-height:calc(100vh - 28px);overflow-y:auto}
  .book-tabs .mg-tab{border:0;border-radius:10px;text-align:right;padding:9px 12px;background:transparent;width:100%;font-size:15px}
  .book-tabs .mg-tab:hover{background:#f6efe1}
  .book-tabs .mg-tab.on{background:var(--gold);color:#fff}
  .tab-group{display:block;font-size:12px;color:var(--muted);font-weight:800;padding:12px 12px 4px;letter-spacing:.02em;border-top:1px solid #f0ebe0;margin-top:6px}
  .book-main{min-width:0}
}

/* The side bar, compact: a small logo, icons, and a fold to a narrow strip (computers). */
.brand{display:flex !important;align-items:center;gap:8px;text-align:right !important;padding:2px 6px 10px !important}
.brand img.full{display:none !important}
.brand img.mark{display:block !important;width:34px !important;height:34px !important;flex-shrink:0}
.brand-t{flex:1;min-width:0;line-height:1.15}
.brand-t b{display:block;font-size:16px;color:#6e4d22}
.brand-t small{display:block !important;font-size:11.5px !important;color:var(--gold);font-weight:700;margin:0 !important}
.side-fold{border:1px solid var(--line);background:#fff;border-radius:8px;width:28px;height:28px;cursor:pointer;color:var(--muted);font-size:15px;line-height:1;flex-shrink:0}
.side-fold:hover{color:var(--ink);border-color:var(--gold)}
.side .ic{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px}
.side .bk-ini{border-radius:50%;color:#fff;font-weight:800;font-size:13px}
.side .lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side .foot-a{display:flex;gap:10px;flex-wrap:wrap;margin:4px 0}
.side .foot-a button{text-decoration:none !important}
@media (min-width:821px){
  .side{width:212px !important;padding:12px 8px !important;position:sticky;top:0;height:100vh;overflow-y:auto;transition:width .18s}
  .side button.bk{padding:8px 8px !important;font-size:15px !important;gap:8px}
  .side .sec{padding:10px 8px 2px !important}
  .side.mini{width:62px !important;padding:12px 6px !important}
  .side.mini .lbl,.side.mini .brand-t,.side.mini .sec{display:none !important}
  .side.mini .brand{flex-direction:column;padding:2px 0 10px !important}
  .side.mini button.bk{justify-content:center;padding:8px 0 !important}
  .side.mini .foot{padding:8px 0}
  .side.mini .foot-a{flex-direction:column;align-items:center}
}
@media (max-width:820px){.side-fold{display:none}}

@media (min-width:821px){
  .help-btn{right:auto !important;left:26px !important;bottom:96px !important;width:42px !important;height:42px !important;font-size:19px !important}
  .brand-t b{font-size:15px;white-space:nowrap}
}
`;

/* ===================================================================== ui */
function Field({ label, children }) { return <div className="mg-fld"><label>{label}</label>{children}</div>; }
function Box({ title, onClose, children, footer, wide }) {
  return (
    <div className="mg-mod" onClick={onClose}>
      <div className="mg-mod-in" style={wide ? { maxWidth: 780 } : undefined} onClick={e => e.stopPropagation()}>
        <div className="mg-mod-h"><h3>{title}</h3><button className="sf-x" onClick={onClose} aria-label="סגור">×</button></div>
        <div className="mg-mod-b">{children}</div>
        {footer && <div className="mg-mod-f">{footer}</div>}
      </div>
    </div>
  );
}
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(180px,100%),1fr))', gap: 12 };
const row = { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' };

/* ================================================================== login */
function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (signup) await createUserWithEmailAndPassword(cloud.auth, email.trim(), pw);
      else await signInWithEmailAndPassword(cloud.auth, email.trim(), pw);
    } catch (x) {
      const c = String(x?.code || '');
      setErr(c.includes('email-already') ? 'המשתמש כבר קיים. היכנס עם הסיסמה שלו.'
        : c.includes('weak-password') ? 'סיסמה חלשה מדי. לפחות 6 תווים.'
        : c.includes('operation-not-allowed') || c.includes('configuration-not-found') ? 'בפרויקט ה-Firebase לא הופעלה כניסה באימייל וסיסמה (Authentication ← Sign-in method).'
        : c.includes('invalid') || c.includes('wrong') || c.includes('not-found') ? 'אימייל או סיסמה שגויים'
        : c.includes('too-many') ? 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.' : 'הכניסה נכשלה: ' + c);
    }
    setBusy(false);
  };
  return (
    <form className="login" onSubmit={go}>
      <div className="card">
        <img src={LOGO} alt="Tizon Health" />
        <h1>Books · הנהלת חשבונות</h1>
        <div className="seg">
          <button type="button" className={!signup ? 'on' : ''} onClick={() => { setSignup(false); setErr(''); }}>כניסה</button>
          <button type="button" className={signup ? 'on' : ''} onClick={() => { setSignup(true); setErr(''); }}>משתמש חדש</button>
        </div>
        {signup && <div className="mg-note" style={{ fontSize: 13 }}>
          הוזמנת לעסק? נרשמים כאן <b>באימייל שבעל העסק הוסיף</b>, והעסקים שלך יופיעו מיד אחרי הכניסה.</div>}
        <Field label="אימייל"><input type="email" dir="ltr" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" autoFocus /></Field>
        <Field label="סיסמה"><input type="password" dir="ltr" value={pw} onChange={e => setPw(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} /></Field>
        {err && <div className={'mg-note ' + (err.startsWith('נשלח') ? '' : 'bad')}>{err}</div>}
        <button className="mg-btn" disabled={busy || !email || !pw} style={{ justifyContent: 'center', padding: '12px 15px' }}>{busy ? '…' : signup ? 'צור משתמש והיכנס' : 'כניסה'}</button>
        {!signup && <button type="button" className="mg-linkish" style={{ alignSelf: 'center' }} disabled={!email}
                onClick={async () => { try { await sendPasswordResetEmail(cloud.auth, email.trim()); setErr('נשלח מייל לאיפוס הסיסמה'); } catch { setErr('לא הצלחתי לשלוח מייל איפוס'); } }}>שכחתי סיסמה</button>}
        <div className="login-foot">
          <span dir="ltr">{cloud.cfg.projectId}</span> · גרסה {VERSION}
          <button type="button" className="mg-linkish" style={{ fontSize: 12, color: 'var(--muted)' }}
                  onClick={() => { if (window.confirm('לנתק את הענן ולחזור לשמירה במחשב הזה?')) { localStorage.removeItem(CLOUD_KEY); if (BUILT_IN_CLOUD) lsSet(LOCAL_ONLY_KEY, true); location.reload(); } }}>
            עבודה בלי ענן</button>
        </div>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------- device lock */
/* An optional PIN for this device: a clinic computer others can reach. The
   PIN never leaves the device; only a salted hash of it is kept. The lock
   closes again after 15 minutes without activity. */
const PIN_KEY = 'tzbooks_pin', UNLOCK_KEY = 'tzbooks_unlocked', PIN_RESET_KEY = 'tzbooks_pin_reset';
async function pinHash(pin, salt) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function LockScreen({ onUnlock, who }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [tries, setTries] = useState(0);
  const go = async (e) => {
    e.preventDefault();
    const p = lsGet(PIN_KEY, null);
    if (p && await pinHash(pin, p.salt) === p.hash) { sessionStorage.setItem(UNLOCK_KEY, '1'); onUnlock(); return; }
    setTries(t => t + 1); setPin(''); setErr('קוד שגוי');
  };
  return (
    <form className="login" onSubmit={go}>
      <div className="card" style={{ maxWidth: 340 }}>
        <img src={LOGO} alt="Tizon Health" />
        <h1>המערכת נעולה</h1>
        {who && <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>{who}</div>}
        <Field label="קוד"><input type="password" inputMode="numeric" dir="ltr" autoFocus value={pin} disabled={tries >= 5}
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} style={{ textAlign: 'center', fontSize: 22, letterSpacing: 8 }} /></Field>
        {err && <div className="mg-note bad">{err}{tries >= 5 ? '. יותר מדי ניסיונות: סגור את הדפדפן ונסה שוב.' : ''}</div>}
        <button className="mg-btn" disabled={pin.length < 4 || tries >= 5} style={{ justifyContent: 'center' }}>פתח</button>
        {cloud && <button type="button" className="mg-linkish" style={{ fontSize: 13 }} onClick={async () => {
          if (!window.confirm('לצאת ולהיכנס שוב עם האימייל והסיסמה? אחרי הכניסה הנעילה תתבטל בכל המכשירים, ואפשר לקבוע קוד חדש.')) return;
          sessionStorage.setItem(PIN_RESET_KEY, '1'); await signOut(cloud.auth); location.reload(); }}>שכחתי את הקוד</button>}
      </div>
    </form>
  );
}

/* ==================================================================== app */
const LOCAL_USER = { email: 'local' };
/* ================================================================ guided tours
   Every screen has a short tour. A step points at an element marked with
   data-tour="…" and records the version it appeared in (since).
     · The first time a screen is opened, its tour runs by itself.
     · After an update, only the steps newer than the last visit run, marked
       "חדש", and a "what's new" window lists the changes once.
     · The "?" button (and the מדריך page) replays any tour at any time.
   tour-check.mjs runs before every build and stops it when a step points at
   an anchor that no longer exists, when a step is newer than VERSION, or when
   VERSION has no entry in CHANGES. So the guide cannot fall behind the app:
   a release that changes a screen has to update its tour to build at all. */
const TOUR_KEY = 'tzbooks_tours';
const SEEN_KEY = 'tzbooks_seen_version';
const verCmp = (a, b) => {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
};

const CHANGES = [
  { v: '1.31.0', date: '01.10.26', items: ['לשונית ייצוא חדשה תחת כלים: Excel מלא עם גיליון לכל רשימה (מסמכים, תקבולים, הכנסות, הוצאות, מע״מ לפי חודש, פקודות יומן, מאזן בוחן, לקוחות, ספקים, פריטים, בנק), חבילת ZIP לרואה החשבון, מבנה אחיד, CSV לכל רשימה וגיבוי של העסק. בחירת תקופה אחת לכולם.'] },
  { v: '1.30.1', date: '01.10.26', items: ['במחשב: העמודה הימנית צרה וקומפקטית יותר, עם לוגו קטן, וכפתור » שמכווץ אותה לפס צר של אייקונים (העסקים כעיגולים עם האות הראשונה). המערכת זוכרת את הבחירה.'] },
  { v: '1.30.0', date: '01.10.26', items: [
    'במחשב: הלשוניות של העסק עברו לסרגל צד קבוע, בקבוצות: עבודה יומית, כספים, דוחות ומיסים. בנייד ובטאבלט הן נשארות למעלה.',
    'עריכת דף סליקה שעוד לא שולם (✎ ערוך): נוצר קישור חדש עם הפרטים המעודכנים, והקודם מבוטל.'] },
  { v: '1.29.2', date: '01.10.26', items: ['לשונית "💳 סליקה" קבועה בכל עסק: כל דפי הסליקה, דף חדש, וכשעוד לא מוגדר ספק סליקה, מה חסר וכפתור להגדרה.'] },
  { v: '1.29.1', date: '01.10.26', items: ['iCount: מסמכים חדשים נמשכים בכל פתיחה של העסק (לכל היותר פעם ב-20 דקות) ולא רק פעם ביום. בלשונית המסמכים יש כפתור "↻ משוך מ-iCount" עם התוצאה, ושגיאה מוצגת במקום להיבלע. מסמך של היום תמיד בטווח.'] },
  { v: '1.29.0', date: '01.10.26', items: [
    'מסך הגדרות לכל עסק (⚙ בראש העסק): פרטי העסק, דפי סליקה (זד קרדיט ויופיי), iCount, חשבוניות מ-Gmail, החנות, רשות המסים, מיסים ומקדמות, הוצאות קבועות, משתמשים וגיבוי. בכל אחד רואים אם הוא מוגדר (✓), ומגדירים אותו באותו מקום.',
    'בלשונית המסמכים: הסבר והפניה להגדרת דפי סליקה כשהם עוד לא מוגדרים.'] },
  { v: '1.28.2', date: '01.10.26', items: [
    'יופיי: טופס התשלום נשלח כמו בתוסף הרשמי של יופיי, עם האימייל והנייד של הלקוח, כך שהם כבר ממולאים בעמוד התשלום.'] },
  { v: '1.28.1', date: '01.10.26', items: [
    'יופיי: התיאור שנשלח לעמוד התשלום הוא שורה אחת בלי מרכאות. שורות נפרדות שיבשו את כפתור התשלום בעמוד של יופיי.'] },
  { v: '1.28.0', date: '01.10.26', items: [
    'יופיי בלי מפתח API: מספיק האימייל של חשבון יופיי. הלקוח משלם בטופס של יופיי עם הסכום של הדף.',
    'כשיופיי מדווח שהתשלום עבר מקבלים מייל, ובדפי הסליקה מופיע "אישור והפקת חשבונית": לחיצה אחת מפיקה ושולחת אותה.',
    'מפתח API של יופיי נשאר רשות: מי שמוסיף אותו מקבל חשבונית אוטומטית אחרי בדיקה מול יופיי.'] },
  { v: '1.27.0', date: '01.10.26', items: [
    'דפי סליקה גם דרך יופיי (uPay): בגיבוי וענן ← דפי סליקה מזינים אימייל חשבון יופיי ומפתח API לכל עסק.',
    'כשמוגדרים גם זד קרדיט וגם יופיי, בוחרים בכל דף סליקה דרך מי. כל תשלום ביופיי נבדק מול יופיי לפני שהחשבונית מופקת ונשלחת.'] },
  { v: '1.26.0', date: '01.10.26', items: [
    'לשונית "לתשלום": בכל תקופה (חודשית או דו-חודשית) כמה מגיע לרשויות. מע״מ (עסקאות פחות תשומות), מקדמת מס הכנסה (מחזור × השיעור מההודעה) וביטוח לאומי. כל העסקים באותו מספר עוסק נספרים יחד.',
    'השוואה לרואה החשבון: מזינים את הסכומים שהוא שלח, ורואים ✓ תואם או ⚠ הפרש, עם הסבר על הסיבות הנפוצות להפרש. הדפסה וייצוא.',
    'בכל סוף תקופה: התראה בסקירה, והדוח נכלל במייל הארכיון החודשי.'] },
  { v: '1.25.0', date: '01.10.26', items: ['הוצאות קבועות מתחילת השנה: כפתור "📅 השלם מתחילת השנה" רושם את כל החודשים מינואר, ובהדבקת רשימה אפשר לבחור "מתחילת השנה". חודש שכבר נרשם לא נרשם שוב.'] },
  { v: '1.24.2', date: '01.10.26', items: ['צפי המס: מס הכנסה וביטוח לאומי (כולל מס בריאות) בנפרד, כל אחד עם המקדמות שלו, כמה להפריש לחודש וכמה נותר לשלם.'] },
  { v: '1.24.1', date: '01.10.26', items: ['הדבקת הוצאות קבועות: שם כמו "מילניום" כבר לא נחתך.'] },
  { v: '1.24.0', date: '01.10.26', items: ['הוצאה קבועה משוערת (למשל ספק חומרי גלם בממוצע ₪5,000): כל חודש נרשמת הערכה "לבדיקה". כשהחשבונית בפועל מגיעה במייל, היא מחליפה את ההערכה במקום להיכפל. אפשר גם לעדכן את הסכום ידנית.'] },
  { v: '1.23.2', date: '01.10.26', items: ['נייד צר: כרטיסים ברשות המסים ובמסכים נוספים כבר לא נחתכים בצד. שום כרטיס לא רחב מהמסך.'] },
  { v: '1.23.1', date: '01.10.26', items: ['הוצאות קבועות: "חלק העסק (%)" להוצאות של קליניקה בתוך הבית (שכירות, ארנונה, חשמל, מים). רושמים את הסכום המלא, ונרשם רק החלק של העסק. בהדבקה: "ארנונה, 1100, 1, 25%".'] },
  { v: '1.23.0', date: '01.10.26', items: [
    'הוצאות קבועות (בלשונית הוצאות): שכירות, טלפון, ביטוח, רואה חשבון וכו׳. מגדירים פעם אחת, וכל חודש ההוצאה נרשמת לבד ביום שלה, עם מע״מ לקיזוז, ונכנסת לרווח והפסד, למע״מ ולצפי המס.',
    'הדבקת רשימה: שורה לכל הוצאה ("שכירות, 4500, 1"), והמערכת מזהה שם, סכום, יום וקטגוריה.'] },
  { v: '1.22.0', date: '01.10.26', items: [
    'צפי מס הכנסה לפי ההכנסות וההוצאות: מס לפי מדרגות 2026 פחות נקודות זיכוי, ביטוח לאומי ומס בריאות לעצמאי, כמה להפריש כל חודש וכמה נותר לשלם אחרי מקדמות. כל העסקים באותו מספר עוסק מחושבים יחד. חברה מחושבת לפי מס חברות 23%.',
    'בלשונית רווח והפסד: הפירוט המלא ("איך זה חושב?"), נקודות זיכוי, מקדמות וניכויי פנסיה. בסקירה: אריח עם הצפי לשנה.'] },
  { v: '1.21.0', date: '30.09.26', items: [
    '"＋ הכנסה" פותח את טופס המסמך המלא (חיפוש לקוח, פריטים, מחירים), כי הכנסה נרשמת בהפקת חשבונית. רישום ידני של הכנסה עם מסמך ממקום אחר נשאר כקישור בלשונית ההכנסות.',
    'כפתור עגול מהיר בפינה (כמו ב-iCount): חשבונית מס קבלה, שאר סוגי המסמכים, דף סליקה והוצאה, מכל לשונית.',
    'בנייד ראש העסק קומפקטי: הכפתורים הגדולים עברו לכפתור המהיר.'] },
  { v: '1.20.0', date: '30.09.26', items: [
    'אחרי הפקת מסמך: מסך "הופק" עם שליחה ללקוח בלחיצה אחת. בנייד ה-PDF עצמו נשלח בוואטסאפ (או בכל אפליקציה). במייל נשלח עותק חתום, והכתובת כבר ממולאת. הדפסה, PDF ו"מסמך נוסף" באותו מקום.',
    'ברשימת המסמכים בנייד: כפתור 📲 שתף ששולח את ה-PDF עצמו.'] },
  { v: '1.19.3', date: '30.09.26', items: [
    'תאריכים לפי שעון ישראל: מסמך שמופק אחרי חצות נרשם ביום ובחודש הנכונים (קודם, בין 00:00 ל-03:00 הוא נרשם ביום הקודם).',
    'מסמך שההפקה שלו נתקעה ונוסתה שוב לא יופק פעמיים.',
    'לא ניתן להפיק קבלה או זיכוי אמיתיים על מסמך ניסיון. זיכוי מחושב לפי שיעור המע״מ של החשבונית המקורית. תקרת מזומן כוללת קבלות קודמות על אותה חשבונית. חובה תאריך.',
    'הדפסה: רק הדפסה ראשונה מסומנת "מקור", גם בלחיצה כפולה.',
    'הגנה על נתונים: ההיסטוריה הארוזה לא תידרס אם הטעינה נכשלה. שחזור מגיבוי לא מחליף מסמכים ומונים עדכניים. מיזוג עסקים כפולים לא מוחק דבר אם משהו לא נקרא או לא הועתק.',
    'איתור כפילויות: "מזג את הוודאיות" לא ממזג יותר בני משפחה שחולקים טלפון או אימייל.',
    'עוסק פטור עם חנות: קבלות iCount לא נספרות פעמיים. זיכוי ספק (הוצאה שלילית) ניתן לעריכה. שיעור מע״מ ריק לא נשמר.',
    'תוקנו: כפתור שגוי בלשונית פריטים, נעילה אוטומטית אחרי ביטול הקוד, רענון שהעלים רשומה שנשמרה באותו רגע, גיבוי שבועי שנשלח פעמיים.'] },
  { v: '1.19.2', date: '30.09.26', items: ['מהירות: רשימות ארוכות (מסמכים, הכנסות, הוצאות, לקוחות) מציגות את 100 החדשים ו"הצג עוד". המסכים נפתחים מיד גם עם אלפי מסמכים היסטוריים. הסכומים, החיפוש והייצוא ממשיכים לכלול הכול.'] },
  { v: '1.19.1', date: '30.09.26', items: ['נייד: תיקון מסך שזז הצידה (כפתור ארוך בלשונית הייבוא). מעכשיו שום רכיב לא יכול לדחוף את הדף הצידה.'] },
  { v: '1.19.0', date: '30.09.26', items: [
    'חשבוניות ספקים מ-Gmail: סקריפט קטן בחשבון Google שלך שולח לכאן כל שעה חשבוניות וקבלות שמגיעות במייל. הן ממתינות בלשונית ההוצאות.',
    'רישום בלחיצה: הסכום, המע״מ, התאריך, מספר החשבונית והספק נקראים מקובץ ה-PDF ומתמלאים לבד. אתה רק מאשר.',
    'כל הוצאה שנרשמה כך שומרת את החשבונית המקורית (📎).'] },
  { v: '1.18.1', date: '30.09.26', items: ['נייד וטאבלט: תצוגה חדה וברורה יותר. טקסט וכותרות כהים יותר, מסגרות שדות בולטות וגופן עבה יותר.'] },
  { v: '1.18.0', date: '30.09.26', items: [
    'כפתור 🧾 בראש כל עסק: הפקת חשבונית מס קבלה בלחיצה אחת.',
    'בחירת לקוח בחיפוש: לפי שם, טלפון, אימייל או ח.פ. (גם שמות קודמים של לקוח ממוזג). הלקוחות האחרונים מופיעים ראשונים, והפרטים מתמלאים לבד.',
    'הוספת פריטים בחיפוש: מקלידים חלק מהשם או הקוד ולוחצים. לחיצה נוספת מוסיפה כמות. הנמכרים ביותר ראשונים.',
    'בטופס "הכנסה חדשה" יש מעבר ישיר להפקת מסמך ללקוח.'] },
  { v: '1.17.0', date: '30.09.26', items: [
    'איתור כפילויות בלקוחות: מוצא את אותו אדם גם בשם בסדר הפוך, בשם מקוצר, עם שגיאת כתיב או בשם פרטי בלבד, ומציע קבוצות למיזוג. אתה בוחר מי נשאר ומי נכלל.',
    'לקוח ממוזג שומר את השמות האחרים, כך שכל המסמכים וההזמנות שלהם נספרים אליו בכרטסת ובמחזור.',
    'הכרטסת מהירה גם עם אלפי לקוחות ומסמכים.'] },
  { v: '1.16.2', date: '30.09.26', items: [
    'מיזוג לקוחות מהחנות: לפני המיזוג מוצג מה יקרה (חדשים, מה יושלם אצל קיימים, כפילויות בתוך החנות), ואחריו פס התקדמות. שום פרט קיים לא מוחלף.',
    'לקוח שכבר נמשך מהחנות מזוהה לפי הקישור שלו, גם אם שמו או הטלפון השתנו.',
    'לשונית הלקוחות מהירה גם עם אלפי לקוחות ומסמכים.'] },
  { v: '1.16.1', date: '30.09.26', items: [
    'פתיחה מהירה: העסק מוצג מיד, וההיסטוריה המיובאת והזמנות החנות נטענות ברקע ומתווספות כשהן מגיעות (עם חיווי קטן בזמן הטעינה).'] },
  { v: '1.16.0', date: '30.09.26', items: [
    'היסטוריה מ-iCount נשמרת ארוזה: אלפי מסמכים ישנים נקראים בכמה קריאות בלבד, כך שהמכסה החינמית היומית של Firebase לא נגמרת.',
    'שדות המפתח (iCount, זד קרדיט) לא מתמלאים יותר אוטומטית מסיסמאות שמורות בדפדפן.'] },
  { v: '1.15.5', date: '30.09.26', items: ['חיבור ל-iCount: תיקון עומס בבדיקת ההרשאות מול Google (429).'] },
  { v: '1.15.4', date: '30.09.26', items: ['חיבור ל-iCount: בדיקת הבעלות משלבת את מפתח השירות ואת הכניסה שלך.'] },
  { v: '1.15.3', date: '30.09.26', items: ['מסמכים ממוינים מהחדש לישן לפי תאריך המסמך.', 'חיבור ל-iCount: זיהוי בעלות גם כשמפתח השירות שהועלה שייך לפרויקט אחר.'] },
  { v: '1.15.2', date: '30.09.26', items: ['השרת עובד בלי הגדרות נוספות ב-Netlify: מזהה הפרויקט מובנה, והרשאות נבדקות לפי הכניסה שלך.', 'עסק כפול ריק נמחק בלחיצה אחת ממסך כל העסקים.'] },
  { v: '1.15.1', date: '30.09.26', items: ['חיבור ל-iCount: הודעת שגיאה מפורטת, כדי לדעת בדיוק מה חסר.'] },
  { v: '1.15.0', date: '30.09.26', items: [
    'חיבור ישיר ל-iCount: המסמכים נמשכים מ-iCount בלי לייצא קבצים, ואפשר שמסמכים חדשים ייכנסו לבד פעם ביום.'] },
  { v: '1.14.0', date: '30.09.26', items: [
    'עסקים כפולים: זיהוי ומיזוג לעסק אחד, בלי לאבד נתונים. העברה מהמכשיר לענן כבר לא יוצרת כפילויות.',
    'מסמכים שיובאו מ-iCount: הדפסת העתק נאמן למקור.'] },
  { v: '1.13.1', date: '30.09.26', items: ['ייבוא פריטים מ-iCount: קובץ XLS ישן נקרא ישירות, המע״מ לפי העמודה בקובץ, קטגוריה ויחידה מתוך הגיליונות, ופריטים מחוקים מדולגים.'] },
  { v: '1.13.0', date: '30.09.26', items: [
    'פריטים: ייבוא מוצרים ישירות מהחנות, עם בחירה אילו לייבא.',
    'פריטים: תיבות סימון למחיקה של פריט אחד, כמה, או כל הרשימה.'] },
  { v: '1.12.0', date: '30.09.26', items: [
    'מראה אחיד ומותאם לכל מכשיר: בטלפון תפריט נפתח מהצד, טבלאות מוצגות ככרטיסים וחלונות נפתחים מלמטה; בטאבלט טקסט וכפתורים גדולים יותר ולשוניות בשורה אחת.'] },
  { v: '1.11.0', date: '30.09.26', items: [
    'חיבור קבוע לחנות לכל המכשירים: מתחברים פעם אחת בגיבוי וענן, וכל מכשיר קורא את החנות דרך השרת בלי להתחבר בעצמו.',
    'גם קוד הנעילה עובר עכשיו בין המכשירים.'] },
  { v: '1.10.0', date: '30.09.26', items: [
    'כרטסת: לקוח, ספק וכל חשבון בהנהלת החשבונות, עם יתרת פתיחה ויתרה מצטברת. הדפסה, אקסל ושליחה ללקוח.',
    'מאזן בוחן לכל תקופה.'] },
  { v: '1.9.2', date: '30.09.26', items: ['חיבור לחנות: כתובת אתר שהוזנה במקום מזהה החנות מתוקנת לבד ל-main.', 'ההודעה על סנכרון ההגדרות מפנה לחוקים העדכניים.'] },
  { v: '1.9.1', date: '30.09.26', items: ['תיקון בנייה ב-Netlify (תיקיית public).'] },
  { v: '1.9.0', date: '30.09.26', items: [
    'פריטים: קטלוג מוצרים ושירותים לכל עסק, עם ייבוא מ-iCount. בחשבונית בוחרים פריט והמחיר נכנס לבד.',
    'דפי סליקה של זד קרדיט: שולחים ללקוח קישור, הוא משלם בכרטיס (גם בתשלומים), ומיד מופקת חשבונית מס קבלה חתומה ונשלחת אליו במייל.',
    'הגדרה חד-פעמית: גיבוי וענן ← דפי סליקה.'] },
  { v: '1.8.3', date: '30.09.26', items: ['כל ההגדרות עוברות אוטומטית בענן לכל מכשיר: רישום התוכנה, ההדרכות, הגיבוי השבועי והארכיון החודשי (בלי כפילויות בין מכשירים).'] },
  { v: '1.8.2', date: '30.09.26', items: ['טקסט גדול משמעותית בטלפון: כפתורים, טבלאות, טפסים והדרכה.'] },
  { v: '1.8.1', date: '30.09.26', items: [
    'חיבור אוטומטי לענן בכל מכשיר: לא צריך יותר להדביק הגדרות. נכנסים עם אימייל וסיסמה.'] },
  { v: '1.8.0', date: '30.09.26', items: [
    'הדרכה אינטראקטיבית בכל מסך: סיור קצר שרץ בפעם הראשונה, ואחרי כל עדכון מציג רק את מה שחדש.',
    'כפתור "?" בפינת המסך מפעיל שוב את ההדרכה של המסך הנוכחי.',
    'דף "מדריך" בתפריט: כל הסיורים במקום אחד, ורשימת השינויים בכל גרסה.',
    'חלון "מה חדש" שמופיע פעם אחת אחרי כל עדכון.'] },
  { v: '1.7.0', date: '29.09.26', items: [
    'מסך כניסה חדש, משתמשים והרשאות: בעלים, מפיק מסמכים וצופה. נעילה בקוד במכשיר.',
    'מספרי הקצאה אוטומטיים מרשות המסים.',
    'תקרת מזומן, ארכיון חודשי ורשומות הנהלת חשבונות (B100/B110) במבנה האחיד.'] },
  { v: '1.6.0', date: '', items: ['שליחת לקוחות לחנות (סנכרון דו-כיווני): רק בלחיצה, ורק לקוחות חדשים.'] },
  { v: '1.5.0', date: '', items: ['לשונית לקוחות וכרטיס לקוח, ייבוא לקוחות מ-iCount (אקסל או CSV) וסנכרון מהחנות.'] },
  { v: '1.4.0', date: '', items: ['ייבוא מ-iCount (וכל תוכנה רשומה) דרך קובץ מבנה אחיד.'] },
  { v: '1.3.0', date: '', items: ['PDF אמיתי, חתימה דיגיטלית ושליחה במייל, ניכוי במקור, יומן פעולות, צפייה בלבד לרואה חשבון וייצוא מבנה אחיד.'] },
  { v: '1.2.0', date: '', items: ['הפקת מסמכים במספור רציף: חשבונית מס, קבלה, חשבונית מס קבלה, זיכוי ועוד.'] },
  { v: '1.1.0', date: '', items: ['קישור לחנות בקריאה בלבד: הזמנות ששולמו נספרות כהכנסה.'] },
  { v: '1.0.1', date: '', items: ['לוגו וצבעי המותג.'] },
  { v: '1.0.0', date: '', items: ['הגרסה הראשונה: עסקים, הכנסות, הוצאות, ספקים, בנק, מע״מ ורווח והפסד.'] },
];

const TOUR_CTX = {
  welcome: 'התחלה', all: 'כל העסקים', dash: 'סקירה', docs: 'מסמכים', customers: 'לקוחות', income: 'הכנסות',
  expenses: 'הוצאות', suppliers: 'ספקים', bank: 'בנק', vat: 'מע״מ', pay: 'לתשלום', bset: 'הגדרות העסק', paypages: 'דפי סליקה', pnl: 'רווח והפסד', tax: 'רשות המסים',
  items: 'פריטים', ledger: 'כרטסת', export: 'ייצוא', import: 'ייבוא', settings: 'גיבוי וענן', users: 'משתמשים והרשאות', help: 'מדריך',
};
const BOOK_CTX = ['dash', 'docs', 'customers', 'items', 'ledger', 'income', 'expenses', 'suppliers', 'bank', 'vat', 'pnl', 'tax', 'export', 'import'];
const WRITERS = ['owner', 'clerk'];

const TOURS = {
  welcome: [
    { title: 'ברוך הבא ל-Tizon Books', text: 'סיור של דקה. מעבירים שלבים עם "הבא" או עם החצים במקלדת, ויוצאים בכל רגע עם Esc.', since: '1.0.0' },
    { t: 'welcome-card', title: 'מתחילים מעסק', text: 'כל עסק הוא ספר נפרד, עם סוג עוסק ומע״מ משלו. אפשר להתחיל מהחנות, מהקליניקה או מכל עסק אחר.', since: '1.0.0' },
    { t: 'side-new', title: 'עוד עסק', text: 'מכאן מוסיפים עסקים בכל רגע.', since: '1.0.0' },
    { t: 'side-settings', title: 'גיבוי וענן', text: 'בלי ענן הנתונים נשמרים בדפדפן הזה בלבד. כדאי לחבר ענן או לגבות לעיתים קרובות.', since: '1.0.0' },
    { t: 'help-btn', title: 'עזרה בכל מסך', text: 'הכפתור הזה מפעיל את ההדרכה של המסך שאתה נמצא בו.', since: '1.8.0' },
  ],
  all: [
    { title: 'כל העסקים במבט אחד', text: 'המסך הזה מחבר את כל העסקים: הכנסות, הוצאות, מע״מ ומה דורש טיפול.', since: '1.0.0', roles: ['owner', 'viewer'] },
    { title: 'ברוך הבא', text: 'יש לך הרשאה להפיק מסמכים ולנהל לקוחות בעסקים שבתפריט. בוחרים עסק כדי להתחיל.', since: '1.7.0', roles: ['clerk'] },
    { t: 'all-period', title: 'תקופה', text: 'בוחרים חודש או תקופת דיווח, וכל המספרים במסך מתעדכנים.', since: '1.0.0' },
    { t: 'all-stats', title: 'הסיכום', text: 'הכנסות, הוצאות ורווח של כל העסקים יחד, לפני מע״מ.', since: '1.0.0' },
    { t: 'all-table', title: 'עסק עסק', text: 'שורה לכל עסק: הכנסות, הוצאות, רווח ומע״מ, ומעבר מהיר לעסק עצמו.', since: '1.0.0' },
    { t: 'all-vat', title: 'מע״מ לפי עוסק', text: 'עסקים עם אותו מספר עוסק מדווחים יחד, ולכן מחוברים כאן לדיווח אחד.', since: '1.0.0' },
    { t: 'all-alerts', title: 'מה דורש טיפול', text: 'הזמנות בלי מסמך, שורות בנק שלא הותאמו ועוד. כדאי לעבור על זה פעם בשבוע.', since: '1.0.0' },
    { t: 'all-chart', title: '12 חודשים', text: 'המגמה לאורך השנה: הכנסות לפי עסק מול הוצאות.', since: '1.0.0' },
    { t: 'side-books', title: 'העסקים שלך', text: 'כל עסק בתפריט נפתח לספר משלו, עם לשוניות למסמכים, לקוחות, הכנסות ועוד.', since: '1.0.0' },
    { t: 'side-new', title: 'עסק חדש', text: 'מוסיפים עוד עסק בכל רגע.', since: '1.0.0' },
    { t: 'side-users', title: 'משתמשים והרשאות', text: 'מי נכנס לאיזה עסק: בעלים, מפיק מסמכים או צופה.', since: '1.7.0' },
    { t: 'side-settings', title: 'גיבוי וענן', text: 'גיבוי, ענן, חתימה דיגיטלית, חיבור לחנות ורשות המסים.', since: '1.0.0' },
    { t: 'side-help', title: 'המדריך', text: 'כל ההדרכות במקום אחד, ורשימת השינויים בכל גרסה.', since: '1.8.0' },
    { t: 'help-btn', title: 'עזרה בכל מסך', text: 'הכפתור הזה מפעיל את ההדרכה של המסך שאתה נמצא בו. אחרי כל עדכון ההדרכה מציגה רק את מה שחדש.', since: '1.8.0' },
  ],
  dash: [
    { t: 'book-head', title: 'הספר של העסק', text: 'סוג העוסק, מספר העוסק ושיעור המע״מ. מכאן גם עורכים את פרטי העסק.', since: '1.0.0' },
    { t: 'book-tabs', title: 'הלשוניות', text: 'כל עבודת העסק כאן: מסמכים, לקוחות, פריטים, הכנסות, הוצאות, בנק, מע״מ, רווח והפסד ורשות המסים.', since: '1.0.0' },
    { t: 'dash-month', title: 'חודש', text: 'בוחרים חודש והמספרים מתעדכנים.', since: '1.0.0' },
    { t: 'dash-stats', title: 'המספרים של החודש', text: 'הכנסות, הוצאות, רווח ומע״מ לתשלום.', since: '1.0.0' },
    { t: 'dash-alerts', title: 'מה דורש טיפול', text: 'דברים שכדאי לסגור: הזמנות בלי מסמך, שורות בנק פתוחות ועוד. לחיצה מעבירה ללשונית המתאימה.', since: '1.0.0' },
    { t: 'dash-chart', title: 'שנה אחורה', text: 'הכנסות מול הוצאות ב-12 החודשים האחרונים.', since: '1.0.0' },
  ],
  docs: [
    { t: 'fab', title: 'הכפתור המהיר', text: 'מכל לשונית: לחיצה על + בפינה פותחת חשבונית מס קבלה, שאר סוגי המסמכים, דף סליקה או הוצאה.', since: '1.21.0' },
    { t: 'quick-doc', title: 'הפקה מהירה', text: 'מכל מקום בעסק: לחיצה כאן פותחת מסמך חדש (חשבונית מס קבלה, או קבלה לעוסק פטור).', since: '1.18.0' },
    { t: 'book-tabs', title: 'העסקים שלך', text: 'יש לך הרשאה להפיק מסמכים ולנהל לקוחות. שתי הלשוניות כאן.', since: '1.7.0', roles: ['clerk'] },
    { t: 'docs-mode', title: 'ניסיון או אמיתי', text: 'במצב ניסיון המסמכים מסומנים T- ולא נספרים. במצב אמיתי הם מסמכי מס: מספור רציף, בלי מחיקה ובלי עריכה.', since: '1.2.0' },
    { t: 'docs-new', title: 'הפקת מסמך', text: 'בוחרים סוג: חשבונית מס, קבלה, חשבונית מס קבלה, זיכוי ועוד. הסוגים מותאמים לסוג העוסק.', since: '1.2.0', roles: WRITERS },
    { t: 'docs-filters', title: 'סינון', text: 'לפי חודש, סוג ומקור (Tizon Books או iCount). כאן רואים גם כמה חשבוניות עוד פתוחות.', since: '1.2.0' },
    { t: 'docs-table', title: 'המסמכים', text: 'מכל מסמך אפשר להפיק PDF חתום, להדפיס ולשלוח במייל או בוואטסאפ. הדפסה חוזרת מסומנת "העתק".', since: '1.2.0' },
    { t: 'docs-paynew', title: 'דף סליקה', text: 'קישור לתשלום בכרטיס (זד קרדיט) ששולחים ללקוח בוואטסאפ או במייל. כשהוא משלם, החשבונית מופקת ונשלחת אליו לבד.', since: '1.9.0', roles: WRITERS },
    { t: 'docs-pay', title: 'מעקב אחרי תשלומים', text: 'כל הקישורים ששלחת: מה ממתין, מה שולם ואיזה מסמך הופק. הרשימה מתעדכנת לבד.', since: '1.9.0' },
    { t: 'docs-table', title: 'מספר הקצאה', text: 'חשבונית מעל הסף לעוסק מורשה צריכה מספר הקצאה. כשרשות המסים מחוברת, מבקשים אותו מכאן בלחיצה.', since: '1.7.0' },
  ],
  customers: [
    { t: 'cust-stats', title: 'הלקוחות', text: 'כמה לקוחות, כמה עם אימייל וטלפון, וכמה פעילים השנה.', since: '1.5.0' },
    { t: 'cust-dups', title: 'איתור כפילויות', text: 'מוצא את אותו לקוח שנרשם כמה פעמים: שם בסדר הפוך, שם מקוצר, שגיאת כתיב, שם פרטי בלבד, או אותו טלפון / אימייל. אתה בוחר מי נשאר ומי נכלל, והמסמכים של כולם נספרים אליו.', since: '1.17.0' },
    { t: 'cust-store', title: 'סנכרון עם החנות', text: 'לקוחות החנות נקראים לכאן ומתמזגים בלחיצה, אחרי שרואים מה יקרה: חדשים מתווספים, ולקיימים נוספים רק פרטים חסרים. לחנות נוספים רק לקוחות חדשים, בלחיצה, ואף פרט קיים שם לא משתנה.', since: '1.6.0' },
    { t: 'cust-tools', title: 'חיפוש, הוספה וייבוא', text: 'מחפשים לפי שם, טלפון, אימייל או ח.פ. אפשר להוסיף לקוח, לייבא מ-iCount ולייצא לאקסל.', since: '1.5.0', roles: WRITERS },
    { t: 'cust-table', title: 'כרטיס לקוח', text: 'מחזור ופעילות אחרונה לכל לקוח. בכרטיס יש גם כפתור לכרטסת. כפילויות מתאחדות לפי ח.פ., ורק כשהשם תואם גם לפי אימייל או טלפון.', since: '1.5.0' },
  ],
  items: [
    { t: 'items-tools', title: 'פריטים', text: 'המוצרים והשירותים של העסק, עם מחיר. מוסיפים כאן, מייבאים מהחנות, או מ-iCount (אקסל או CSV).', since: '1.9.0' },
    { t: 'items-table', title: 'מחיקה של כמה יחד', text: 'מסמנים פריטים בתיבות, או את כולם בתיבה שבכותרת, ומוחקים בלחיצה אחת.', since: '1.13.0', roles: ['owner'] },
    { t: 'items-table', title: 'הקטלוג', text: 'בחשבונית ובדף סליקה בוחרים פריט, והמחיר נכנס לבד, גם כשהמסמך לפני מע״מ והמחיר כולל אותו. כאן רואים גם כמה נמכר מכל פריט.', since: '1.9.0' },
  ],
  ledger: [
    { t: 'ledger-kind', title: 'כרטסות', text: 'כרטסת לקוח, כרטסת ספק, כרטסת של כל חשבון בהנהלת החשבונות, ומאזן בוחן.', since: '1.10.0' },
    { t: 'ledger-range', title: 'תקופה', text: 'בוחרים תאריכים. יתרת הפתיחה מחושבת מכל מה שלפני התקופה. מכאן גם מדפיסים, מייצאים לאקסל ושולחים ללקוח.', since: '1.10.0' },
    { t: 'ledger-list', title: 'בחירה', text: 'הרשימה ממוינת לפי גובה היתרה. באדום: מי שחייב לך.', since: '1.10.0' },
    { t: 'ledger-tb', title: 'מאזן בוחן', text: 'כל החשבונות, חובה וזכות בתקופה, ובדיקה שהכול מאוזן. לחיצה על חשבון פותחת את הכרטסת שלו.', since: '1.10.0' },
    { t: 'ledger-table', title: 'התנועות', text: 'חשבוניות בחובה, קבלות וזיכויים בזכות, ויתרה מצטברת בכל שורה. כולל מסמכים שיובאו מ-iCount.', since: '1.10.0' },
  ],
  income: [
    { t: 'inc-filters', title: 'הכנסות', text: 'סינון לפי חודש, חיפוש וייצוא לאקסל. בעסק שמחובר לחנות, הזמנות ששולמו נכנסות לכאן לבד.', since: '1.0.0' },
    { t: 'inc-table', title: 'הרשימה', text: 'כל הכנסה עם תאריך, לקוח, מסמך ומע״מ.', since: '1.0.0' },
  ],
  expenses: [
    { t: 'exp-inbox', title: 'חשבוניות מהמייל', text: 'חשבוניות ספקים שהגיעו ל-Gmail ממתינות כאן. "רשום כהוצאה" קורא את הקובץ וממלא סכום, מע״מ, תאריך וספק. בפעם הראשונה: "חבר את Gmail".', since: '1.19.0' },
    { t: 'exp-recurring', title: 'הוצאות קבועות', text: 'מגדירים פעם אחת (או מדביקים רשימה), וכל חודש ההוצאה נרשמת לבד ביום שלה. אפשר להשהות או לעצור בכל רגע.', since: '1.23.0' },
    { t: 'exp-filters', title: 'הוצאות', text: 'סינון לפי חודש וקטגוריה, וייצוא לאקסל.', since: '1.0.0' },
    { t: 'exp-table', title: 'הרשימה', text: 'כל הוצאה עם ספק, קטגוריה ומע״מ מוכר. הסכומים נכנסים לדוח המע״מ ולרווח והפסד.', since: '1.0.0' },
  ],
  suppliers: [
    { t: 'sup-new', title: 'ספק חדש', text: 'שם, ח.פ., קטגוריה ופרטי קשר. ההוצאות מקושרות לספק.', since: '1.0.0', roles: ['owner'] },
    { t: 'sup-table', title: 'הספקים', text: 'כמה שולם לכל ספק השנה.', since: '1.0.0' },
  ],
  bank: [
    { t: 'bank-tools', title: 'דף בנק', text: 'מורידים מהבנק CSV ומעלים כאן. "התאמה אוטומטית" מחפשת הכנסה או הוצאה באותו סכום, עד שבוע מהתאריך.', since: '1.0.0', roles: ['owner'] },
    { t: 'bank-stats', title: 'המצב', text: 'כמה שורות מותאמות וכמה עוד פתוחות.', since: '1.0.0' },
    { t: 'bank-table', title: 'השורות', text: 'שורה שלא הותאמה לבד מתאימים ידנית.', since: '1.0.0' },
  ],
  vat: [
    { t: 'vat-period', title: 'תקופת הדיווח', text: 'חודשי או דו-חודשי, ובחירת התקופה. מכאן גם יוצא הדוח לרואה החשבון.', since: '1.0.0' },
    { t: 'vat-stats', title: 'לדיווח', text: 'עסקאות, מע״מ עסקאות, תשומות ומע״מ לתשלום. אלה המספרים שממלאים בדיווח.', since: '1.0.0' },
  ],
  paypages: [
    { t: 'paypages', title: 'דפי סליקה', text: 'כל דפי הסליקה: ממתינים, שולמו, ודף חדש. אם עוד לא מוגדר ספק סליקה (זד קרדיט או יופיי), כאן כתוב מה חסר וכפתור להגדרה.', since: '1.29.2' },
  ],
  bset: [
    { t: 'bset', title: 'הגדרות העסק', text: 'כל מה שהעסק מחובר אליו, במקום אחד: ✓ מה מוגדר, ומה חסר. לחיצה על שורה פותחת אותה ומגדירה במקום.', since: '1.27.0' },
  ],
  pay: [
    { t: 'pay-auth', title: 'לתשלום לרשויות', text: 'כמה מגיע למע״מ, למס הכנסה ולביטוח לאומי בכל תקופה, וההשוואה מול מה שרואה החשבון שלח.', since: '1.26.0' },
  ],
  pnl: [
    { t: 'tax-forecast', title: 'צפי מס הכנסה', text: 'כמה מס הכנסה, ביטוח לאומי ומס בריאות צפויים השנה לפי הרווח עד עכשיו, כמה להפריש כל חודש, וכמה נותר אחרי מקדמות. הערכה בלבד.', since: '1.22.0' },
    { t: 'pnl-range', title: 'טווח', text: 'בוחרים מחודש עד חודש, ומייצאים את הדוח ואת כל התנועות לרואה החשבון.', since: '1.0.0' },
    { t: 'pnl-cards', title: 'רווח והפסד', text: 'תמצית התקופה, הכנסות והוצאות לפי קטגוריה.', since: '1.0.0' },
  ],
  tax: [
    { t: 'tax-export', title: 'מבנה אחיד', text: 'INI.TXT ו-BKMVDATA.TXT לפי הוראה 1.31: הקובץ שמבקר מס מבקש, וגם מה שמעבירים לרואה החשבון.', since: '1.3.0' },
    { t: 'tax-register', title: 'רישום התוכנה', text: 'חמשת השלבים לרישום התוכנה ברשות המסים, והמקום לרשום את מספר הרישום שמתקבל.', since: '1.3.0' },
    { t: 'tax-log', title: 'יומן פעולות', text: 'כל הפקה, הדפסה, שליחה וייצוא נרשמים כאן, ואי אפשר למחוק.', since: '1.3.0' },
  ],
  export: [
    { t: 'exp-range', title: 'תקופה', text: 'בוחרים פעם אחת את התקופה (החודש, דו-חודש, שנה, הכול או טווח), וכל הייצואים כאן לפיה.', since: '1.31.0' },
    { t: 'exp-excel', title: 'Excel מלא', text: 'קובץ אחד עם גיליון לכל רשימה, כולל פקודות יומן ומאזן בוחן.', since: '1.31.0' },
    { t: 'exp-pack', title: 'חבילה לרואה החשבון', text: 'ZIP אחד: Excel, CSV לכל רשימה ומבנה אחיד. שולחים אותו כמו שהוא.', since: '1.31.0' },
    { t: 'exp-unified', title: 'מבנה אחיד', text: 'הקובץ הרשמי של רשות המסים, שכל תוכנה רשומה יודעת לקלוט.', since: '1.31.0' },
    { t: 'exp-csv', title: 'CSV', text: 'כל רשימה בנפרד, לגוגל שיטס או לתוכנה אחרת.', since: '1.31.0' },
    { t: 'exp-backup', title: 'גיבוי', text: 'כל הרשומות של העסק בקובץ שאפשר לשחזר ממנו.', since: '1.31.0' },
  ],
  import: [
    { t: 'imp-icount-live', title: 'חיבור ישיר ל-iCount', text: 'מפתח API מ-iCount, והמסמכים נמשכים לכאן בלי קבצים. אפשר גם שמסמכים חדשים ייכנסו לבד כל יום.', since: '1.15.0' },
    { t: 'imp-icount', title: 'ייבוא מ-iCount', text: 'מעלים את קובצי המבנה האחיד מ-iCount. המסמכים נשמרים כמו שהם, והזמנות שכבר בחנות לא נספרות פעמיים.', since: '1.4.0' },
    { t: 'imp-erp', title: 'המערכת הישנה', text: 'העתקת הכנסות, הוצאות וספקים מה-ERP הקודם.', since: '1.0.0' },
    { t: 'imp-danger', title: 'מחיקת העסק', text: 'מוחקת את הספר ואת כל הרשומות שלו. אי אפשר למחוק עסק שהופקו בו מסמכים אמיתיים.', since: '1.0.0' },
  ],
  settings: [
    { t: 'set-backup', title: 'גיבוי', text: 'קובץ אחד עם כל העסקים. משחזרים ממנו בכל מחשב.', since: '1.0.0' },
    { t: 'set-cloud', title: 'ענן', text: 'עם הענן הנתונים מאחורי כניסה, בכל מכשיר, ומסמכים אמיתיים אפשריים.', since: '1.0.0' },
    { t: 'set-sign', title: 'חתימה דיגיטלית', text: 'מעלים את תעודת החתימה פעם אחת. מאז כל PDF נחתם, ואפשר לשלוח אותו במייל ישירות.', since: '1.3.0' },
    { t: 'set-store', title: 'החנות', text: 'חיבור לקריאה בלבד: הזמנות ששולמו ומספרי חשבוניות.', since: '1.1.0' },
    { t: 'set-store', title: 'חיבור קבוע', text: 'מתחברים לחנות פעם אחת, והחיבור עובד בכל המכשירים דרך השרת. הסיסמה לא נשמרת.', since: '1.11.0' },
    { t: 'set-ita', title: 'רשות המסים', text: 'מתחברים פעם בשלושה חודשים, ומספרי ההקצאה מתבקשים אוטומטית.', since: '1.7.0' },
    { t: 'set-pay', title: 'דפי סליקה', text: 'מפתח השירות של Firebase, ולכל עסק מפתח זד קרדיט ו/או אימייל חשבון יופיי. מגדירים פעם אחת. בזד קרדיט החשבונית יוצאת לבד; ביופיי בלי מפתח מאשרים בלחיצה.', since: '1.28.0' },
    { t: 'set-pin', title: 'נעילה בקוד', text: 'קוד לפתיחת המערכת, אותו קוד בכל המכשירים. ננעל לבד אחרי 15 דקות בלי פעילות.', since: '1.7.0' },
    { t: 'set-archive', title: 'ארכיון חודשי', text: 'קבצי מבנה אחיד וגיבוי לכל חודש, במקום אחד.', since: '1.7.0' },
  ],
  users: [
    { t: 'users-add', title: 'הוספת משתמש', text: 'אימייל, עסק ותפקיד. המשתמש נרשם עם "משתמש חדש" באותו אימייל.', since: '1.7.0' },
    { t: 'users-table', title: 'מי רואה מה', text: 'בעלים עושה הכול. מפיק מסמכים רואה רק מסמכים ולקוחות. צופה רק רואה.', since: '1.7.0' },
  ],
  help: [
    { t: 'help-list', title: 'כל ההדרכות', text: 'לכל מסך סיור משלו. "הצג" פותח את המסך ומריץ את הסיור.', since: '1.8.0' },
    { t: 'help-auto', title: 'הדרכה אוטומטית', text: 'אפשר לכבות את ההדרכות שרצות לבד, או להפעיל את כולן מחדש.', since: '1.8.0' },
    { t: 'help-changes', title: 'מה השתנה', text: 'כל הגרסאות והשינויים שבהן.', since: '1.8.0' },
  ],
};

const tourAnchor = (t) => document.querySelector(`[data-tour="${t}"]`);
const tourVisible = (t) => { const el = tourAnchor(t); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth; };
/* The steps that can run now: allowed for this role, on screen, and — when
   the screen was seen before — newer than that visit. */
function tourSteps(ctx, role, seen) {
  return (TOURS[ctx] || [])
    .filter(s => (!s.roles || s.roles.includes(role)) && (!seen || verCmp(s.since, seen) > 0) && (!s.t || tourVisible(s.t)))
    .map(s => ({ ...s, isNew: !!seen }));
}
const tourState = () => lsGet(TOUR_KEY, {});
const tourMark = (ctx) => { try { lsSet(TOUR_KEY, { ...tourState(), [ctx]: VERSION }); } catch { /* private mode */ } };
const tourPending = (ctx, role) => {
  const seen = tourState()[ctx];
  return !!seen && (TOURS[ctx] || []).some(s => (!s.roles || s.roles.includes(role)) && verCmp(s.since, seen) > 0);
};

function TourOverlay({ ctx, steps, auto, onDone, onOff }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [cardH, setCardH] = useState(190);
  const cardRef = useRef(null);
  const step = steps[i];
  const last = i === steps.length - 1;
  const next = () => (last ? onDone() : setI(i + 1));
  const back = () => i > 0 && setI(i - 1);

  useEffect(() => {
    const el = step.t && tourAnchor(step.t);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    let raf, prev = '';
    const tick = () => {
      const e = step.t && tourAnchor(step.t);
      const r = e ? e.getBoundingClientRect() : null;
      const key = r ? [r.top, r.left, r.width, r.height].map(Math.round).join() : '';
      if (key !== prev) { prev = key; setRect(r && r.width ? { top: r.top, left: r.left, width: r.width, height: r.height } : null); }
      if (cardRef.current) { const h = cardRef.current.offsetHeight; setCardH(p => (p === h ? p : h)); }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onDone();
      else if (e.key === 'ArrowLeft' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  useEffect(() => { cardRef.current?.querySelector('.tour-next')?.focus({ preventScroll: true }); }, [i]);

  const vw = window.innerWidth, vh = window.innerHeight, pad = 6, W = Math.min(360, vw - 24);
  let pos;
  if (rect) {
    const below = rect.top + rect.height + pad + 12, above = rect.top - pad - 12 - cardH;
    const alignRight = Math.min(Math.max(8, vw - (rect.left + rect.width)), vw - W - 8);
    const midTop = Math.min(Math.max(8, rect.top + 10), vh - cardH - 8);
    if (below + cardH < vh - 8) pos = { top: below, right: alignRight, width: W };
    else if (above >= 8) pos = { top: above, right: alignRight, width: W };
    // A tall element: beside it when there is room, otherwise at the bottom of the screen.
    else if (rect.left - pad - 12 >= W + 8) pos = { top: midTop, right: vw - rect.left + pad + 12, width: W };
    else if (vw - rect.left - rect.width - pad - 12 >= W + 8) pos = { top: midTop, right: vw - (rect.left + rect.width + pad + 12) - W, width: W };
    else pos = { top: Math.max(8, vh - cardH - 12), right: (vw - W) / 2, width: W };
  } else pos = { top: Math.max(8, (vh - cardH) / 2), right: (vw - W) / 2, width: W };

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={'הדרכה · ' + (TOUR_CTX[ctx] || '')}>
      <div className="tour-block" onClick={e => e.stopPropagation()} style={rect ? { background: 'transparent' } : null} />
      {rect && <div className="tour-spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />}
      <div className="tour-card" ref={cardRef} style={pos}>
        <div className="tour-top">
          <span>{TOUR_CTX[ctx]} · {i + 1}/{steps.length}</span>
          {step.isNew && <span className="mg-chip ok">חדש בגרסה {step.since}</span>}
          <button className="tour-x" aria-label="סגור" onClick={onDone}>✕</button>
        </div>
        <h4>{step.title}</h4>
        <p>{step.text}</p>
        <div className="tour-dots">{steps.map((_, j) => <i key={j} className={j === i ? 'on' : ''} />)}</div>
        <div className="tour-nav">
          <button className="mg-btn sm tour-next" onClick={next}>{last ? 'סיום' : 'הבא ←'}</button>
          {i > 0 && <button className="mg-btn ghost sm" onClick={back}>→ הקודם</button>}
          {auto && <button className="tour-off" onClick={onOff}>לא להציג הדרכות לבד</button>}
        </div>
      </div>
    </div>
  );
}

function WhatsNew({ since, onClose, onHelp }) {
  const list = CHANGES.filter(c => verCmp(c.v, since) > 0);
  return (
    <div className="mg-mod" onClick={onClose}>
      <div className="mg-card tour-news" onClick={e => e.stopPropagation()} role="dialog" aria-label="מה חדש">
        <h3 style={{ marginTop: 0 }}>מה חדש בגרסה {VERSION}</h3>
        {list.map(c => (
          <div key={c.v} style={{ marginBottom: 10 }}>
            {list.length > 1 && <b>גרסה {c.v}</b>}
            <ul style={{ margin: '4px 0', paddingInlineStart: 20, lineHeight: 1.8 }}>{c.items.map((x, j) => <li key={j}>{x}</li>)}</ul>
          </div>
        ))}
        <p className="mg-note" style={{ margin: '10px 0' }}>בכל מסך שהשתנה תופיע הדרכה קצרה על מה שחדש בו.</p>
        <div style={row}>
          <button className="mg-btn" onClick={onClose}>הבנתי</button>
          <button className="mg-btn ghost" onClick={onHelp}>למדריך</button>
        </div>
      </div>
    </div>
  );
}

function HelpView({ role, clerkOnly, onStart, flash }) {
  const [st, setSt] = useState(tourState);
  const ctxs = Object.keys(TOURS).filter(c => c !== 'help' && (!clerkOnly || ['docs', 'customers', 'items', 'help'].includes(c)));
  const setAll = (v) => { try { lsSet(TOUR_KEY, v); } catch { /* ignore */ } setSt(v); };
  return (
    <>
      <div className="mg-h" style={{ '--h1': '#8a6331', '--h2': '#c4a36e' }}>
        <div><h2>מדריך</h2><div className="sub">גרסה {VERSION} · סיור לכל מסך, ומה השתנה בכל גרסה</div></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(320px,100%),1fr))', gap: 16 }}>
        <div data-tour="help-list" className="mg-card">
          <h3 style={{ marginTop: 0 }}>ההדרכות</h3>
          <table className="mg-tbl"><tbody>
            {ctxs.map(c => {
              const steps = TOURS[c].filter(s => !s.roles || s.roles.includes(role));
              const seen = st[c];
              const fresh = seen && steps.some(s => verCmp(s.since, seen) > 0);
              return (
                <tr key={c}>
                  <td><b>{TOUR_CTX[c]}</b> {fresh && <span className="mg-chip ok">חדש</span>}
                    {!seen && <span className="mg-chip">טרם נצפה</span>}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{steps.length} שלבים</td>
                  <td style={{ textAlign: 'left' }}><button className="mg-btn ghost sm keep" onClick={() => onStart(c)}>הצג</button></td>
                </tr>
              );
            })}
          </tbody></table>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div data-tour="help-auto" className="mg-card">
            <h3 style={{ marginTop: 0 }}>הדרכה אוטומטית</h3>
            <p style={{ marginTop: 0, fontSize: 14 }}>כשנכנסים למסך בפעם הראשונה, ההדרכה שלו רצה לבד. אחרי עדכון היא מציגה רק את מה שחדש.</p>
            <div style={row}>
              {st.off
                ? <button className="mg-btn sm keep" onClick={() => { setAll({ ...st, off: false }); flash('ההדרכות האוטומטיות הופעלו'); }}>הפעל הדרכות לבד</button>
                : <button className="mg-btn ghost sm keep" onClick={() => { setAll({ ...st, off: true }); flash('ההדרכות לא ירוצו לבד. הכפתור "?" עדיין זמין'); }}>כבה הדרכות לבד</button>}
              <button className="mg-btn ghost sm keep" onClick={() => { setAll({ off: false }); flash('כל ההדרכות יוצגו שוב'); }}>הצג שוב את כולן</button>
            </div>
          </div>
          <div data-tour="help-changes" className="mg-card">
            <h3 style={{ marginTop: 0 }}>מה השתנה</h3>
            {CHANGES.map(c => (
              <div key={c.v} style={{ marginBottom: 10 }}>
                <b>גרסה {c.v}</b>{c.date && <span style={{ color: 'var(--muted)', fontSize: 13 }}> · {c.date}</span>}
                <ul style={{ margin: '4px 0', paddingInlineStart: 20, lineHeight: 1.7, fontSize: 14 }}>{c.items.map((x, j) => <li key={j}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function App() {
  const [user, setUser] = useState(cloud ? undefined : LOCAL_USER);
  const [books, setBooks] = useState(null);
  const [cur, setCur] = useState('all');
  const [datas, setDatas] = useState({});
  const [loading, setLoading] = useState({});
  const [msg, setMsg] = useState('');
  const [bookForm, setBookForm] = useState(null);
  const [booksErr, setBooksErr] = useState('');
  const [storeLogin, setStoreLogin] = useState(false);
  const [storeTick, setStoreTick] = useState(0);
  const [server, setServer] = useState(null);
  const [locked, setLocked] = useState(() => !!lsGet(PIN_KEY, null) && sessionStorage.getItem(UNLOCK_KEY) !== '1');
  /* After 15 idle minutes, while a code is set (it may be set or removed during the session). */
  useEffect(() => {
    let t; const reset = () => { clearTimeout(t); t = setTimeout(() => { if (!lsGet(PIN_KEY, null)) return; sessionStorage.removeItem(UNLOCK_KEY); setLocked(true); }, 15 * 60000); };
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev => window.addEventListener(ev, reset));
    reset();
    return () => { clearTimeout(t); ['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev => window.removeEventListener(ev, reset)); };
  }, [locked]);
  useEffect(() => { serverStatus().then(setServer); }, []);
  /* Back from the Tax Authority's consent page. */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search); const r = q.get('ita');
    if (!r) return;
    setTimeout(() => flash(r === 'ok' ? 'החיבור לרשות המסים הצליח. מספרי הקצאה יתבקשו אוטומטית.' : 'החיבור לרשות המסים נכשל · ' + (q.get('m') || '')), 800);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  /* Guided tours: which screen is showing, and whether its tour should run. */
  const [bookTab, setBookTab] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  /* On a computer the side bar can fold to a narrow strip of icons; remembered on this device. */
  const [mini, setMini] = useState(() => { try { return localStorage.getItem('tzbooks_side_mini') === '1'; } catch { return false; } });
  const toggleMini = () => setMini(m => { try { localStorage.setItem('tzbooks_side_mini', m ? '0' : '1'); } catch {} return !m; });
  const ini = (n) => String(n || '?').trim().replace(/^[^\p{L}\d]+/u, '').slice(0, 1) || '•';
  const [tabReq, setTabReq] = useState(null);
  const [tour, setTour] = useState(null);
  const [tourWant, setTourWant] = useState(null);
  const [news, setNews] = useState(() => {
    const seen = lsGet(SEEN_KEY, null);
    // Someone who used an earlier version has data or settings saved already.
    const before = seen || (lsGet(LOCAL_KEY, null) || lsGet(CLOUD_KEY, null) || lsGet(BACKUP_KEY, null) ? '1.7.0' : null);
    if (!before) { try { lsSet(SEEN_KEY, VERSION); } catch { /* ignore */ } return null; }
    return verCmp(VERSION, before) > 0 ? before : null;
  });
  const closeNews = () => { try { lsSet(SEEN_KEY, VERSION); } catch { /* ignore */ } setNews(null); };
  const flashT = useRef(null);
  const migrating = useRef(new Set());
  const flash = (m) => { setMsg(m); clearTimeout(flashT.current); flashT.current = setTimeout(() => setMsg(''), 4200); };

  useEffect(() => {
    if (!cloud) return;
    return onAuthStateChanged(cloud.auth, u => { setUser(u || null); if (!u) { prefUid = null; setBooks(null); setDatas({}); } });
  }, []);
  /* The user's settings from the cloud, before the screens read them. */
  const [prefsReady, setPrefsReady] = useState(!cloud);
  useEffect(() => {
    if (!cloud || !user) return;
    setPrefsReady(false);
    prefPull(user).finally(() => {
      const seen = lsGet(SEEN_KEY, null);
      if (seen) setNews(verCmp(VERSION, seen) > 0 ? seen : null);
      /* Signed in again with the password after "forgot the code": the lock goes. */
      if (sessionStorage.getItem(PIN_RESET_KEY) === '1') { sessionStorage.removeItem(PIN_RESET_KEY); lsDel(PIN_KEY); sessionStorage.setItem(UNLOCK_KEY, '1'); setLocked(false); setTimeout(() => flash('הנעילה בוטלה. אפשר לקבוע קוד חדש בגיבוי וענן'), 500); }
      else if (lsGet(PIN_KEY, null) && sessionStorage.getItem(UNLOCK_KEY) !== '1') setLocked(true);
      setPrefsReady(true);
    });
  }, [user?.uid]);

  const sortBooks = (b) => [...b].sort((x, y) => (x.order ?? 99) - (y.order ?? 99) || (x.name || '').localeCompare(y.name || '', 'he'));
  const refreshBooks = async () => {
    try {
      const b = sortBooks(await withTimeout(listBooks(user.email)));
      setBooks(b); setBooksErr('');
      if (!['all', 'settings', 'users'].includes(cur) && !b.some(x => x.id === cur)) setCur('all');
    } catch (e) {
      setBooks([]);
      setBooksErr(String(e?.code || e?.message || '').includes('permission')
        ? 'אין הרשאה לקרוא את העסקים. צריך לפרסם בפרויקט ה-Firebase את קובץ החוקים שמגיע עם המערכת.'
        : 'לא הצלחתי לטעון את העסקים. בדוק את החיבור.');
    }
  };
  useEffect(() => { if (user) refreshBooks(); }, [user]);

  const sending = useRef({});
  /* Once a week, a backup of every book I own to my own inbox — when the
     cloud and the mail function are both there. */
  useEffect(() => {
    if (!prefsReady || !cloud || !user || !server?.mail || !books?.some(b => (b.owners || []).includes(user.email.toLowerCase()))) return;
    const last = lsGet('tzbooks_autobk', null);
    if (last && Date.now() - Date.parse(last) < 7 * 86400000) return;
    if (sending.current.backup) return;
    sending.current.backup = true;
    (async () => {
      try {
        const data = await exportAll(user.email);
        data.books = data.books.filter(b => (b.owners || []).includes(user.email.toLowerCase()));
        await fnCall({ action: 'backup', data: JSON.stringify(data), filename: `tizon-books-backup-${todayIso()}.json` });
        lsSet('tzbooks_autobk', new Date().toISOString()); lsSet(BACKUP_KEY, new Date().toISOString());
        flash('גיבוי שבועי נשלח למייל שלך');
      } catch (e) { console.warn('auto backup', e); }
      sending.current.backup = false;
    })();
  }, [books, server, prefsReady]);

  useEffect(() => {
    if (!prefsReady || !cloud || !user || !server?.mail || !books?.length) return;
    const mine = books.filter(b => (b.owners || []).includes(user.email.toLowerCase()));
    const prev = addMonths(thisMonth(), -1);
    if (!mine.length || lsGet(ARCH_KEY, '') === prev || sending.current.archive) return;
    sending.current.archive = true;
    (async () => {
      try {
        const { zip, lines } = await makeArchive(mine, prev, user.email);
        await fnCall({ action: 'archive', subject: `Tizon Books · ארכיון ${prev}`, text: `ארכיון חודשי ל-${prev}:\n${lines.join('\n')}`,
                       files: [{ name: `tizon-books-archive-${prev}.zip`, b64: b64(zip), type: 'application/zip' }] });
        lsSet(ARCH_KEY, prev);
        for (const b of mine) await logAct(b.id, { action: 'archive', title: `${prev} נשלח ל-${user.email}`, series: 'live' });
        flash(`ארכיון ${prev} נשלח למייל`);
      } catch (e) { console.warn('archive', e); }
      sending.current.archive = false;
    })();
  }, [books, server, prefsReady]);

  const ensure = async (book, force) => {
    if (!force && (datas[book.id] || loading[book.id])) return;
    setLoading(l => ({ ...l, [book.id]: true }));
    const histP = loadHistory(book), storeP = loadStore(book);
    const since = new Date(Date.now() - 2000).toISOString();
    const d0 = await loadCore(book);
    /* A reload never takes back what was saved on screen while it was reading. */
    const fresh = (x) => { const cur = x[book.id]; if (!force || !cur) return d0; const d = { ...d0 };
      CORE.forEach(c => { const mine = (cur[c] || []).filter(r => !r._arch && String(r.updatedAt || r.createdAt || '') >= since); if (!mine.length) return;
        const by = new Map((d[c] || []).map(r => [r.id, r]));
        mine.forEach(r => { const o = by.get(r.id); if (!o || String(o.updatedAt || o.createdAt || '') < String(r.updatedAt || r.createdAt || '')) by.set(r.id, r); });
        d[c] = [...by.values()]; });
      return d; };
    let d = d0;
    setDatas(x => { d = fresh(x); return { ...x, [book.id]: force && x[book.id] ? { ...x[book.id], ...d, histPending: false,
      documents: [...d.documents, ...(x[book.id].documents || []).filter(z => z._arch && !d.documents.some(y => y.id === z.id))],
      archive: x[book.id].archive || [], orders: x[book.id].orders || [], docs: x[book.id].docs || [], storePending: d.storePending && !x[book.id].storeAt,
      storeAt: x[book.id].storeAt, storeErr: x[book.id].storeErr, storeLogin: x[book.id].storeLogin } : d }; });
    setLoading(l => ({ ...l, [book.id]: false }));
    histP.then(h => setDatas(x => x[book.id] ? { ...x, [book.id]: withHistory(x[book.id], h) } : x));
    storeP.then(st => setDatas(x => x[book.id] ? { ...x, [book.id]: { ...x[book.id], ...st } } : x));
    /* Once: imported history kept one record per document moves into the pack. */
    const loose = (d.documents || []).filter(z => z.series === 'import' && !z._arch).length;
    if (loose >= 20 && !migrating.current.has(book.id) && (!cloud || roleOf(book, user?.email || '') === 'owner')) {
      migrating.current.add(book.id);
      flash(`מארגן ${loose} מסמכים היסטוריים של "${book.name}" כדי שהמערכת תטען מהר יותר…`);
      try { const n = await archiveMigrate(book, d); if (n) { flash(`הסתיים: ${n} מסמכים היסטוריים נארזו. מעכשיו העסק נטען מהר ובזול.`); ensure(book, true); } }
      catch (e) { console.warn('archive', e); migrating.current.delete(book.id); }
    }
  };
  useEffect(() => {
    if (!books) return;
    if (cur === 'all') books.forEach(b => ensure(b));
    else { const b = books.find(x => x.id === cur); if (b) ensure(b); }
  }, [cur, books]);

  /* After signing in to the store, or out: read every linked book again. */
  const reloadLinked = () => (books || []).filter(b => b.tenant).forEach(b => ensure(b, true));

  const patch = (bookId) => (name, fn) =>
    setDatas(d => ({ ...d, [bookId]: { ...d[bookId], [name]: fn(d[bookId]?.[name] || []) } }));

  const saveBook = async (b) => {
    const owners = cloud
      ? [...new Set([user.email.toLowerCase(), ...(b.owners || []).map(x => String(x).trim().toLowerCase()).filter(x => x.includes('@'))])]
      : (b.owners || []);
    const rec = clean({ ...b, owners, name: b.name.trim(), updatedAt: new Date().toISOString() });
    try { await withTimeout(putBook(rec)); }
    catch (e) { flash('שמירת העסק נכשלה · ' + (e?.code || e?.message || '')); return false; }
    const was = books.find(x => x.id === rec.id);
    setBooks(bs => sortBooks([...bs.filter(x => x.id !== rec.id), rec]));
    if (!was && !rec.tenant) setDatas(x => ({ ...x, [rec.id]: { errors: [], orders: [], docs: [], storeErr: '', storeLogin: false, incomes: [], expenses: [], suppliers: [], banktx: [] } }));
    else if (!was || (was.tenant || '') !== (rec.tenant || '')) ensure(rec, true);
    flash('העסק נשמר');
    return true;
  };

  const deleteBook = async (b) => {
    const docsNow = datas[b.id]?.documents || await bookCol(b.id, 'documents').list().catch(() => []);
    if (docsNow.some(d => d.series === 'live')) { flash('אי אפשר למחוק עסק שהופקו בו מסמכים אמיתיים. מסמכי מס נשמרים שבע שנים.'); return; }
    if (!window.confirm(`למחוק את "${b.name}" עם כל ההכנסות, ההוצאות, הספקים ושורות הבנק שלו? אי אפשר לשחזר.`)) return;
    if (window.prompt('כדי לאשר, הקלד את שם העסק:') !== b.name) { flash('המחיקה בוטלה'); return; }
    try {
      for (const c of COLS) {
        const list = await bookCol(b.id, c).list();
        for (const r of list) await bookCol(b.id, c).del(r.id).catch(e => { if (c !== 'payreqs') throw e; });
      }
      await delBook(b.id);
      setBooks(bs => bs.filter(x => x.id !== b.id)); setCur('all'); flash('העסק נמחק');
    } catch (e) { flash('המחיקה נכשלה · ' + (e?.code || '')); }
  };

  const tourBook = books?.find(b => b.id === cur);
  const tourRole = tourBook && user ? roleOf(tourBook, user.email) : (user && (books || []).length && (books || []).every(b => roleOf(b, user.email) === 'clerk') ? 'clerk' : 'owner');
  const tourCtx = !user || !prefsReady || locked || !books ? null
    : cur === 'settings' || cur === 'users' || cur === 'help' ? cur
    : !books.length ? 'welcome'
    : cur === 'all' ? 'all'
    : tourBook && datas[tourBook.id] && BOOK_CTX.includes(bookTab) ? bookTab : null;
  const tourBusy = !!(tour || news || bookForm || storeLogin);
  useEffect(() => {
    if (!tourCtx || tourBusy) return;
    const want = tourWant === tourCtx;
    const t = setTimeout(() => {
      if (want) {
        setTourWant(null);
        const steps = tourSteps(tourCtx, tourRole, null);
        if (steps.length) setTour({ ctx: tourCtx, steps, auto: false }); else flash('אין הדרכה זמינה למסך הזה');
        return;
      }
      const st = tourState();
      if (st.off) return;
      const steps = tourSteps(tourCtx, tourRole, st[tourCtx]);
      if (steps.length) setTour({ ctx: tourCtx, steps, auto: true });
      else if (st[tourCtx] !== VERSION) tourMark(tourCtx);
    }, want ? 500 : 900);
    return () => clearTimeout(t);
  }, [tourCtx, tourBusy, tourWant, tourRole]);
  const startTour = (ctx) => {
    if (!BOOK_CTX.includes(ctx)) { setCur(ctx === 'welcome' && books?.length ? 'all' : ctx); setTourWant(ctx === 'welcome' && books?.length ? 'all' : ctx); return; }
    const pick = [tourBook, ...(books || [])].find(b => b && (roleOf(b, user.email) !== 'clerk' || ['docs', 'customers', 'items'].includes(ctx))
      && (roleOf(b, user.email) !== 'viewer' || ctx !== 'import'));
    if (!pick) { flash('כדי לראות את ההדרכה הזו צריך קודם עסק'); return; }
    setCur(pick.id); setTabReq({ book: pick.id, k: ctx }); setTourWant(ctx);
  };

  if (user === undefined) return <div className="login"><div style={{ color: 'var(--gold)' }}>טוען…</div></div>;
  if (!user) return <Login />;
  if (!prefsReady) return <div className="login"><div style={{ color: 'var(--gold)' }}>טוען את ההגדרות…</div></div>;
  if (locked) return <LockScreen who={cloud ? user.email : ''} onUnlock={() => setLocked(false)} />;

  const book = books?.find(b => b.id === cur);
  const lastBackup = lsGet(BACKUP_KEY, null);
  const stale = !cloud && books?.length > 0 && (!lastBackup || Date.now() - Date.parse(lastBackup) > 7 * 86400000);

  return (
    <div className="shell">
      {/* Phones and small tablets: a top bar, and the menu as a drawer. */}
      <header className="topbar">
        <button className="tb-menu" aria-label="תפריט" onClick={() => setNavOpen(true)}><span /><span /><span /></button>
        <b className="tb-title">{book ? book.name : ({ all: 'כל העסקים', settings: 'גיבוי וענן', users: 'משתמשים והרשאות', help: 'מדריך' })[cur] || 'Tizon Books'}</b>
        <img className="tb-mark" src={MARK} alt="Tizon" />
      </header>
      {navOpen && <div className="side-dim" onClick={() => setNavOpen(false)} />}
      <aside className={'side' + (navOpen ? ' open' : '') + (mini ? ' mini' : '')} onClickCapture={e => { if (e.target.closest('button.bk')) setTimeout(() => setNavOpen(false), 0); }}>
        <div className="brand">
          <img className="mark" src={MARK} alt="Tizon" />
          <span className="brand-t"><b>Tizon Books</b><small>הנהלת חשבונות</small></span>
          <button className="side-fold" onClick={toggleMini} title={mini ? 'הרחב את התפריט' : 'כווץ את התפריט'} aria-label={mini ? 'הרחב את התפריט' : 'כווץ את התפריט'}>{mini ? '«' : '»'}</button>
        </div>
        <button className={'bk' + (cur === 'all' ? ' on' : '')} onClick={() => setCur('all')} title="כל העסקים">
          <span className="ic">▦</span><span className="lbl">כל העסקים</span></button>
        <div data-tour="side-books" className="sec">העסקים</div>
        {(books || []).map(b => (
          <button key={b.id} className={'bk' + (cur === b.id ? ' on' : '')} onClick={() => setCur(b.id)} title={b.name}>
            <span className="ic bk-ini" style={{ background: b.color || '#2f7d5b' }}>{ini(b.name)}</span><span className="lbl">{b.name}</span>
          </button>
        ))}
        <button data-tour="side-new" className="bk" onClick={() => setBookForm({})} style={{ color: 'var(--gold)', fontWeight: 700 }} title="עסק חדש"><span className="ic">＋</span><span className="lbl">עסק חדש</span></button>
        <div className="sec">כללי</div>
        {cloud && (books || []).some(b => roleOf(b, user.email) === 'owner') && (
          <button data-tour="side-users" className={'bk' + (cur === 'users' ? ' on' : '')} onClick={() => setCur('users')} title="משתמשים והרשאות">
            <span className="ic">👥</span><span className="lbl">משתמשים והרשאות</span></button>)}
        <button data-tour="side-settings" className={'bk' + (cur === 'settings' ? ' on' : '')} onClick={() => setCur('settings')} title="גיבוי וענן">
          <span className="ic">{cloud ? '☁️' : '💾'}</span><span className="lbl">גיבוי וענן</span></button>
        <button data-tour="side-help" className={'bk' + (cur === 'help' ? ' on' : '')} onClick={() => setCur('help')} title="מדריך">
          <span className="ic">📖</span><span className="lbl">מדריך</span></button>
        <div className="foot">
          <small className="lbl">{cloud ? user.email : 'נשמר במחשב הזה'}</small>
          <div className="foot-a">
            <button onClick={() => { setDatas({}); refreshBooks(); }} title="רענון">↻<span className="lbl"> רענון</span></button>
            {cloud && <button onClick={() => signOut(cloud.auth)} title="יציאה">⎋<span className="lbl"> יציאה</span></button>}
            {lsGet(PIN_KEY, null) && <button onClick={() => { sessionStorage.removeItem(UNLOCK_KEY); setLocked(true); }} title="נעל">🔒<span className="lbl"> נעל</span></button>}
          </div>
          <small className="lbl" style={{ opacity: .6 }}>גרסה {VERSION}</small>
        </div>
      </aside>

      <main className="main">
        {booksErr && <div className="mg-note bad" style={{ marginBottom: 14 }}>{booksErr}</div>}
        {stale && cur !== 'settings' && (
          <div className="mg-note warn" style={{ marginBottom: 14 }}>
            הנתונים שמורים רק בדפדפן הזה{lastBackup ? `, והגיבוי האחרון נעשה ב-${heDate(lastBackup.slice(0, 10))}` : ' ועדיין לא נעשה גיבוי'}.{' '}
            <button className="mg-linkish" onClick={() => setCur('settings')}>לגיבוי או למעבר לענן</button></div>
        )}
        {books === null && <div className="mg-empty">טוען את העסקים…</div>}

        {cur === 'settings' && (
          <SettingsView key={storeTick} user={user} flash={flash} books={books || []} server={server}
                        onServer={() => serverStatus(true).then(setServer)}
                        onRestored={() => { setDatas({}); refreshBooks(); }}
                        onStoreLogin={() => setStoreLogin(true)} onStoreChanged={reloadLinked} />
        )}

        {cur === 'help' && <HelpView role={tourRole} clerkOnly={tourRole === 'clerk'} onStart={startTour} flash={flash} />}
        {cur === 'users' && books && <UsersView books={books} user={user} flash={flash} onSave={saveBook} />}
        {cur !== 'settings' && cur !== 'users' && cur !== 'help' && books && !books.length && !booksErr && <Welcome onNew={(preset) => setBookForm(preset)} />}

        {cur === 'all' && books && books.length > 0 && (() => {
          /* The financial overview is for owners and viewers; someone who only
             issues documents sees their businesses, not the totals. */
          const seen = books.filter(b => roleOf(b, user.email) !== 'clerk');
          return seen.length
            ? <><DupCard books={books} user={user} flash={flash} onDone={() => { setDatas({}); refreshBooks(); }} />
                <AllView books={seen} datas={datas} loading={loading} onOpen={setCur} onStoreLogin={() => setStoreLogin(true)} /></>
            : <div className="mg-card" style={{ maxWidth: 560 }}><h3 style={{ marginTop: 0 }}>שלום {user.email}</h3>
                <p>יש לך הרשאה להפיק מסמכים בעסקים שבתפריט. בחר עסק כדי להתחיל.</p></div>;
        })()}

        {book && (datas[book.id]
          ? <BookView key={book.id} book={book} data={datas[book.id]} patch={patch(book.id)} flash={flash} server={server}
                      role={roleOf(book, user.email)} ro={roleOf(book, user.email) === 'viewer'}
                      onReload={() => ensure(book, true)} onEditBook={() => setBookForm(book)}
                      onStoreLogin={() => setStoreLogin(true)}
                      onDeleteBook={() => deleteBook(book)}
                      onTab={setBookTab} tabReq={tabReq?.book === book.id ? tabReq.k : null} onTabDone={() => setTabReq(null)}
                      siblings={(books || []).filter(b => b.id !== book.id && digitsOf(b.taxId) && digitsOf(b.taxId) === digitsOf(book.taxId) && roleOf(b, user.email) === 'owner').map(b => ({ book: b, data: datas[b.id] }))}
                      onLoadSiblings={() => (books || []).filter(b => b.id !== book.id && digitsOf(b.taxId) && digitsOf(b.taxId) === digitsOf(book.taxId)).forEach(b => ensure(b))}
                      user={user} onGlobal={(v) => setCur(v)} onServer={() => serverStatus(true).then(setServer)} />
          : <div className="mg-empty">טוען את {book.name}…</div>)}
      </main>

      {bookForm && (
        <BookForm rec={bookForm} me={user.email} count={books?.length || 0}
                  hasLive={(datas[bookForm.id]?.documents || []).some(d => d.series === 'live')}
                  onClose={() => setBookForm(null)}
                  onSave={async (b) => { if (await saveBook(b)) { setBookForm(null); setCur(b.id); } }} />
      )}
      {storeLogin && <StoreLogin onClose={() => setStoreLogin(false)}
                                 onDone={(email) => { setStoreLogin(false); setStoreTick(t => t + 1); flash('מחובר לחנות כ-' + email); reloadLinked(); }} />}
      {tourCtx && (
        <button data-tour="help-btn" className="help-btn" title="הדרכה למסך הזה" aria-label="הדרכה למסך הזה"
                onClick={() => setTourWant(tourCtx)}>?
          {tourState().off && tourPending(tourCtx, tourRole) && <span className="nd" />}</button>)}
      {tour && <TourOverlay key={tour.ctx + tour.steps.length} ctx={tour.ctx} steps={tour.steps} auto={tour.auto}
                            onDone={() => { tourMark(tour.ctx); setTour(null); }}
                            onOff={() => { try { lsSet(TOUR_KEY, { ...tourState(), off: true, [tour.ctx]: VERSION }); } catch { /* ignore */ }
                                           setTour(null); flash('ההדרכות לא ירוצו לבד. הכפתור "?" ודף המדריך זמינים תמיד'); }} />}
      {news && !locked && <WhatsNew since={news} onClose={closeNews} onHelp={() => { closeNews(); setCur('help'); }} />}
      {msg && <div className="flash">{msg}</div>}
    </div>
  );
}

/* Who can do what, in every business I own. Each change is saved to that
   business at once. A new person signs up with "משתמש חדש" in the same email. */
function UsersView({ books, user, flash, onSave }) {
  const me = user.email.toLowerCase();
  const owned = books.filter(b => roleOf(b, me) === 'owner');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('clerk');
  const [pick, setPick] = useState(() => Object.fromEntries(owned.map(b => [b.id, true])));
  const people = {};
  owned.forEach(b => [['owners', 'owner'], ['clerks', 'clerk'], ['viewers', 'viewer']].forEach(([f, r]) =>
    (b[f] || []).forEach(e => { (people[e] = people[e] || {})[b.id] = r; })));
  const assign = async (b, e, r) => {
    e = e.trim().toLowerCase();
    if (e === me && r !== 'owner') { flash('אי אפשר להוריד את עצמך מבעלות'); return; }
    const without = (arr) => (arr || []).filter(x => x !== e);
    const nb = { ...b, owners: without(b.owners), clerks: without(b.clerks), viewers: without(b.viewers) };
    if (r) nb[{ owner: 'owners', clerk: 'clerks', viewer: 'viewers' }[r]].push(e);
    if (!nb.owners.length) { flash('לכל עסק צריך להישאר בעלים אחד לפחות'); return; }
    await onSave(nb);
  };
  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { flash('אימייל לא תקין'); return; }
    for (const b of owned.filter(b => pick[b.id])) await assign(b, e, role);
    setEmail(''); flash(`${e} נוסף`);
    /* The system sends no email of its own: an invitation ready to send. */
    const link = window.location.origin;
    window.location.href = `mailto:${e}?subject=${encodeURIComponent('הזמנה ל-Tizon Books')}&body=${encodeURIComponent(
      `שלום,\n\nהוספתי אותך כ${ROLES[role]} ב-Tizon Books.\nנכנסים כאן: ${link}\nבוחרים "משתמש חדש", נרשמים עם האימייל הזה (${e}) ובוחרים סיסמה.\n\n${user.email}`)}`;
  };
  return (
    <>
      <div className="mg-h"><div><h2>משתמשים והרשאות</h2><div className="sub">מי נכנס לאיזה עסק, ומה מותר לו לעשות</div></div></div>
      <div data-tour="users-add" className="mg-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>הוספת משתמש</h3>
        <div style={row}>
          <Field label="אימייל"><input dir="ltr" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
          <Field label="תפקיד"><select value={role} onChange={e => setRole(e.target.value)}>
            {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '10px 0' }}>
          {owned.map(b => <label key={b.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!pick[b.id]} onChange={e => setPick(p => ({ ...p, [b.id]: e.target.checked }))} />{b.name}</label>)}
        </div>
        <button className="mg-btn" disabled={!email.trim() || !owned.some(b => pick[b.id])} onClick={add}>＋ הוסף</button>
        <div className="mg-note" style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
          <b>בעלים</b>: הכול. · <b>מפיק מסמכים</b>: מפיק מסמכים ומנהל לקוחות, בלי הכנסות, הוצאות, דוחות והגדרות. · <b>צפייה בלבד</b>: רואה הכול ומייצא, לא משנה דבר (לרואה החשבון).<br />
          המשתמש החדש נכנס למערכת ובוחר "משתמש חדש" עם אותו אימייל. כדי שיוכל גם לשלוח מסמכים חתומים, צריך להוסיף את האימייל שלו גם ל-<span dir="ltr">ALLOWED_EMAILS</span> ב-Netlify.
        </div>
      </div>
      <div data-tour="users-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>משתמש</th>{owned.map(b => <th key={b.id}>{b.name}</th>)}</tr></thead>
        <tbody>
          {Object.keys(people).sort((a, b) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b))).map(e => (
            <tr key={e}><td dir="ltr" style={{ textAlign: 'right' }}><b>{e}</b>{e === me && <span className="mg-chip" style={{ marginInlineStart: 6 }}>את/ה</span>}</td>
              {owned.map(b => (
                <td key={b.id}><select value={people[e][b.id] || ''} disabled={e === me} style={{ width: 'auto' }}
                  onChange={ev => assign(b, e, ev.target.value || null)}>
                  <option value="">— אין גישה —</option>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
              ))}</tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}

function PinCard({ flash }) {
  const [has, setHas] = useState(!!lsGet(PIN_KEY, null));
  const set = async () => {
    const a = window.prompt('קוד חדש (4 עד 8 ספרות):'); if (!a) return;
    if (!/^\d{4,8}$/.test(a)) { flash('הקוד צריך להיות 4 עד 8 ספרות'); return; }
    if (window.prompt('הקלד שוב את הקוד:') !== a) { flash('הקודים לא זהים'); return; }
    const salt = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
    lsSet(PIN_KEY, { salt, hash: await pinHash(a, salt) }); sessionStorage.setItem(UNLOCK_KEY, '1'); setHas(true); flash('נעילה הופעלה');
  };
  return (
    <div data-tour="set-pin" className="mg-card">
      <h3 style={{ marginTop: 0 }}>נעילה בקוד</h3>
      <p style={{ marginTop: 0, fontSize: 14 }}>קוד שנדרש כדי לפתוח את המערכת{cloud ? ', אותו קוד בכל המכשירים שלך' : ' במחשב הזה'}. אחרי 15 דקות בלי פעילות, המערכת ננעלת שוב.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="mg-btn" onClick={set}>{has ? 'החלף קוד' : 'הפעל נעילה'}</button>
        {has && <button className="mg-btn ghost" onClick={() => { if (window.confirm('לבטל את הנעילה בכל המכשירים?')) { lsDel(PIN_KEY); setHas(false); flash('הנעילה בוטלה'); } }}>בטל נעילה</button>}
      </div>
      <div className="mg-note" style={{ marginTop: 10 }}>{cloud ? 'שכחת את הקוד? במסך הנעילה: "שכחתי את הקוד", ונכנסים שוב עם האימייל והסיסמה. הנעילה מתבטלת, ואפשר לקבוע קוד חדש.'
        : 'הקוד נשמר רק במכשיר הזה. אם שכחת אותו: מוחקים את נתוני האתר בדפדפן (בעבודה בלי ענן, קודם גיבוי).'}</div>
    </div>
  );
}

function ArchiveCard({ books, user, server, flash }) {
  const [month, setMonth] = useState(addMonths(thisMonth(), -1));
  const [busy, setBusy] = useState(false);
  const last = lsGet(ARCH_KEY, '');
  const mine = books.filter(b => !cloud || (b.owners || []).includes(user.email.toLowerCase()));
  return (
    <div data-tour="set-archive" className="mg-card">
      <h3 style={{ marginTop: 0 }}>ארכיון חודשי</h3>
      <p style={{ marginTop: 0, fontSize: 14 }}>לכל חודש: קבצי מבנה אחיד של כל עסק (מסמכים ופקודות יומן) וגיבוי מלא, בקובץ אחד. את הקבצים צריך לשמור 7 שנים.</p>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
        {cloud && server?.mail ? `נשלח אוטומטית למייל בתחילת כל חודש. אחרון: ${last || 'עוד לא'}` : `אחרון שהורד: ${last || 'עוד לא'}`}</div>
      <div style={row}>
        <Field label="חודש"><input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /></Field>
        <button className="mg-btn keep" disabled={busy || !mine.length} onClick={async () => {
          setBusy(true);
          try { const { zip } = await makeArchive(mine, month, user.email); saveBytes(`tizon-books-archive-${month}.zip`, zip, 'application/zip');
                if (month === addMonths(thisMonth(), -1)) lsSet(ARCH_KEY, month); flash('הארכיון ירד'); }
          catch (e) { flash('הפקת הארכיון נכשלה · ' + e.message); }
          setBusy(false);
        }}>{busy ? 'מכין…' : '⬇ הורד ארכיון'}</button>
      </div>
    </div>
  );
}

/* Allocation numbers: which businesses are connected to the Tax Authority,
   and the button that sends the owner there to give consent. */
function ItaCard({ server, books, user, flash }) {
  const mine = books.filter(b => digitsOf(b.taxId).length === 9 && (!cloud || (b.owners || []).includes(user.email.toLowerCase())));
  const [st, setSt] = useState({});
  useEffect(() => {
    if (!cloud || !server?.ita?.configured) return;
    mine.forEach(b => fnCall({ action: 'ita-status', vat: digitsOf(b.taxId) }).then(r => setSt(x => ({ ...x, [b.id]: r }))).catch(() => {}));
  }, [server?.ita?.configured, books.length]);
  const connect = async (b) => {
    try { const r = await fnCall({ action: 'ita-connect', vat: digitsOf(b.taxId) }); window.location.href = r.url; }
    catch (e) { flash('החיבור נכשל · ' + e.message); }
  };
  return (
    <div data-tour="set-ita" className="mg-card">
      <h3 style={{ marginTop: 0 }}>מספרי הקצאה אוטומטיים</h3>
      {!server ? <p style={{ marginTop: 0 }}>זמין רק בהתקנה מ-GitHub, עם שרת.</p>
      : !server.ita?.configured ? (
        <p style={{ marginTop: 0, fontSize: 14 }}>
          עוד לא מוגדר. אחרי רישום התוכנה ופתיחת אפליקציה בפורטל המפתחים של רשות המסים, מגדירים ב-Netlify את
          <span dir="ltr"> ITA_CLIENT_ID, ITA_CLIENT_SECRET, ITA_REDIRECT_URI </span>(ולייצור: <span dir="ltr">ITA_ENV=production</span>).
          עד אז מזינים את מספר ההקצאה ידנית.</p>
      ) : !cloud ? <p style={{ marginTop: 0 }}>צריך להיות מחובר לענן.</p> : (
        <>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>סביבה: <b>{server.ita.env === 'production' ? 'ייצור' : 'בדיקות (sandbox)'}</b></div>
          {mine.map(b => (
            <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0ebe0', flexWrap: 'wrap' }}>
              <b style={{ flex: 1 }}>{b.name} <span dir="ltr" style={{ fontWeight: 400, color: 'var(--muted)' }}>{b.taxId}</span></b>
              {st[b.id]?.connected ? <span className="mg-chip ok">מחובר עד {heDate(String(st[b.id].expires || '').slice(0, 10))}</span> : <span className="mg-chip">לא מחובר</span>}
              <button className="mg-btn ghost sm" onClick={() => connect(b)}>{st[b.id]?.connected ? 'חדש חיבור' : 'התחבר לרשות המסים'}</button>
            </div>
          ))}
          {!mine.length && <div className="mg-empty">אין עסק עם מספר עוסק בן 9 ספרות.</div>}
          <div className="mg-note" style={{ marginTop: 10 }}>החיבור נעשה בכניסה שלך לאתר רשות המסים, ותקף שלושה חודשים. אחר כך מתחברים מחדש.</div>
        </>
      )}
    </div>
  );
}

/* Linking the store once for every device: the server signs in with these
   details a single time and keeps only the token it gets back. */
function StoreLinkForm({ flash, onDone }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <div style={{ marginTop: 12 }}><button className="mg-btn ghost sm" onClick={() => setOpen(true)}>🔗 חיבור קבוע לכל המכשירים</button></div>;
  const go = async () => {
    setBusy(true);
    try { const r = await fnCall({ action: 'store-link', email, password: pw }); flash(`החנות מחוברת בכל המכשירים (${r.email})`); setPw(''); setOpen(false); onDone(); }
    catch (e) { flash(/INVALID|EMAIL|PASSWORD|login/i.test(e.message) ? 'אימייל או סיסמה של החנות שגויים' : e.message === 'owners only' ? 'רק בעלי עסק יכולים לחבר את החנות' : 'החיבור נכשל · ' + e.message); }
    setBusy(false);
  };
  return (
    <div className="mg-note" style={{ marginTop: 12 }}>
      <b>חיבור קבוע:</b> המשתמש של קונסולת החנות. הסיסמה משמשת פעם אחת לכניסה ולא נשמרת; השרת שומר רק אישור כניסה, וכל מכשיר קורא את החנות דרכו.
      <div style={{ ...grid, marginTop: 8 }}>
        <Field label="אימייל בחנות"><input dir="ltr" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="סיסמה בחנות"><input dir="ltr" type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && email && pw && go()} /></Field>
      </div>
      <div style={{ ...row, marginTop: 8 }}>
        <button className="mg-btn sm" disabled={busy || !email || !pw} onClick={go}>{busy ? 'מתחבר…' : 'חבר לכל המכשירים'}</button>
        <button className="mg-btn ghost sm" onClick={() => setOpen(false)}>ביטול</button>
      </div>
    </div>
  );
}

/* Signing in to the store — the console's own user and password. Kept by
   Firebase on this device, separately from this app's own login. */
function StoreLogin({ onClose, onDone }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try { const c = await signInWithEmailAndPassword(store().auth, email.trim(), pw); onDone(c.user.email); }
    catch (x) {
      const c = String(x?.code || '');
      setErr(c.includes('invalid') || c.includes('wrong') || c.includes('not-found') ? 'אימייל או סיסמה שגויים'
        : c.includes('too-many') ? 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.' : 'הכניסה נכשלה: ' + c);
    }
    setBusy(false);
  };
  return (
    <Box title="התחברות לחנות" onClose={onClose}
         footer={<><button className="mg-btn" disabled={busy || !email || !pw} onClick={go}>{busy ? 'מתחבר…' : 'התחבר'}</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      <p style={{ marginTop: 0 }}>אותו אימייל וסיסמה של קונסולת החנות.</p>
      <div style={grid}>
        <Field label="אימייל"><input type="email" dir="ltr" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></Field>
        <Field label="סיסמה"><input type="password" dir="ltr" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password"
                                    onKeyDown={e => e.key === 'Enter' && email && pw && go()} /></Field>
      </div>
      {err && <div className="mg-note bad" style={{ marginTop: 12 }}>{err}</div>}
      <div className="mg-note" style={{ marginTop: 12 }}>
        <b>קריאה בלבד.</b> המערכת קוראת את ההזמנות ששולמו ואת מספרי החשבוניות, ולא כותבת לחנות דבר.
        לא משנה קוד, חוקים או נתונים בחנות.
      </div>
    </Box>
  );
}

function Welcome({ onNew }) {
  return (
    <div data-tour="welcome-card" className="mg-card" style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0, fontFamily: 'Frank Ruhl Libre,serif' }}>ברוך הבא</h2>
      <p>כל עסק מנוהל כספר נפרד, עם סוג עוסק ומע״מ משלו. בדף "כל העסקים" רואים את כולם יחד.</p>
      <div style={row}>
        <button className="mg-btn" onClick={() => onNew({ name: 'החנות', kind: 'store', tenant: 'main' })}>הוסף את החנות</button>
        <button className="mg-btn ghost" onClick={() => onNew({ name: 'הקליניקה', kind: 'clinic' })}>הוסף קליניקה</button>
        <button className="mg-btn ghost" onClick={() => onNew({})}>עסק אחר</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ business form */
function BookForm({ rec, me, count, hasLive, onSave, onClose }) {
  const [f, setF] = useState(() => ({
    id: uid('book'), name: '', kind: 'other', legalName: '', taxId: '', dealerType: 'licensed', vatRate: 18,
    color: BOOK_COLORS[count % BOOK_COLORS.length], order: count, owners: cloud ? [me.toLowerCase()] : [],
    ...rec, ownersText: (rec.owners || (cloud ? [me.toLowerCase()] : [])).join(', '), viewersText: (rec.viewers || []).join(', '), clerksText: (rec.clerks || []).join(', ')
  }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const submit = () => {
    const { ownersText, viewersText, clerksText, ...b } = f;
    onSave({ ...b, tenant: tenantId(b.tenant), vatRate: Number(b.vatRate) || 0, owners: ownersText.split(/[,\s]+/).filter(Boolean),
             viewers: viewersText.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@')),
             clerks: clerksText.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(x => x.includes('@')) });
  };
  return (
    <Box title={rec.id ? 'הגדרות העסק' : 'עסק חדש'} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={!String(f.name).trim() || (f.dealerType !== 'exempt' && !(Number(f.vatRate) > 0 && Number(f.vatRate) < 50))} onClick={submit}>שמור</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div style={grid}>
        <Field label="שם העסק (לתצוגה)"><input value={f.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="סוג"><select value={f.kind} onChange={e => set('kind', e.target.value)}>
          {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="שם משפטי"><input value={f.legalName} onChange={e => set('legalName', e.target.value)} /></Field>
        <Field label="ח.פ. / ע.מ."><input dir="ltr" value={f.taxId} onChange={e => set('taxId', e.target.value)} /></Field>
        <Field label="כתובת"><input value={f.address || ''} onChange={e => set('address', e.target.value)} /></Field>
        <Field label="טלפון"><input dir="ltr" value={f.phone || ''} onChange={e => set('phone', e.target.value)} /></Field>
        <Field label="אימייל"><input dir="ltr" value={f.email || ''} onChange={e => set('email', e.target.value)} /></Field>
        <Field label="סוג עוסק"><select value={f.dealerType} onChange={e => set('dealerType', e.target.value)}>
          {Object.entries(DEALERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {f.dealerType !== 'exempt' && <Field label="שיעור מע״מ (%)"><input inputMode="decimal" value={f.vatRate} onChange={e => set('vatRate', e.target.value)} /></Field>}
        <Field label="קישור לחנות · מזהה החנות (אופציונלי)"><input dir="ltr" value={f.tenant || ''} onChange={e => set('tenant', e.target.value.trim())} onBlur={e => set('tenant', tenantId(e.target.value))} placeholder="main" />
          <small style={{ color: 'var(--muted)' }}>מזהה, לא כתובת אתר. בחנות שלך: <b dir="ltr">main</b></small></Field>
        <Field label="צבע"><div style={{ display: 'flex', gap: 6 }}>
          {BOOK_COLORS.map(c => <button key={c} type="button" onClick={() => set('color', c)}
            style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: f.color === c ? '3px solid #c4a36e' : '2px solid #fff', cursor: 'pointer', boxShadow: '0 0 0 1px #ddd' }} />)}
        </div></Field>
      </div>
      <div className="mg-card" style={{ marginTop: 14, background: '#fbf8f1' }}>
        <h3 style={{ marginTop: 0 }}>מסמכים</h3>
        <div style={grid}>
          <Field label="לוגו למסמכים">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {f.logo && <img src={f.logo} alt="" style={{ height: 40, maxWidth: 120, objectFit: 'contain' }} />}
              <label className="mg-btn ghost sm" style={{ cursor: 'pointer' }}>{f.logo ? 'החלף' : 'העלה'}
                <input type="file" accept="image/*" hidden onChange={e => {
                  const file = e.target.files?.[0]; if (!file) return;
                  const img = new Image(); const url = URL.createObjectURL(file);
                  img.onload = () => { const k = Math.min(1, 400 / img.width, 160 / img.height); const c = document.createElement('canvas');
                    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    set('logo', c.toDataURL('image/png')); URL.revokeObjectURL(url); };
                  img.src = url; e.target.value = ''; }} /></label>
              {f.logo && <button type="button" className="mg-btn ghost sm" onClick={() => set('logo', '')}>הסר</button>}
            </div></Field>
          <Field label="מצב">
            <select value={f.docMode || 'test'} onChange={e => set('docMode', e.target.value)} disabled={!cloud}>
              <option value="test">ניסיון (T-, לא לצורכי מס)</option><option value="live">אמיתי</option></select></Field>
          <Field label="מספר ראשון למסמכים אמיתיים"><input inputMode="numeric" value={f.docStart || 1} disabled={hasLive}
            onChange={e => set('docStart', e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        {!cloud && <div className="mg-note" style={{ marginTop: 10 }}>מסמכים אמיתיים אפשריים רק כשהמערכת מחוברת לענן. מסמך מס לא יכול להישמר רק בדפדפן.</div>}
        {cloud && f.docMode === 'live' && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 14 }}>
          <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={!!f.docApproved} onChange={e => set('docApproved', e.target.checked)} />
          <span>רואה החשבון שלי אישר להפיק מסמכי מס מהמערכת הזו. מסמך אמיתי לא נמחק ולא נערך, והמספור שלו רץ ברצף.</span></label>}
        {hasLive && <div className="mg-note" style={{ marginTop: 10 }}>כבר הופקו מסמכים אמיתיים, ולכן המספר הראשון נעול.</div>}
      </div>
      {cloud && <div style={{ marginTop: 12 }}>
        <Field label="בעלים · גישה מלאה (אימיילים, מופרדים בפסיק)">
          <input dir="ltr" value={f.ownersText} onChange={e => set('ownersText', e.target.value)} /></Field>
        <div style={{ marginTop: 10 }}><Field label="מפיקי מסמכים · מסמכים ולקוחות בלבד (אימיילים, מופרדים בפסיק)">
          <input dir="ltr" value={f.clerksText} onChange={e => set('clerksText', e.target.value)} /></Field></div>
        <div style={{ marginTop: 10 }}><Field label="צפייה בלבד · למשל רואה החשבון (אימיילים, מופרדים בפסיק)">
          <input dir="ltr" value={f.viewersText} onChange={e => set('viewersText', e.target.value)} /></Field></div>
      </div>}
      <div className="mg-note" style={{ marginTop: 12 }}>
        <b>קישור לחנות:</b> ההזמנות ששולמו בחנות נכנסות לספר הזה כהכנסות, עם מספרי החשבוניות, בקריאה בלבד.
        מזהה החנות הוא מה שמופיע בכתובת הקונסולה אחרי <span dir="ltr">/t/</span>. לחנות הראשית זה <b dir="ltr">main</b>. משאירים ריק לעסק שאינו חנות.<br />
        שני עסקים עם אותו ע.מ. מדווחים מע״מ יחד, ובדף "כל העסקים" הם מאוחדים בדוח המע״מ.
        {cloud && ' רואה החשבון נכנס עם משתמש משלו ("משתמש חדש" במסך הכניסה) ורואה רק את הספרים שבהם הוא מופיע.'}
      </div>
    </Box>
  );
}

/* ---------------------------------------------------------- backup & cloud */
function SettingsView({ user, flash, onRestored, books, onStoreLogin, onStoreChanged, server, onServer }) {
  const [busy, setBusy] = useState(false);
  const [cfgText, setCfgText] = useState('');
  const lastBackup = lsGet(BACKUP_KEY, null);
  const linked = books.filter(b => b.tenant);
  const [storeEmail, setStoreEmail] = useState(undefined);
  useEffect(() => { if (linked.length) storeUser().then(u => setStoreEmail(u ? u.email : null)); }, [linked.length]);

  const backup = async () => {
    setBusy(true);
    try {
      const data = await exportAll(user.email);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      saveJSON(`tizon-books-backup-${stamp}.json`, data);
      lsSet(BACKUP_KEY, new Date().toISOString());
      flash(`הגיבוי ירד · ${data.books.length} עסקים`);
    } catch (e) { flash('הגיבוי נכשל · ' + (e?.message || '')); }
    setBusy(false);
  };
  const restore = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await importAll(JSON.parse(await file.text()), cloud ? user.email : '');
      flash(`שוחזרו ${r.books} עסקים ו-${r.records} רשומות`); onRestored();
    } catch (e) { flash('השחזור נכשל · ' + (e?.message || '')); }
    setBusy(false);
  };
  const connect = () => {
    const c = parseFirebaseConfig(cfgText);
    if (!c) { flash('לא זיהיתי apiKey ו-projectId בטקסט שהודבק'); return; }
    if (c.projectId === 'tizonshoponline' && !window.confirm('זה הפרויקט של החנות. המערכת צריכה פרויקט נפרד. להמשיך בכל זאת?')) return;
    lsSet(CLOUD_KEY, c); localStorage.removeItem(LOCAL_ONLY_KEY); location.reload();
  };
  const moveUp = async () => {
    if (!window.confirm('להעתיק את כל הנתונים שנשמרו במחשב הזה לענן?')) return;
    setBusy(true);
    try {
      const data = await exportAll('', local);
      /* A business that is already in the cloud under the same name is filled in, not made twice. */
      const there = await DB.books(user.email).catch(() => []);
      data.books = data.books.map(b => { const t = there.find(x => bookKey(x) === bookKey(b)); return t ? { ...t, data: b.data } : b; });
      const r = await importAll(data, user.email);
      try { localStorage.removeItem(LOCAL_KEY); } catch { /* ignore */ }
      flash(`הועברו ${r.books} עסקים ו-${r.records} רשומות לענן`); onRestored();
    } catch (e) { flash('ההעברה נכשלה · ' + (e?.code || e?.message || '')); }
    setBusy(false);
  };

  return (
    <>
      <div className="mg-h" style={{ '--h1': '#8a6331', '--h2': '#c4a36e' }}>
        <div><h2>גיבוי וענן</h2><div className="sub">גרסה {VERSION} · {cloud ? `מחובר לענן · ${cloud.cfg.projectId}` : 'הנתונים נשמרים במחשב הזה'}</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(320px,100%),1fr))', gap: 16 }}>
        <div data-tour="set-backup" className="mg-card">
          <h3 style={{ marginTop: 0 }}>גיבוי</h3>
          <p style={{ marginTop: 0 }}>קובץ אחד עם כל העסקים וכל הרשומות. אפשר לשחזר ממנו בכל מחשב, גם אחרי מעבר לענן.</p>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
            גיבוי אחרון מהמכשיר הזה: {lastBackup ? heDate(lastBackup.slice(0, 10)) : 'עוד לא'}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="mg-btn" disabled={busy} onClick={backup}>⬇ הורד גיבוי</button>
            <label className="mg-btn ghost" style={{ cursor: 'pointer' }}>⬆ שחזר מגיבוי
              <input type="file" accept=".json,application/json" hidden onChange={e => { restore(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
          <div className="mg-note" style={{ marginTop: 12 }}>שחזור מוסיף ומעדכן רשומות לפי המזהה שלהן. הוא לא מוחק רשומות שכבר קיימות.</div>
        </div>

        <div data-tour="set-sign" className="mg-card">
          <h3 style={{ marginTop: 0 }}>חתימה דיגיטלית ושליחה</h3>
          {!server ? (
            <p style={{ marginTop: 0 }}>שירות החתימה לא זמין באתר הזה. הוא פועל רק כשהמערכת מותקנת מ-GitHub (לא בגרירת zip), לפי המדריך המצורף.</p>
          ) : (
            <>
              <div style={{ lineHeight: 1.9, fontSize: 14 }}>
                <div>{server.project ? '✓' : '✗'} מזהה הפרויקט (BOOKS_PROJECT_ID)</div>
                <div>{server.guarded ? '✓' : '✗'} רשימת מורשים (ALLOWED_EMAILS)</div>
                <div>{server.password ? '✓' : '✗'} סיסמת התעודה (SIGN_P12_PASSWORD)</div>
                <div>{server.sign ? '✓' : '✗'} תעודה {server.cert ? <>· <b>{server.cert.name}</b> · {server.cert.issuer} · בתוקף עד {heDate(server.cert.expires.slice(0, 10))}</> : server.certError ? `· שגיאה: ${server.certError}` : '· לא הועלתה'}</div>
                <div>{server.mail ? '✓' : '✗'} שליחת מייל (SMTP)</div>
              </div>
              {cloud && server.password && server.guarded && (
                <label className="mg-btn ghost" style={{ cursor: 'pointer', marginTop: 10 }}>⬆ {server.sign ? 'החלף תעודה' : 'העלה תעודה'} (.p12 / .pfx)
                  <input type="file" accept=".p12,.pfx,application/x-pkcs12" hidden onChange={async e => {
                    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
                    try { const r = await fnCall({ action: 'cert', p12: b64(await file.arrayBuffer()) });
                          flash(`התעודה נשמרה · ${r.cert.name}`); onServer(); }
                    catch (x) { flash('העלאת התעודה נכשלה · ' + x.message); }
                  }} /></label>
              )}
              {server.sign && server.cert && Date.parse(server.cert.expires) - Date.now() < 30 * 86400000 &&
                <div className="mg-note warn" style={{ marginTop: 10 }}>התעודה פגה בקרוב. כדאי לחדש מול הגורם המאשר.</div>}
            </>
          )}
          <div className="mg-note" style={{ marginTop: 12 }}>התעודה נשמרת בשרת בלבד ולא עוברת בדפדפן אחרי ההעלאה. הסיסמה שלה נשמרת בנפרד, בהגדרות של Netlify.</div>
        </div>

        <PinCard flash={flash} />
        <ItaCard server={server} books={books} user={user} flash={flash} />
        <PayCard server={server} books={books} user={user} flash={flash} onServer={onServer} />
        <ArchiveCard books={books} user={user} server={server} flash={flash} />

        <div data-tour="set-store" className="mg-card">
          <h3 style={{ marginTop: 0 }}>חיבור לחנות</h3>
          {!linked.length ? (
            <p style={{ marginTop: 0 }}>אף עסק לא מקושר לחנות. מקשרים בהגדרות העסק, בשדה "מזהה החנות".</p>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>מקושרים: {linked.map(b => <b key={b.id}>{b.name} (<span dir="ltr">{b.tenant}</span>) </b>)}</p>
              {server?.store?.linked ? <>
                <p><span className="mg-chip ok">מחובר בכל המכשירים</span> דרך השרת, כ-<b dir="ltr">{server.store.email}</b>. אין צורך להתחבר לחנות בכל מכשיר.</p>
                <button className="mg-btn ghost" onClick={async () => { if (!window.confirm('לנתק את החיבור הקבוע לחנות? כל מכשיר יצטרך להתחבר בעצמו.')) return;
                  try { await fnCall({ action: 'store-link', unlink: true }); onServer?.(); onStoreChanged(); flash('החיבור הקבוע נותק'); } catch (e) { flash('הניתוק נכשל · ' + e.message); } }}>נתק חיבור קבוע</button>
              </> : <>
                <p>{storeEmail === undefined ? 'בודק…' : storeEmail ? <>מחובר לחנות כ-<b dir="ltr">{storeEmail}</b>, במכשיר הזה בלבד.</> : 'לא מחובר לחנות במכשיר הזה.'}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="mg-btn" onClick={onStoreLogin}>{storeEmail ? 'החלף משתמש' : 'התחבר לחנות'}</button>
                  {storeEmail && <button className="mg-btn ghost" onClick={async () => { await signOut(store().auth); setStoreEmail(null); onStoreChanged(); flash('התנתקת מהחנות'); }}>התנתק מהחנות</button>}
                </div>
                {server && cloud && <StoreLinkForm flash={flash} onDone={() => { onServer?.(); setTimeout(onStoreChanged, 400); }} />}
              </>}
            </>
          )}
          <div className="mg-note" style={{ marginTop: 12 }}>קריאה בלבד: הזמנות ששולמו ומספרי חשבוניות. המערכת לא כותבת לחנות דבר.</div>
        </div>

        <div data-tour="set-cloud" className="mg-card">
          <h3 style={{ marginTop: 0 }}>ענן</h3>
          {!cloud ? (
            <>
              {BUILT_IN_CLOUD && <div className="mg-note warn" style={{ marginBottom: 12 }}>
                המכשיר הזה נותק מהענן של Tizon Books.{' '}
                <button className="mg-btn sm" onClick={() => { localStorage.removeItem(LOCAL_ONLY_KEY); location.reload(); }}>חזרה לענן</button></div>}
              <p style={{ marginTop: 0 }}>
                כרגע הכול נשמר בדפדפן הזה בלבד. כדי לעבוד מכל מכשיר, מחברים פרויקט Firebase <b>נפרד</b>, לא הפרויקט של החנות:
              </p>
              <ol style={{ paddingInlineStart: 18, lineHeight: 1.8, fontSize: 14, marginTop: 0 }}>
                <li>ב-console.firebase.google.com יוצרים פרויקט חדש, למשל tizon-books.</li>
                <li>Authentication ← Sign-in method ← מפעילים Email/Password.</li>
                <li>Firestore Database ← Create database.</li>
                <li>Firestore ← Rules ← מדביקים את הקובץ firestore.rules שמגיע עם המערכת ← Publish.</li>
                <li>Project settings ← Your apps ← Web ← מעתיקים את ה-firebaseConfig ומדביקים כאן.</li>
              </ol>
              <textarea rows={6} dir="ltr" value={cfgText} onChange={e => setCfgText(e.target.value)}
                        placeholder={'const firebaseConfig = {\n  apiKey: "…",\n  projectId: "…",\n  …\n};'} />
              <div style={{ marginTop: 10 }}><button className="mg-btn" disabled={!cfgText.trim()} onClick={connect}>חבר לענן</button></div>
              <div className="mg-note" style={{ marginTop: 12 }}>הנתונים שכבר נשמרו במחשב לא נמחקים. אחרי הכניסה לענן יופיע כפתור להעביר אותם.</div>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>מחובר לפרויקט <b dir="ltr">{cloud.cfg.projectId}</b> כ-<b dir="ltr">{user.email}</b>.</p>
              {prefErr
                ? <div className="mg-note bad" style={{ marginBottom: 12 }}>ההגדרות האישיות לא מסתנכרנות בין המכשירים ({prefErr}). צריך לפרסם את firestore.rules העדכני מהריפו (Firestore ← Rules ← Publish).</div>
                : <div className="mg-note" style={{ marginBottom: 12 }}>כל הנתונים וההגדרות נשמרים בענן ועוברים לכל מכשיר שנכנסים ממנו. במכשיר נשארים רק נעילת הקוד וההתחברות לחנות.</div>}
              {hasLocalData() && (
                <div className="mg-note warn" style={{ marginBottom: 12 }}>
                  יש במחשב הזה נתונים מלפני המעבר לענן.{' '}
                  <button className="mg-btn sm" disabled={busy} onClick={moveUp}>העבר אותם לענן</button></div>
              )}
              <button className="mg-btn ghost" onClick={() => { if (window.confirm('לנתק את הענן במכשיר הזה? הנתונים בענן נשארים שם.')) { localStorage.removeItem(CLOUD_KEY); if (BUILT_IN_CLOUD) lsSet(LOCAL_ONLY_KEY, true); location.reload(); } }}>
                נתק את הענן במכשיר הזה</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
/* ============================================================ all businesses */
function AllView({ books, datas, loading, onOpen, onStoreLogin }) {
  const [mode, setMode] = useState('month');
  const [month, setMonth] = useState(thisMonth());
  const y = month.slice(0, 4);
  const [from, to] = mode === 'month' ? [month, month]
    : mode === 'bi' ? [biStart(month), addMonths(biStart(month), 1)]
    : mode === 'ytd' ? [y + '-01', month] : [y + '-01', y + '-12'];
  const label = from === to ? monthName(from) : `${monthName(from)}–${monthName(to)}`;

  const rows = books.map(b => {
    const d = datas[b.id];
    /* Until its history is in, a business's totals would be too low: it waits. */
    if (!d || d.histPending) return { b, pending: true, loadingHist: !!d };
    const L = buildLedger(b, d);
    return { b, d, L, t: totals(L, from, to), a: alertsOf(d, L) };
  });
  const ready = rows.filter(r => !r.pending);
  const sum = (k) => ready.reduce((a, r) => a + r.t[k], 0);

  /* VAT is reported per dealer: businesses under one tax id file one return. */
  const vatGroups = {};
  ready.filter(r => r.L.rate > 0).forEach(r => {
    const k = String(r.b.taxId || '').trim() || 'book:' + r.b.id;
    const g = vatGroups[k] = vatGroups[k] || { taxId: r.b.taxId, names: [], incVat: 0, expVat: 0 };
    g.names.push(r.b.name); g.incVat += r.t.incVat; g.expVat += r.t.expVat;
  });

  const months = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth(), i - 11));
  const series = months.map(m => ({ m, parts: ready.map(r => ({ b: r.b, v: totals(r.L, m, m) })) }));
  const top = Math.max(1, ...series.map(s => Math.max(s.parts.reduce((a, p) => a + p.v.incNet, 0), s.parts.reduce((a, p) => a + p.v.expNet, 0))));

  const alerts = ready.flatMap(r => {
    const out = [];
    if (r.d.storeLogin) out.push({ r, t: 'מקושר לחנות, אבל עוד לא התחברת אליה במכשיר הזה.', login: true });
    if (r.d.storeErr) out.push({ r, t: r.d.storeErr, bad: true });
    if (r.d.errors?.length) out.push({ r, t: 'חלק מהנתונים לא נטענו. בדוק את חוקי ה-Firestore.', bad: true });
    if (r.a.noDocOrders) out.push({ r, t: `${r.a.noDocOrders} הזמנות ששולמו בלי חשבונית` });
    if (r.a.unmatched) out.push({ r, t: `${r.a.unmatched} שורות בנק לא מותאמות` });
    if (r.a.noDocExp) out.push({ r, t: `${r.a.noDocExp} הוצאות בלי מספר חשבונית` });
    if (r.a.review) out.push({ r, t: `${r.a.review} רשומות מיובאות לבדיקה` });
    return out;
  });

  return (
    <>
      <div className="mg-h" style={{ '--h1': '#8a6331', '--h2': '#c4a36e' }}>
        <div><h2>כל העסקים</h2><div className="sub">{label} · {books.length} עסקים</div></div>
      </div>

      <div data-tour="all-period" style={{ ...row, marginBottom: 14 }}>
        <Field label="תקופה"><select value={mode} onChange={e => setMode(e.target.value)}>
          <option value="month">חודש</option><option value="bi">תקופת מע״מ (חודשיים)</option>
          <option value="ytd">מתחילת השנה</option><option value="year">שנה מלאה</option></select></Field>
        <Field label={mode === 'year' || mode === 'ytd' ? 'עד חודש' : 'חודש'}>
          <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /></Field>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`all-${from}_${to}.csv`, [
          ['עסק', 'הכנסות לפני מע״מ', 'הוצאות לפני מע״מ', 'רווח', 'מע״מ עסקאות', 'מע״מ תשומות'],
          ...ready.map(r => [r.b.name, r2(r.t.incNet), r2(r.t.expNet), r2(r.t.profit), r2(r.t.incVat), r2(r.t.expVat)]),
          ['סה״כ', r2(sum('incNet')), r2(sum('expNet')), r2(sum('profit')), r2(sum('incVat')), r2(sum('expVat'))]
        ])}>⬇ ייצוא</button>
      </div>

      <div data-tour="all-stats" className="mg-stats" style={{ marginBottom: 16 }}>
        <div className="mg-stat"><div className="lb">הכנסות (לפני מע״מ)</div><div className="vl">{fmt(sum('incNet'))}</div><div className="dl">כל העסקים · {label}</div></div>
        <div className="mg-stat"><div className="lb">הוצאות (לפני מע״מ)</div><div className="vl">{fmt(sum('expNet'))}</div></div>
        <div className="mg-stat"><div className="lb">רווח</div><div className="vl" style={sum('profit') < 0 ? { color: 'var(--bad)' } : undefined}>{fmt(sum('profit'))}</div></div>
        <div className="mg-stat"><div className="lb">מע״מ נטו</div><div className="vl">{fmt(sum('vatDue'))}</div><div className="dl">{sum('vatDue') >= 0 ? 'לתשלום' : 'להחזר'}</div></div>
      </div>

      <div data-tour="all-table" className="mg-tblwrap" style={{ marginBottom: 16 }}><table className="mg-tbl">
        <thead><tr><th>עסק</th><th>סוג</th><th>הכנסות</th><th>הוצאות</th><th>רווח</th><th>מע״מ</th><th></th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.b.id}>
              <td><span className="dot" style={{ background: r.b.color, display: 'inline-block', marginInlineEnd: 8 }} /><b>{r.b.name}</b></td>
              <td><span className="mg-chip">{KINDS[r.b.kind] || 'אחר'}</span> <span className="mg-chip">{DEALERS[r.b.dealerType]}</span></td>
              {r.pending
                ? <td colSpan={4} style={{ color: 'var(--muted)' }}>{loading[r.b.id] || r.loadingHist ? 'טוען…' : '—'}</td>
                : <><td>{fmt(r.t.incNet)}</td><td>{fmt(r.t.expNet)}</td>
                    <td style={{ color: r.t.profit < 0 ? 'var(--bad)' : undefined, fontWeight: 700 }}>{fmt(r.t.profit)}</td>
                    <td>{r.L.rate > 0 ? fmt(r.t.vatDue) : 'פטור'}</td></>}
              <td><button className="mg-btn ghost sm" onClick={() => onOpen(r.b.id)}>פתח</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={2}>סה״כ</td><td>{fmt(sum('incNet'))}</td><td>{fmt(sum('expNet'))}</td><td>{fmt(sum('profit'))}</td><td>{fmt(sum('vatDue'))}</td><td></td></tr></tfoot>
      </table></div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(320px,100%),1fr))', gap: 16, marginBottom: 16 }}>
        <div data-tour="all-vat" className="mg-card">
          <h3 style={{ marginTop: 0 }}>מע״מ לפי עוסק · {label}</h3>
          {Object.values(vatGroups).map((g, i) => (
            <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid #f0ebe0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>{g.taxId ? <span dir="ltr">{g.taxId}</span> : 'ללא ע.מ.'}</span>
                <span dir="ltr">{fmt(g.incVat - g.expVat)}</span></div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>{g.names.join(' + ')} · עסקאות {fmt(g.incVat)} · תשומות {fmt(g.expVat)}</div>
            </div>
          ))}
          {!Object.keys(vatGroups).length && <div className="mg-empty">כל העסקים מוגדרים כפטורים.</div>}
          {Object.values(vatGroups).some(g => !g.taxId) && (
            <div className="mg-note warn" style={{ marginTop: 10 }}>לעסקים בלי ע.מ. בהגדרות אי אפשר לדעת אם הם מדווחים יחד. כדאי למלא.</div>
          )}
        </div>
        <div data-tour="all-alerts" className="mg-card">
          <h3 style={{ marginTop: 0 }}>מה דורש טיפול</h3>
          {alerts.map((x, i) => (
            <div key={i} className={'mg-note' + (x.bad ? ' bad' : ' warn')} style={{ marginBottom: 8 }}>
              <b>{x.r.b.name}:</b> {x.t}{' '}
              {x.login ? <button className="mg-linkish" onClick={onStoreLogin}>התחבר לחנות</button>
                       : <button className="mg-linkish" onClick={() => onOpen(x.r.b.id)}>פתח</button>}</div>
          ))}
          {!alerts.length && <div className="mg-empty">הכול מסודר.</div>}
        </div>
      </div>

      <div data-tour="all-chart" className="mg-card">
        <h3 style={{ marginTop: 0 }}>12 חודשים · הכנסות לפי עסק (ימין) מול הוצאות (שמאל)</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 190, padding: '8px 0' }}>
          {series.map(s => (
            <div key={s.m} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%' }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, width: '100%', justifyContent: 'center' }}>
                <div style={{ width: '42%', display: 'flex', flexDirection: 'column-reverse', height: '100%' }}>
                  {s.parts.map(p => <div key={p.b.id} title={`${p.b.name} · ${fmt(p.v.incNet)}`}
                    style={{ height: `${Math.max(0, p.v.incNet) / top * 100}%`, background: p.b.color }} />)}
                </div>
                <div style={{ width: '30%', display: 'flex', flexDirection: 'column-reverse', height: '100%' }}>
                  <div title={`הוצאות · ${fmt(s.parts.reduce((a, p) => a + p.v.expNet, 0))}`}
                       style={{ height: `${s.parts.reduce((a, p) => a + p.v.expNet, 0) / top * 100}%`, background: '#d8cfbd', borderRadius: '3px 3px 0 0' }} />
                </div>
              </div>
              <div className="mlab">{monthName(s.m)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, color: 'var(--muted)' }}>
          {books.map(b => <span key={b.id}><span style={{ color: b.color }}>■</span> {b.name}</span>)}
          <span><span style={{ color: '#d8cfbd' }}>■</span> הוצאות (כל העסקים)</span>
        </div>
      </div>
    </>
  );
}

/* ================================================================ one book */
/* The round button in the corner, as in iCount: a new document, a payment
   page or an expense, from any tab, in one or two taps. */
function QuickFab({ book, canPay, canExpense, onDoc, onPay, onExpense }) {
  const [open, setOpen] = useState(false);
  /* A credit note is issued from the invoice it credits, not from here. */
  const types = allowedTypes(book).filter(t => t !== '330');
  if (!types.length) return null;
  const go = (f) => { setOpen(false); f(); };
  useEffect(() => { if (!open) return; const k = (e) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open]);
  return (
    <>
      {open && <div className="fab-back" onClick={() => setOpen(false)} />}
      <div className={'fab' + (open ? ' open' : '')} data-tour="fab">
        {open && <div className="fab-menu" role="menu">
          {types.map(t => <button key={t} role="menuitem" className={'fab-item' + (t === types[0] ? ' main' : '')} onClick={() => go(() => onDoc(t))}>🧾 {DOC_TYPES[t].label}</button>)}
          {canPay && <button role="menuitem" className="fab-item" onClick={() => go(onPay)}>💳 דף סליקה</button>}
          {canExpense && <button role="menuitem" className="fab-item" onClick={() => go(onExpense)}>＋ הוצאה</button>}
        </div>}
        <button className="fab-btn" aria-label={open ? 'סגור' : 'מסמך חדש'} aria-expanded={open}
                onClick={() => open ? setOpen(false) : setOpen(true)}>{open ? '×' : '＋'}</button>
      </div>
    </>
  );
}

/* ============================================================ business settings */
/* Everything a business is set up with, in one place: what is ready (✓),
   what is missing, and the button that sets it up right there. */
function SetRow({ icon, title, ok, status, children, onOpen, open }) {
  return (
    <div className="mg-card bset-row" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={onOpen}>
        <span style={{ fontSize: 24, width: 32, textAlign: 'center' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{title}</div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>{status}</div>
        </div>
        <span className={'mg-chip ' + (ok === true ? 'ok' : ok === false ? 'warn' : '')}>{ok === true ? '✓ מוגדר' : ok === false ? 'לא מוגדר' : '—'}</span>
        <span style={{ fontSize: 18, color: 'var(--muted)' }}>{open ? '▴' : '▾'}</span>
      </div>
      {open && <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>{children}</div>}
    </div>
  );
}
function BookSettings({ book, data, cols, flash, server, user, payOk, role, onEditBook, onStoreLogin, onGo, onGlobal, onServer, onReload, onLog }) {
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem('tzbooks_bset') || ''; } catch { return ''; } });
  const tog = (k) => { const n = open === k ? '' : k; setOpen(n); try { sessionStorage.setItem('tzbooks_bset', n); } catch {} };
  const [inbox, setInbox] = useState(null);
  const [icount, setIcount] = useState(null);
  const [gmail, setGmail] = useState(false);
  useEffect(() => {
    if (!cloud || !server) return;
    if (server.inbox) inboxCall('inbox-list', book.id).then(setInbox).catch(() => setInbox({}));
    fnCall({ action: 'icount-status', book: book.id }).then(setIcount).catch(() => setIcount({}));
  }, [book.id, server]);
  const prof = lsGet(TAX_PROFILE_KEY, {}) || {}, tid = digitsOf(book.taxId) || book.id;
  const pays = data.payreqs || [], openPays = pays.filter(p => p.status === 'open').length;
  const rec = (data.recurring || []).filter(r => r.active !== false);
  const rate = rateOf(book);
  const owner = role === 'owner';
  const series = docSeries(book);
  return (
    <div data-tour="bset" style={{ display: 'grid', gap: 10 }}>
      <SetRow icon="🏢" title="פרטי העסק" ok={digitsOf(book.taxId).length === 9} open={open === 'biz'} onOpen={() => tog('biz')}
              status={`${book.legalName || book.name} · ${DEALERS[book.dealerType]}${book.taxId ? ' · ' + book.taxId : ' · חסר מספר עוסק'}${rate ? ` · מע״מ ${rate}%` : ''}`}>
        <div style={{ fontSize: 14, lineHeight: 1.8 }}>
          שם על המסמכים: <b>{book.legalName || book.name}</b><br />
          {book.address ? <>כתובת: {book.address}<br /></> : null}{book.phone ? <>טלפון: {book.phone}<br /></> : null}{book.email ? <>אימייל: {book.email}<br /></> : null}
          מסמכים: <b>{series === 'live' ? 'מצב אמיתי' : 'מצב ניסיון (T-)'}</b>{book.docStart ? ` · מספור מ-${book.docStart}` : ''}
        </div>
        {owner && <button className="mg-btn sm" style={{ marginTop: 8 }} onClick={onEditBook}>✎ עריכת פרטי העסק, מצב המסמכים והמספור</button>}
      </SetRow>

      <SetRow icon="💳" title="דפי סליקה · זד קרדיט ויופיי" ok={!!(payOk?.zcredit || payOk?.upay)} open={open === 'pay'} onOpen={() => tog('pay')}
              status={(payOk?.zcredit || payOk?.upay) ? `מחובר דרך ${[payOk.zcredit && 'זד קרדיט', payOk.upay && 'יופיי'].filter(Boolean).join(' ו')} · ${pays.length} דפי סליקה${openPays ? `, ${openPays} ממתינים לתשלום` : ''}` : !server ? 'דורש את השרת (ההתקנה מ-GitHub)' : !server?.pay?.admin ? 'חסר מפתח שירות של Firebase בשרת' : 'חסר מפתח זד קרדיט או אימייל יופיי לעסק הזה'}>
        {(payOk?.zcredit || payOk?.upay) && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <button className="mg-btn sm" onClick={() => onGo('docs', { pay: true })}>💳 דף סליקה חדש</button>
          <button className="mg-btn ghost sm" onClick={() => onGo('docs')}>רשימת דפי הסליקה ({pays.length})</button>
        </div>}
        {owner && <PayCard server={server} books={[book]} user={user} flash={flash} onServer={onServer} />}
      </SetRow>

      <SetRow icon="🔗" title="iCount" ok={icount ? !!icount.linked : null} open={open === 'icount'} onOpen={() => tog('icount')}
              status={icount?.linked ? `מחובר${book.icountAuto ? ' · סנכרון יומי אוטומטי' : ''}${book.icountSyncAt ? ` · עודכן ${new Date(book.icountSyncAt).toLocaleDateString('he-IL')}` : ''}` : 'משיכת מסמכים מ-iCount בלי קבצים'}>
        {owner ? <ICountLive book={book} data={data} cols={cols} flash={flash} onDone={onReload} onLog={onLog} server={server} /> : <div className="mg-note">רק בעלי העסק מגדירים את החיבור.</div>}
      </SetRow>

      <SetRow icon="📥" title="חשבוניות ספקים מ-Gmail" ok={inbox ? !!inbox.keyed : null} open={open === 'gmail'} onOpen={() => tog('gmail')}
              status={inbox?.keyed ? `פעיל${inbox.lastAt ? ` · אחרונה התקבלה ${new Date(inbox.lastAt).toLocaleDateString('he-IL')}` : ' · עוד לא התקבלה חשבונית'}${inbox.items?.length ? ` · ${inbox.items.length} ממתינות` : ''}` : 'חשבוניות שמגיעות למייל נכנסות לבד להוצאות'}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {owner && <button className="mg-btn sm" onClick={() => setGmail(true)}>{inbox?.keyed ? '⚙ הסקריפט והמפתח' : 'חבר את Gmail'}</button>}
          <button className="mg-btn ghost sm" onClick={() => onGo('expenses')}>לחשבוניות שהגיעו</button>
        </div>
        {gmail && <GmailSetup book={book} flash={flash} onClose={() => { setGmail(false); inboxCall('inbox-list', book.id).then(setInbox).catch(() => {}); }} />}
      </SetRow>

      <SetRow icon="🛒" title="החנות" ok={book.tenant ? !(data.storeErr || data.storeLogin) : null} open={open === 'store'} onOpen={() => tog('store')}
              status={book.tenant ? (data.storeErr ? 'שגיאה בקריאת החנות' : data.storeLogin ? 'מקושר, צריך להתחבר' : `מקושר לחנות ${book.tenant}${data.storeAt ? ` · ${(data.orders || []).length} הזמנות` : ''}`) : 'לא מקושר לחנות'}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>{book.tenant ? 'הזמנות שולמו בחנות נספרות כהכנסה, ולקוחות החנות מתמזגים ללקוחות.' : 'קישור לחנות נעשה בפרטי העסק (מזהה החנות).'}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {owner && <button className="mg-btn ghost sm" onClick={onEditBook}>✎ מזהה החנות</button>}
          {book.tenant && <button className="mg-btn ghost sm" onClick={onStoreLogin}>התחברות לחנות</button>}
          {book.tenant && <button className="mg-btn ghost sm" onClick={onReload}>↻ רענון מהחנות</button>}
        </div>
      </SetRow>

      <SetRow icon="🏛" title="רשות המסים · מספרי הקצאה" ok={server?.ita?.configured ? null : false} open={open === 'ita'} onOpen={() => tog('ita')}
              status={server?.ita?.configured ? 'חיבור לבקשת מספרי הקצאה אוטומטית' : 'לא מוגדר בשרת · אפשר להזין מספר הקצאה ידנית'}>
        {owner && <ItaCard server={server} books={[book]} user={user} flash={flash} />}
        <button className="mg-btn ghost sm" style={{ marginTop: 8 }} onClick={() => onGo('tax')}>לשונית רשות המסים (מבנה אחיד, רישום תוכנה)</button>
      </SetRow>

      <SetRow icon="🧾" title="מיסים ומקדמות" ok={Number(prof.advRate?.[tid]) > 0 && (isCompanyId(tid) || Number(prof.blMonthly?.[tid]) > 0)} open={open === 'tax'} onOpen={() => tog('tax')}
              status={`מקדמת מס הכנסה ${Number(prof.advRate?.[tid]) > 0 ? prof.advRate[tid] + '%' : 'לא הוזנה'}${isCompanyId(tid) ? '' : ` · ביטוח לאומי ${Number(prof.blMonthly?.[tid]) > 0 ? fmt(prof.blMonthly[tid]) + ' לחודש' : 'לא הוזן'}`} · דיווח ${(prof.freq?.[tid] || 'bi') === 'month' ? 'חודשי' : 'דו-חודשי'}`}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>השיעורים מההודעות של מס הכנסה וביטוח לאומי, נקודות הזיכוי ותדירות הדיווח. נמצאים בלשונית "לתשלום" ובצפי המס ברווח והפסד.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="mg-btn sm" onClick={() => onGo('pay')}>לתשלום לרשויות</button>
          <button className="mg-btn ghost sm" onClick={() => onGo('pnl')}>צפי מס הכנסה</button>
        </div>
      </SetRow>

      <SetRow icon="🔁" title="הוצאות קבועות" ok={rec.length ? true : null} open={open === 'rec'} onOpen={() => tog('rec')}
              status={rec.length ? `${rec.length} הוצאות · ${fmt(rec.reduce((a, r) => a + (Number(r.gross) || 0) * Math.min(100, Math.max(1, Number(r.share) || 100)) / 100, 0))} בחודש` : 'שכירות, טלפון, ביטוח: נרשמות לבד כל חודש'}>
        <button className="mg-btn sm" onClick={() => onGo('expenses')}>לניהול ההוצאות הקבועות</button>
      </SetRow>

      <SetRow icon="👥" title="משתמשים והרשאות" ok={null} open={open === 'users'} onOpen={() => tog('users')}
              status={`בעלים: ${(book.owners || []).length} · מפיקי מסמכים: ${(book.clerks || []).length} · צפייה (רו״ח): ${(book.viewers || []).length}`}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>למשל: לתת לששון גישת צפייה, או לעובדת הרשאה להפיק מסמכים בלבד.</div>
        <button className="mg-btn sm" onClick={() => onGlobal('users')}>למסך המשתמשים</button>
      </SetRow>

      <SetRow icon="☁️" title="גיבוי, ענן, קוד נעילה וארכיון" ok={!!cloud} open={open === 'cloud'} onOpen={() => tog('cloud')}
              status={cloud ? 'מחובר לענן · גיבוי שבועי וארכיון חודשי במייל' : 'עובד במכשיר בלבד'}>
        <button className="mg-btn sm" onClick={() => onGlobal('settings')}>למסך גיבוי וענן</button>
      </SetRow>
    </div>
  );
}

/* Payment pages, in a place of their own: the list, a new page, and when
   none can be made yet, what is missing and where to set it up. */
function PayPagesTab({ book, data, payOk, server, role, ro, flash, onCreated, onCancel, onRefresh, onSetup, onReplace }) {
  const list = data.payreqs || [];
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const onNew = () => setForm(true);
  const ready = !!(payOk?.zcredit || payOk?.upay);
  const paid = list.filter(p => p.status === 'paid'), open = list.filter(p => p.status === 'open');
  return (
    <div data-tour="paypages">
      {ready ? <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {!ro && <button className="mg-btn" style={{ background: '#1f4e79' }} onClick={onNew}>💳 דף סליקה חדש</button>}
        <span style={{ fontSize: 14, color: 'var(--muted)' }}>דרך {[payOk.zcredit && 'זד קרדיט', payOk.upay && 'יופיי'].filter(Boolean).join(' או ')} · {open.length} ממתינים · {paid.length} שולמו{paid.length ? ` (${fmt(paid.reduce((a, p) => a + (Number(p.total) || 0), 0))})` : ''}</span>
      </div> : <div className="mg-card" style={{ marginBottom: 14 }}>
        <h3 style={{ marginTop: 0 }}>💳 דפי סליקה</h3>
        <p style={{ marginTop: 0, fontSize: 15 }}>שולחים ללקוח קישור, הוא משלם בכרטיס אשראי, ומיד מופקת לו חשבונית מס קבלה ונשלחת אליו.</p>
        <div className="mg-note warn" style={{ fontSize: 14 }}>
          {!cloud ? 'דפי סליקה פועלים רק כשהמערכת מחוברת לענן.'
            : !server ? 'דפי סליקה צריכים את השרת (ההתקנה מ-GitHub ל-Netlify).'
            : !server.pay?.admin ? 'חסר בשרת מפתח שירות של Firebase (קובץ JSON חד-פעמי).'
            : 'לעסק הזה עוד לא הוגדר ספק סליקה: מפתח זד קרדיט או אימייל של חשבון יופיי.'}</div>
        {role === 'owner' && cloud && server && <button className="mg-btn" style={{ marginTop: 10 }} onClick={onSetup}>⚙ הגדרת דפי סליקה</button>}
      </div>}
      {list.length > 0 ? <PayList book={book} list={list} onCancel={onCancel} onRefresh={onRefresh} flash={flash} ro={ro} onEdit={ready ? (p) => setEditing(p) : null} />
        : ready && <div className="mg-empty">עוד אין דפי סליקה. "💳 דף סליקה חדש" יוצר קישור לתשלום ושולח אותו ללקוח בוואטסאפ או במייל.</div>}
      {form && <PayForm book={book} payOk={payOk} docs={data.documents || []} customers={data.customers || []} items={data.items || []} flash={flash}
                        onCreated={onCreated} onClose={() => setForm(false)} />}
      {editing && <PayForm book={book} payOk={payOk} docs={data.documents || []} customers={data.customers || []} items={data.items || []} flash={flash} preset={editing}
                           onCreated={(r, c) => { onCreated(r, c); onReplace(editing, r); }} onClose={() => setEditing(null)} />}
    </div>
  );
}

function BookView({ book, data, patch, flash, onReload, onEditBook, onDeleteBook, onStoreLogin, server, ro, role = 'owner', onTab, tabReq, onTabDone, siblings = [], onLoadSiblings, user, onGlobal, onServer }) {
  const clerk = role === 'clerk';
  const [sub, setSub] = useState(clerk ? 'docs' : 'dash');
  const [ledgerPick, setLedgerPick] = useState(null);
  const [quickDoc, setQuickDoc] = useState(null);
  /* Fixed expenses due by today are recorded (owners only; each month's id is fixed, so never twice). */
  const recRunning = useRef(false);
  const [recTick, setRecTick] = useState(0);
  useEffect(() => {
    if (role !== 'owner' || recRunning.current || !(data.recurring || []).length) return;
    const due = recurringDue(data.recurring);
    if (!due.length) return;
    recRunning.current = true;
    (async () => {
      const have = new Set((data.expenses || []).map(e => e.id));
      let n = 0;
      for (const { rule, month } of due) {
        const e = recExpense(rule, month, rate);
        if (!have.has(e.id)) { if (await save('expenses', e)) n++; else break; }
        const r = clean({ ...rule, lastMonth: month, updatedAt: new Date().toISOString() });
        try { await withTimeout(cols.recurring.put(r.id, r), 12000); patch('recurring', l => l.map(x => x.id === r.id ? r : x)); rule.lastMonth = month; } catch { break; }
      }
      if (n) flash(`נרשמו ${n} הוצאות קבועות`);
      recRunning.current = false;
      /* Rules changed while this ran (a whole year filled at once): look again. */
      if (n) setRecTick(t => t + 1);
    })();
  }, [data.recurring, role, recTick]);
  /* Income tax is per person: every business under the same tax id counts together. */
  const taxRows = useMemo(() => {
    const y = todayIso().slice(0, 4), to = thisMonth();
    const one = (b, d) => { if (!d || d.histPending) return { name: b.name, ready: false, profit: 0 };
      return { name: b.name, ready: true, profit: totals(buildLedger(b, d), `${y}-01`, to).profit }; };
    return [one(book, data), ...siblings.map(x => one(x.book, x.data))];
  }, [book, data, siblings]);
  /* Straight to a new document (or payment page) from anywhere in the business. */
  const openDoc = (type, pay) => { setSub('docs'); setQuickDoc({ at: Date.now(), type, pay }); };
  useEffect(() => { onTab?.(sub); }, [sub]);
  /* On a narrow screen the tabs scroll sideways: keep the chosen one in view. */
  useEffect(() => { if (window.innerWidth < 1100) document.querySelector('.book-tabs .mg-tab.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }, [sub]);
  useEffect(() => { if (tabReq) { if (SUBS.some(([k]) => k === tabReq)) setSub(tabReq); onTabDone?.(); } }, [tabReq]);
  const [edit, setEdit] = useState(null);
  const cols = useMemo(() => Object.fromEntries(COLS.map(c => [c, bookCol(book.id, c)])), [book.id]);
  const ledger = useMemo(() => buildLedger(book, data), [book, data]);
  const rate = ledger.rate;
  const tot = (f, t) => totals(ledger, f, t);
  const alerts = alertsOf(data, ledger);
  const suppliers = data.suppliers || [];
  const supName = (id) => suppliers.find(s => s.id === id)?.name || '';
  const [inboxTick, setInboxTick] = useState(0);
  const openExpFile = async (e) => { try { showBlob((await inboxOpen(book.id, e.file.inboxId)).blob); } catch { flash('פתיחת הקובץ נכשלה'); } };

  const save = async (name, rec) => {
    const r = clean({ ...rec, updatedAt: new Date().toISOString() });
    try { await withTimeout(cols[name].put(r.id, r), 12000); }
    catch { flash('השמירה נכשלה. בדוק את החיבור ואת חוקי Firestore.'); return false; }
    patch(name, list => [...list.filter(x => x.id !== r.id), r]);
    return true;
  };
  const remove = async (name, id, what) => {
    if (!window.confirm(`למחוק את ${what}?`)) return;
    try { await withTimeout(cols[name].del(id), 12000); patch(name, list => list.filter(x => x.id !== id)); flash('נמחק'); }
    catch { flash('המחיקה נכשלה'); }
  };

  /* Issue: the number is taken with the document; the stamp is worked out
     from its final content. Then only printCount and the like may change. */
  /* Allocation numbers: is this business connected to the Tax Authority? */
  const [ita, setIta] = useState(null);
  useEffect(() => {
    if (!cloud || !server?.ita?.configured || digitsOf(book.taxId).length !== 9) { setIta(null); return; }
    fnCall({ action: 'ita-status', vat: digitsOf(book.taxId) }).then(setIta).catch(() => setIta(null));
  }, [book.taxId, server?.ita?.configured]);
  const setAlloc = async (d, no, how) => {
    const at = new Date().toISOString();
    await DB.patch(`books/${book.id}/documents`, d.id, { allocationNo: String(no), allocationAt: at });
    patch('documents', list => list.map(x => x.id === d.id ? { ...x, allocationNo: String(no), allocationAt: at } : x));
    log({ action: 'allocation', docId: d.id, title: `${docTitle(d)} · ${String(no).slice(-9)}${how === 'manual' ? ' (ידני)' : ''}`, series: d.series });
  };
  const requestAlloc = async (d) => {
    try {
      const r = await fnCall({ action: 'ita-approve', invoice: itaPayload(book, d) });
      if (r.approved && r.confirmation_number && r.confirmation_number !== '0') { await setAlloc(d, r.confirmation_number, 'ita'); flash(`התקבל מספר הקצאה ${String(r.confirmation_number).slice(-9)}`); return true; }
      const why = typeof r.message === 'string' ? r.message : (r.message?.errors || []).map(e => `${e.code} ${e.message}`).join(', ');
      flash('רשות המסים לא אישרה · ' + (why || 'ללא פירוט'));
    } catch (e) {
      flash(e.message === 'ita-not-connected' ? 'העסק לא מחובר לרשות המסים (גיבוי וענן ← מספרי הקצאה)'
          : e.message === 'ita-expired' ? 'החיבור לרשות המסים פג. צריך להתחבר מחדש (פעם בשלושה חודשים)' : 'בקשת מספר ההקצאה נכשלה · ' + e.message);
    }
    return false;
  };
  const issueDoc = async (rec) => {
    const key = `${rec.series}_${rec.type}`;
    const have = (data.documents || []).filter(d => d.series === rec.series && d.type === rec.type).map(d => Number(d.number) || 0);
    const start = Math.max(rec.series === 'live' ? (Number(book.docStart) || 1) : 1, have.length ? Math.max(...have) + 1 : 0);
    const withStamp = { ...rec, stamp: await stampOf({ ...rec, number: '?' }) };
    const d = await withTimeout(DB.issue(book.id, key, start, clean(withStamp)), 20000);
    patch('documents', list => [...list.filter(x => x.id !== d.id), d]);
    /* The customer on the document joins the list, or fills in what it lacked. */
    const cp = planCustomers(data.customers || [], [d.customer || {}], 'doc');
    if (cp.add.length + cp.upd.length) {
      await saveCustomers(cols.customers, [...cp.add, ...cp.upd]);
      patch('customers', () => cp.all);
    }
    log({ action: 'issue', docId: d.id, title: docTitle(d) + ' · ' + fmt(d.total), series: d.series });
    /* Straight after issuing, when it needs one and none was typed in. */
    if (needsAlloc(book, d) && !d.allocationNo && ita?.connected) requestAlloc(d);
    return d;
  };
  const log = async (entry) => { const l = await logAct(book.id, entry); patch('log', list => [...list, l]); };
  /* Payment pages: can this business make them? */
  const [payOk, setPayOk] = useState(null);
  useEffect(() => {
    if (!cloud || !server?.pay?.admin || ro) { setPayOk(null); return; }
    fnCall({ action: 'pay-status', book: book.id }).then(setPayOk).catch(() => setPayOk(null));
  }, [book.id, server?.pay?.admin]);
  const payCreated = async (r, cust) => {
    patch('payreqs', l => [...l.filter(x => x.id !== r.id), r]);
    const cp = planCustomers(data.customers || [], [cust || {}], 'doc');
    if (cp.add.length + cp.upd.length) { await saveCustomers(cols.customers, [...cp.add, ...cp.upd]); patch('customers', () => cp.all); }
  };
  /* An edited page: the old link stops working, pointing to the new one. */
  const payReplace = async (old, nu) => {
    /* Only the fields the rules let a cancellation touch. */
    const f = { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: cloud?.auth?.currentUser?.email || '' };
    try { await DB.patch(`books/${book.id}/payreqs`, old.id, f); patch('payreqs', l => l.map(x => x.id === old.id ? { ...x, ...f } : x)); }
    catch { flash('הקישור החדש נוצר, אבל ביטול הקישור הקודם נכשל. בטל אותו ידנית.'); }
  };
  const payCancel = async (p) => {
    if (!window.confirm(`לבטל את הקישור לתשלום של ${p.customer?.name} (${fmt(p.total)})? מי שיפתח אותו יראה שהוא בוטל.`)) return;
    const f = { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: cloud?.auth?.currentUser?.email || '' };
    try { await DB.patch(`books/${book.id}/payreqs`, p.id, f); patch('payreqs', l => l.map(x => x.id === p.id ? { ...x, ...f } : x)); flash('הקישור בוטל'); }
    catch { flash('הביטול נכשל (אולי כבר שולם). רענן ונסה שוב.'); }
  };
  /* iCount: new documents come in by themselves each time the business opens
     (at most every 20 minutes), and on request. The result, or the error, is
     shown, never swallowed. The range reaches tomorrow so today is always in. */
  const [ic, setIc] = useState({ at: book.icountSyncAt || '', busy: false, err: '', msg: '' });
  const icSync = async (manual) => {
    if (ic.busy) return;
    setIc(x => ({ ...x, busy: true, err: '', msg: '' }));
    try {
      const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      const from = new Date(Date.now() - (manual ? 60 : 20) * 864e5).toISOString().slice(0, 10);
      const r = await icountPull(book, from, to);
      const s0 = await icountSave(cols, data, r.docs, book.id);
      const at = new Date().toISOString();
      await DB.patch('books', book.id, { icountSyncAt: at, icountErr: '' }).catch(() => {});
      const msg = s0.n ? `נכנסו ${s0.n} מסמכים חדשים מ-iCount` : `iCount: ${r.docs.length} מסמכים ב-${manual ? 60 : 20} הימים האחרונים, כולם כבר כאן`;
      setIc({ at, busy: false, err: '', msg });
      if (s0.n || manual) flash(msg);
      if (s0.n) onReload();
    } catch (e) {
      const m = String(e?.message || e);
      const err = m === 'icount-not-linked' ? 'iCount לא מחובר לעסק הזה (⚙ הגדרות ← iCount)'
        : m === 'owners only' || m === 'not allowed' ? 'השרת לא זיהה אותך כבעל העסק (ייתכן עומס זמני ב-Google). נסה שוב בעוד כמה דקות.'
        : /auth|token|401|unauthori|invalid_(api|key|user)/i.test(m) ? 'iCount דחה את המפתח. צריך מפתח API חדש (⚙ הגדרות ← iCount).'
        : 'המשיכה מ-iCount נכשלה · ' + m;
      await DB.patch('books', book.id, { icountErr: err, icountErrAt: new Date().toISOString() }).catch(() => {});
      setIc(x => ({ ...x, busy: false, err }));
      if (manual) flash(err);
    }
  };
  useEffect(() => {
    if (!cloud || !server || role !== 'owner' || !book.icountAuto) return;
    if (Date.now() - Date.parse(book.icountSyncAt || 0) < 20 * 60e3) return;
    icSync(false);
  }, [book.id, !!server]);
  const payRefresh = async () => {
    const [p, d] = await Promise.all([cols.payreqs.list().catch(() => null), cols.documents.list().catch(() => null)]);
    if (p) patch('payreqs', () => p); if (d) patch('documents', () => d);
  };
  const sentDoc = async (d, to) => {
    const n = (d.printCount || 0) + 1, at = new Date().toISOString();
    try { await DB.patch(`books/${book.id}/documents`, d.id, { printCount: n, sentAt: at, sentTo: to }); } catch {}
    patch('documents', list => list.map(x => x.id === d.id ? { ...x, printCount: n, sentAt: at, sentTo: to } : x));
    log({ action: 'send', docId: d.id, title: `${docTitle(d)} ← ${to}`, series: d.series });
  };
  const printedDoc = async (d, quiet) => {
    if (!quiet) log({ action: 'print', docId: d.id, title: docTitle(d) + ((d.printCount || 0) > 0 ? ' (העתק)' : ' (מקור)'), series: d.series });
    const n = (d.printCount || 0) + 1;
    try { await DB.patch(`books/${book.id}/documents`, d.id, { printCount: n, printedAt: new Date().toISOString() }); } catch {}
    patch('documents', list => list.map(x => x.id === d.id ? { ...x, printCount: n } : x));
  };

  const TAB_GROUP = { docs: 'עבודה יומית', paypages: 'עבודה יומית', customers: 'עבודה יומית', items: 'עבודה יומית',
    income: 'כספים', expenses: 'כספים', suppliers: 'כספים', bank: 'כספים', ledger: 'כספים',
    vat: 'דוחות ומיסים', pay: 'דוחות ומיסים', pnl: 'דוחות ומיסים', tax: 'דוחות ומיסים', export: 'כלים', import: 'כלים' };
  const SUBS = [['dash', 'סקירה'], ['docs', 'מסמכים'], ...(ro ? [] : [['paypages', '💳 סליקה' + ((data.payreqs || []).filter(p => p.status === 'open').length ? ` (${(data.payreqs || []).filter(p => p.status === 'open').length})` : '')]]), ['customers', 'לקוחות'], ['items', 'פריטים'], ['income', 'הכנסות'], ['expenses', 'הוצאות'], ['suppliers', 'ספקים'], ['ledger', 'כרטסת'],
    ['bank', 'בנק' + (alerts.unmatched ? ` (${alerts.unmatched})` : '')], ['vat', 'מע״מ'], ...(role === 'owner' ? [['pay', 'לתשלום']] : []), ['pnl', 'רווח והפסד'], ['tax', 'רשות המסים'], ['export', 'ייצוא'], ...(ro ? [] : [['import', 'ייבוא']])]
    .filter(([k]) => !clerk || ['docs', 'paypages', 'customers', 'items'].includes(k));

  return (
    <div className={ro ? 'ro' : ''}>
      {ro && <div className="mg-note" style={{ marginBottom: 12 }}><b>צפייה בלבד.</b> אפשר לראות, להדפיס ולייצא. הפקה ושינויים שמורים לבעלי העסק.</div>}
      <div data-tour="book-head" className="mg-h" style={{ '--h1': book.color || '#8a6331', '--h2': '#c4a36e' }}>
        <div><h2>{book.name}</h2>
          <div className="sub">{DEALERS[book.dealerType]}{book.taxId ? ' · ' + book.taxId : ''}{rate > 0 ? ` · מע״מ ${rate}%` : ''}
            {book.tenant ? ` · מקושר לחנות ${book.tenant}` : ''}</div></div>
        {!ro && allowedTypes(book).length > 0 && <button data-tour="quick-doc" className="mg-btn hdr-act" style={{ background: '#fff', color: 'var(--green)', fontWeight: 700 }}
          onClick={() => openDoc()}>🧾 {DOC_TYPES[allowedTypes(book)[0]].label}</button>}
        {role === 'owner' && <>
          <button className="mg-btn ghost hdr-act" onClick={() => setEdit({ kind: 'expense', rec: null })}>＋ הוצאה</button>
          {/* Income is recorded by issuing its document: the same form, with customers and items. */}
          <button className="mg-btn ghost hdr-act" onClick={() => openDoc()}>＋ הכנסה</button>
          <button data-tour="hdr-settings" className={'mg-btn ghost hdr-set' + (sub === 'bset' ? ' on' : '')} onClick={() => setSub('bset')} aria-label="הגדרות העסק">⚙ <span className="hdr-set-t">הגדרות</span></button></>}
        {role !== 'owner' && <span className="mg-chip" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }}>{ROLES[role]}</span>}
      </div>

      {(data.histPending || data.storePending) && <div className="mg-note" style={{ marginBottom: 12, fontSize: '.92em' }}>
        ⏳ טוען ברקע {[data.histPending && 'היסטוריית מסמכים', data.storePending && 'הזמנות מהחנות'].filter(Boolean).join(' ו')}… אפשר לעבוד בינתיים.</div>}
      {data.storeLogin && <div className="mg-note warn" style={{ marginBottom: 12 }}>
        העסק מקושר לחנות <b dir="ltr">{book.tenant}</b>. כדי למשוך ממנה את ההזמנות צריך להתחבר אליה במכשיר הזה, או פעם אחת לכל המכשירים (גיבוי וענן ← חיבור לחנות ← חיבור קבוע).{' '}
        <button className="mg-btn sm" onClick={onStoreLogin}>התחבר לחנות</button></div>}
      {data.storeErr && <div className="mg-note bad" style={{ marginBottom: 12 }}>{data.storeErr}{' '}
        <button className="mg-linkish" onClick={onStoreLogin}>התחבר עם משתמש אחר</button></div>}
      {book.tenant && data.storeAt && (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
          נמשכו מהחנות {data.orders.length} הזמנות ({data.orders.filter(isPaidOrder).length} ששולמו) · עודכן {new Date(data.storeAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}{' '}
          <button className="mg-linkish keep" onClick={onReload}>רענן מהחנות</button></div>
      )}
      {data.errors?.length > 0 && <div className="mg-note bad" style={{ marginBottom: 12 }}>
        חלק מהנתונים לא נטענו ({data.errors.join(', ')}). בדוק שחוקי ה-Firestore המעודכנים פורסמו.{' '}
        <button className="mg-linkish" onClick={onReload}>נסה שוב</button></div>}

      {/* On a computer the tabs stand as a side bar, grouped; on phones and tablets they scroll across the top. */}
      <div className="book-body">
      <nav data-tour="book-tabs" className="mg-tabs book-tabs" style={{ marginBottom: 16 }} aria-label="לשוניות העסק">
        {SUBS.map(([k, l], i) => { const g = TAB_GROUP[k], pg = i ? TAB_GROUP[SUBS[i - 1][0]] : null; return (
          <React.Fragment key={k}>
            {g && g !== pg && <div className="tab-group">{g}</div>}
            <button className={'mg-tab' + (sub === k ? ' on' : '')} onClick={() => setSub(k)}>{l}</button>
          </React.Fragment>); })}
      </nav>
      <div className="book-main">

      {sub === 'dash' && <Dash totals={tot} rate={rate} alerts={alerts} onSub={setSub} linked={!!book.tenant}
                               payNote={role === 'owner' && Number(todayIso().slice(8, 10)) <= 20 ? (() => {
                                 const tid = digitsOf(book.taxId) || book.id, prof = lsGet(TAX_PROFILE_KEY, {}) || {}, freq = prof.freq?.[tid] || 'bi';
                                 const p = lastPeriod(freq); if (p.end !== addMonths(thisMonth(), -1)) return null;
                                 const r = authReport([{ book, data }, ...siblings], p, prof, tid);
                                 return <div className="mg-note warn" style={{ marginBottom: 14, cursor: 'pointer' }} onClick={() => setSub('pay')}>
                                   🧾 <b>לתשלום לרשויות · {periodLabel(p)}:</b> {r.lines.map(l => `${l.label} ${fmt(l.amount)}`).join(' · ')}. סה״כ <b>{fmt(r.total)}</b>, עד {dueOf(p)}. לחץ להשוואה מול רואה החשבון.</div>; })() : null}
                               taxTile={role === 'owner' ? <div role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setSub('pnl')}><TaxForecast compact book={book} rows={taxRows} /></div> : null} />}
      {sub === 'income' && <IncomeList income={ledger.income} linked={!!book.tenant} onDoc={ro ? null : () => openDoc()} onManual={role === 'owner' ? () => setEdit({ kind: 'income', rec: null }) : null}
        onEdit={(r) => setEdit({ kind: 'income', rec: r })} onDel={(r) => remove('incomes', r.id, 'ההכנסה')} />}
      {sub === 'expenses' && role === 'owner' && <RecurringCard book={book} data={data} rate={rate} cols={cols} patch={patch} flash={flash} suppliers={suppliers} />}
      {sub === 'expenses' && !ro && <InboxCard book={book} server={server} role={role} flash={flash} refreshKey={inboxTick}
        onRecord={(it, g, reload) => {
          const sup = matchSupplier(suppliers, { ...g, from: it.from, fromName: it.fromName });
          const f = { date: g.date || d10(it.date) || todayIso(), supplierId: sup?.id || '', desc: it.subject || it.name || '',
                      gross: g.gross ? String(g.gross) : '', docNo: g.docNo || '', pay: PAY_METHODS[0],
                      ...(g.vatMode ? { vatMode: g.vatMode } : {}), ...(g.vatManual ? { vatManual: String(g.vatManual) } : {}),
                      file: { inboxId: it.id, name: it.name, mime: it.mime } };
          /* This month's estimate from the same supplier (a fixed expense marked as an estimate) is replaced, not doubled. */
          const tok = (x) => nameToks(x).filter(t => t.length > 2);
          const est = (data.expenses || []).find(e => e.estimate && String(e.date || '').slice(0, 7) === String(f.date).slice(0, 7) && (
            (sup && e.supplierId === sup.id) || tok(e.desc).some(t => tok(it.fromName || '').includes(t) || tok(sup?.name || '').includes(t))));
          if (est) { setEdit({ kind: 'expense', rec: { ...est, ...f, id: est.id, recurring: est.recurring, supplierId: f.supplierId || est.supplierId, cat: est.cat, desc: est.desc, estimate: true,
                                                         gross: f.gross || String(est.gross) },
                               init: { f: {}, read: !!(g.gross || g.date || g.docNo), replaces: est }, inboxId: it.id }); return; }
          setEdit({ kind: 'expense', rec: null, init: { f, read: !!(g.gross || g.date || g.docNo), foreign: g.foreign || '', newSup: sup ? '' : (it.fromName || ''), supTax: g.taxId || '', supEmail: it.from || '' }, inboxId: it.id });
        }} />}
      {sub === 'expenses' && <ExpenseList outgo={ledger.outgo} supName={supName} onFile={openExpFile}
        onEdit={(r) => setEdit({ kind: 'expense', rec: r })} onDel={(r) => remove('expenses', r.id, 'ההוצאה')} />}
      {sub === 'suppliers' && <SupplierList suppliers={suppliers} outgo={ledger.outgo}
        onEdit={(r) => setEdit({ kind: 'supplier', rec: r })} onDel={(r) => remove('suppliers', r.id, 'הספק')} />}
      {sub === 'bank' && <BankTab bank={data.banktx || []} income={ledger.income} outgo={ledger.outgo} flash={flash}
        onSave={(r) => save('banktx', r)} onDel={(r) => remove('banktx', r.id, 'השורה')}
        onBulk={async (recs) => { let ok = 0; for (const r of recs) if (await save('banktx', r)) ok++; return ok; }} />}
      {sub === 'vat' && <VatTab totals={tot} rate={rate} book={book} />}
      {sub === 'bset' && <><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><h3 style={{ margin: 0, flex: 1 }}>⚙ הגדרות · {book.name}</h3>
        <button className="mg-btn ghost sm" onClick={() => setSub('dash')}>סגור</button></div>
        <BookSettings book={book} data={data} cols={cols} flash={flash} server={server} user={user} payOk={payOk} role={role}
          onEditBook={onEditBook} onStoreLogin={onStoreLogin} onReload={onReload} onLog={log} onServer={onServer}
          onGo={(k, o) => { if (o?.pay) openDoc(null, true); else setSub(k); }} onGlobal={onGlobal} /></>}
      {sub === 'paypages' && <PayPagesTab book={book} data={data} payOk={payOk} server={server} role={role} ro={ro} flash={flash}
        onCreated={payCreated} onCancel={payCancel} onRefresh={payRefresh} onReplace={payReplace}
        onSetup={() => { try { sessionStorage.setItem('tzbooks_bset', 'pay'); } catch {} setSub('bset'); }} />}
      {sub === 'pay' && <AuthPayTab book={book} rows={[{ book, data }, ...siblings]} onLoad={onLoadSiblings} flash={flash} />}
      {sub === 'pnl' && <PnlTab totals={tot} supName={supName} book={book} taxRows={role === 'owner' ? taxRows : null} onLoadSiblings={onLoadSiblings} />}
      {sub === 'docs' && <DocsTab quick={quickDoc} book={book} docs={data.documents || []} customers={data.customers || []} items={data.items || []} onIssue={issueDoc} onPrinted={printedDoc} onSent={sentDoc}
                                  ita={ita} onRequestAlloc={requestAlloc} onManualAlloc={(d, no) => setAlloc(d, no, 'manual')}
                                  onLog={log} server={server} ro={ro} flash={flash}
                                  payreqs={data.payreqs || []} payOk={payOk} onPayCreated={payCreated} onPayCancel={payCancel} onPayRefresh={payRefresh} onPayReplace={payReplace}
                                  onSetup={role === 'owner' ? () => { try { sessionStorage.setItem('tzbooks_bset', 'pay'); } catch {} setSub('bset'); } : null}
                                  icount={role === 'owner' && cloud && server && (book.icountAuto || book.icountSyncAt || data.documents?.some(d => d.source === 'icount-api')) ? { ...ic, err: ic.err || (!ic.msg && book.icountErr) || '', sync: () => icSync(true) } : null} />}
      {sub === 'ledger' && <LedgerTab book={book} data={data} ledger={ledger} pick={ledgerPick} />}
      {sub === 'items' && <ItemsTab book={book} data={data} cols={cols} patch={patch} flash={flash} ro={ro} role={role} />}
      {sub === 'customers' && <CustomersTab book={book} data={data} cols={cols} patch={patch} flash={flash} ro={ro} role={role}
                                            onLedger={clerk ? null : (c) => { setLedgerPick({ kind: 'cust', id: c.id, n: Date.now() }); setSub('ledger'); }}
                                            onReload={onReload} onStoreLogin={onStoreLogin} />}
      {sub === 'tax' && <TaxTab book={book} docs={data.documents || []} log={data.log || []} ro={ro} onLog={log} flash={flash} ledger={ledger} />}
      {sub === 'export' && <ExportTab book={book} data={data} ledger={ledger} flash={flash} onLog={ro ? null : log} onSub={setSub} user={user} />}
      {sub === 'import' && <ImportTab book={book} data={data} cols={cols} flash={flash} onDone={onReload} onDeleteBook={onDeleteBook} onLog={log} server={server} />}

      {edit?.kind === 'income' && <IncomeForm rec={edit.rec} rate={rate} onClose={() => setEdit(null)}
        docLabel={!ro && allowedTypes(book).length ? DOC_TYPES[allowedTypes(book)[0]].label : ''}
        onDoc={() => { setEdit(null); openDoc(); }}
        onSave={async (r) => { if (await save('incomes', r)) { flash('ההכנסה נשמרה'); setEdit(null); } }} />}
      {edit?.kind === 'expense' && <ExpenseForm rec={edit.rec} init={edit.init} rate={rate} suppliers={suppliers} onClose={() => setEdit(null)}
        onNewSupplier={(s) => save('suppliers', s)} onFile={cloud ? openExpFile : null}
        onSave={async (r) => {
          if (!(await save('expenses', r))) return;
          if (edit.inboxId) { await inboxCall('inbox-mark', book.id, { id: edit.inboxId, status: 'done', expenseId: r.id }).catch(() => {}); setInboxTick(t => t + 1); }
          flash('ההוצאה נשמרה'); setEdit(null);
        }} />}
      </div></div>
      {!ro && <QuickFab book={book} canPay={!!(payOk?.zcredit || payOk?.upay)} canExpense={role === 'owner'} onDoc={(t) => openDoc(t)} onPay={() => openDoc(null, true)}
                        onExpense={() => setEdit({ kind: 'expense', rec: null })} />}
      {edit?.kind === 'supplier' && <SupplierForm rec={edit.rec} onClose={() => setEdit(null)}
        onSave={async (r) => { if (await save('suppliers', r)) { flash('הספק נשמר'); setEdit(null); } }} />}
    </div>
  );
}

/* ------------------------------------------------------------------- סקירה */
function Dash({ totals, rate, alerts, onSub, linked, taxTile, payNote }) {
  const [month, setMonth] = useState(thisMonth());
  const t = totals(month, month);
  const year = month.slice(0, 4);
  const y = totals(year + '-01', year + '-12');
  const months = Array.from({ length: 12 }, (_, i) => addMonths(month, i - 11));
  const series = months.map(m => { const x = totals(m, m); return { m, inc: x.incNet, exp: x.expNet }; });
  const top = Math.max(1, ...series.map(s => Math.max(s.inc, s.exp)));
  const pStart = biStart(month);
  const vp = totals(pStart, addMonths(pStart, 1));

  return (
    <>
      {payNote}
      <div data-tour="dash-month" style={{ ...row, marginBottom: 14 }}>
        <Field label="חודש"><input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /></Field>
      </div>
      <div data-tour="dash-stats" className="mg-stats" style={{ marginBottom: 18 }}>
        <div className="mg-stat"><div className="lb">הכנסות (לפני מע״מ)</div><div className="vl">{fmt(t.incNet)}</div>
          <div className="dl">{t.inc.length} תנועות · השנה {fmt(y.incNet)}</div></div>
        <div className="mg-stat"><div className="lb">הוצאות (לפני מע״מ)</div><div className="vl">{fmt(t.expNet)}</div>
          <div className="dl">{t.exp.length} תנועות · השנה {fmt(y.expNet)}</div></div>
        <div className="mg-stat"><div className="lb">רווח</div>
          <div className="vl" style={t.profit < 0 ? { color: 'var(--bad)' } : undefined}>{fmt(t.profit)}</div>
          <div className="dl">השנה {fmt(y.profit)}</div></div>
        <div className="mg-stat"><div className="lb">{rate > 0 ? `מע״מ ${monthName(pStart)}–${monthName(addMonths(pStart, 1))}` : 'מע״מ'}</div>
          <div className="vl">{rate > 0 ? fmt(vp.vatDue) : '—'}</div>
          <div className="dl">{rate > 0 ? (vp.vatDue >= 0 ? 'לתשלום' : 'להחזר') : 'עוסק פטור'}</div></div>
        {taxTile}
      </div>

      {linked && alerts.unpaid.length > 0 && (
        <div className="mg-note" style={{ marginBottom: 14 }}>
          בחנות יש {alerts.unpaid.length} הזמנות שעדיין לא שולמו, בסך {fmt(alerts.unpaid.reduce((a, o) => a + (Number(o.total) || 0), 0))}.
          הן ייכנסו להכנסות ברגע שיסומנו כשולמו בקונסולת החנות.
        </div>
      )}
      {(alerts.noDocOrders > 0 || alerts.unmatched > 0 || alerts.noDocExp > 0 || alerts.review > 0) && (
        <div data-tour="dash-alerts" className="mg-card" style={{ marginBottom: 18 }}>
          <h3 style={{ marginTop: 0 }}>מה דורש טיפול</h3>
          {alerts.noDocOrders > 0 && <div className="mg-note warn" style={{ marginBottom: 8 }}>
            {alerts.noDocOrders} הזמנות ששולמו ועדיין אין להן חשבונית. מפיקים במסך ההזמנות בקונסולת החנות.</div>}
          {alerts.unmatched > 0 && <div className="mg-note warn" style={{ marginBottom: 8 }}>
            {alerts.unmatched} שורות בנק שלא הותאמו. <button className="mg-linkish" onClick={() => onSub('bank')}>להתאמה</button></div>}
          {alerts.noDocExp > 0 && <div className="mg-note warn" style={{ marginBottom: 8 }}>
            {alerts.noDocExp} הוצאות בלי מספר חשבונית. בלי חשבונית אי אפשר לקזז את המע״מ שלהן.{' '}
            <button className="mg-linkish" onClick={() => onSub('expenses')}>להוצאות</button></div>}
          {alerts.review > 0 && <div className="mg-note warn">{alerts.review} רשומות שיובאו מהמערכת הישנה מסומנות לבדיקה.</div>}
        </div>
      )}

      <div data-tour="dash-chart" className="mg-card">
        <h3 style={{ marginTop: 0 }}>12 חודשים · הכנסות מול הוצאות (לפני מע״מ)</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 180, padding: '8px 0' }}>
          {series.map(s => (
            <div key={s.m} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%' }}
                 title={`${monthName(s.m)} · הכנסות ${fmt(s.inc)} · הוצאות ${fmt(s.exp)}`}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, width: '100%', justifyContent: 'center' }}>
                <div style={{ width: '40%', height: `${Math.max(0, s.inc) / top * 100}%`, background: 'var(--green2)', borderRadius: '4px 4px 0 0' }} />
                <div style={{ width: '40%', height: `${s.exp / top * 100}%`, background: '#d9822b', borderRadius: '4px 4px 0 0' }} />
              </div>
              <div className="mlab">{monthName(s.m)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, fontSize: 13, color: 'var(--muted)' }}>
          <span><span style={{ color: 'var(--green2)' }}>■</span> הכנסות{linked ? ' (כולל החנות)' : ''}</span>
          <span><span style={{ color: '#d9822b' }}>■</span> הוצאות</span>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ הכנסות */
/* Long lists show the first rows and more on request: drawing thousands of
   table rows at once is what makes a screen slow. Totals, filters and
   exports always use the whole list. */
function useLimit(deps, step = 100) {
  const [n, setN] = useState(step);
  useEffect(() => setN(step), deps);
  return [n, () => setN(x => x + step * 2)];
}
function ShowMore({ n, total, onMore, cols = 9 }) {
  if (total <= n) return null;
  return <tr className="showmore"><td colSpan={cols} style={{ textAlign: 'center', padding: 10 }}>
    <button className="mg-btn ghost sm" onClick={onMore}>הצג עוד · מוצגות {n} מתוך {total}</button></td></tr>;
}

function IncomeList({ income, linked, onEdit, onDel, onDoc, onManual }) {
  const [month, setMonth] = useState('');
  const [src, setSrc] = useState('all');
  const [q, setQ] = useState('');
  const list = income.filter(i => (!month || (i.date || '').startsWith(month))
    && (src === 'all' || (src === 'shop' ? i.src === 'shop' : i.src !== 'shop'))
    && (!q || (i.desc + ' ' + (i.docNo || '') + ' ' + (i.customer || '')).includes(q.trim())));
  const sum = list.reduce((a, i) => a + i.gross, 0), vat = list.reduce((a, i) => a + i.vat, 0);
  const [lim, more] = useLimit([month, src, q]);
  return (
    <>
      {(onDoc || onManual) && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {onDoc && <button className="mg-btn" onClick={onDoc}>＋ הכנסה (הפקת חשבונית)</button>}
        {onManual && <button className="mg-linkish" style={{ fontSize: 14 }} onClick={onManual}>רישום ידני של הכנסה שכבר יש לה מסמך ממקום אחר</button>}
      </div>}
      <div data-tour="inc-filters" style={{ ...row, marginBottom: 12 }}>
        <Field label="חודש"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
        {linked && <Field label="מקור"><select value={src} onChange={e => setSrc(e.target.value)}>
          <option value="all">הכול</option><option value="shop">מהחנות</option><option value="manual">ידני</option></select></Field>}
        <Field label="חיפוש"><input value={q} onChange={e => setQ(e.target.value)} placeholder="שם, מספר, מסמך" /></Field>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`income-${month || 'all'}.csv`, [
          ['תאריך', 'תיאור', 'לקוח', 'קטגוריה', 'אמצעי תשלום', 'מסמך', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'מקור'],
          ...list.map(i => [i.date, i.desc, i.customer || '', i.cat, i.pay, i.docNo, r2(i.gross - i.vat), i.vat, i.gross, i.src === 'shop' ? 'חנות' : 'ידני'])
        ])}>⬇ ייצוא</button>
      </div>
      {linked && <div className="mg-note" style={{ marginBottom: 12 }}>
        הזמנות מהחנות נכנסות לכאן מעצמן ברגע שהן מסומנות כשולמו. את החשבונית שלהן מפיקים בקונסולת החנות.
      </div>}
      <div data-tour="inc-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>תאריך</th><th>תיאור</th><th>קטגוריה</th><th>תשלום</th><th>מסמך</th><th>לפני מע״מ</th><th>מע״מ</th><th>סה״כ</th><th></th></tr></thead>
        <tbody>
          {list.slice(0, lim).map(i => (
            <tr key={i.id}>
              <td>{heDate(i.date)}</td>
              <td>{i.desc}{i.customer ? <span style={{ color: 'var(--muted)' }}> · {i.customer}</span> : null}
                {i.review && <span className="mg-chip warn" style={{ marginInlineStart: 6 }}>לבדיקה</span>}</td>
              <td><span className={'mg-chip ' + (i.src === 'shop' ? 'ok' : '')}>{i.cat}</span></td>
              <td>{i.pay || '—'}</td>
              <td>{i.docNo || <span style={{ color: 'var(--warn)' }}>חסר</span>}</td>
              <td>{fmt(i.gross - i.vat)}</td><td>{fmt(i.vat)}</td><td><b>{fmt(i.gross)}</b></td>
              <td>{!['shop', 'doc'].includes(i.src) && <div style={{ display: 'flex', gap: 4 }}>
                <button className="mg-btn ghost sm" onClick={() => onEdit(i)}>✎</button>
                <button className="mg-btn ghost sm" onClick={() => onDel(i)}>🗑</button></div>}</td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={9}><div className="mg-empty">אין הכנסות בסינון הזה.</div></td></tr>}
          <ShowMore n={lim} total={list.length} onMore={more} cols={9} />
        </tbody>
      </table></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 10, gap: 18, fontSize: 14 }}>
        <span>סה״כ: <b>{fmt(sum)}</b></span><span>מתוכו מע״מ: <b>{fmt(vat)}</b></span><span>לפני מע״מ: <b>{fmt(sum - vat)}</b></span>
      </div>
    </>
  );
}

function IncomeForm({ rec, rate, onSave, onClose, docLabel = '', onDoc }) {
  const [f, setF] = useState(() => ({
    id: uid('inc'), date: todayIso(), desc: '', cat: INC_CATS[0], pay: PAY_METHODS[0],
    gross: '', noVat: false, docNo: '', customer: '', ...(rec || {})
  }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const g = Number(f.gross) || 0;
  const vat = f.noVat ? 0 : vatOf(g, rate);
  const ok = String(f.desc).trim() && g > 0 && f.date;
  return (
    <Box title={rec ? 'עריכת הכנסה' : 'הכנסה חדשה'} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={!ok}
                           onClick={() => onSave({ ...f, src: f.src === 'erp' ? 'erp' : 'manual', gross: g, vat, desc: String(f.desc).trim(), review: false })}>שמור</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      {!rec && docLabel && onDoc && <div className="mg-note" style={{ marginBottom: 12 }}>
        כאן רושמים הכנסה שכבר יש לה מסמך ממקום אחר. ללקוח שצריך לקבל מסמך עכשיו:{' '}
        <button className="mg-btn sm" onClick={onDoc}>🧾 הפק {docLabel}</button></div>}
      <div style={grid}>
        <Field label="תאריך"><input type="date" value={f.date} onChange={e => set('date', e.target.value)} /></Field>
        <Field label="תיאור"><input value={f.desc} onChange={e => set('desc', e.target.value)} placeholder="טיפול דיקור" /></Field>
        <Field label="לקוח"><input value={f.customer} onChange={e => set('customer', e.target.value)} /></Field>
        <Field label="קטגוריה"><select value={f.cat} onChange={e => set('cat', e.target.value)}>{INC_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="אמצעי תשלום"><select value={f.pay} onChange={e => set('pay', e.target.value)}>{PAY_METHODS.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="מספר מסמך (חשבונית / קבלה)"><input value={f.docNo} onChange={e => set('docNo', e.target.value)} /></Field>
        <Field label="סכום כולל מע״מ (₪)"><input inputMode="decimal" value={f.gross} onChange={e => set('gross', e.target.value)} /></Field>
      </div>
      {rate > 0 && <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 14 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={!!f.noVat} onChange={e => set('noVat', e.target.checked)} />הכנסה פטורה ממע״מ</label>}
      <div className="mg-note" style={{ marginTop: 12 }}>
        לפני מע״מ <b>{fmt(g - vat)}</b> · מע״מ <b>{fmt(vat)}</b> · סה״כ <b>{fmt(g)}</b>
      </div>
    </Box>
  );
}

/* ------------------------------------------------------------------ הוצאות */

/* ============================================================ invoice inbox */
/* Supplier invoices that reach the owner's Gmail arrive here through a small
   script in their own Google account (see GmailSetup). Each waits until it is
   recorded as an expense, with what could be read from the file filled in. */
async function inboxCall(action, bookId, extra = {}) { return fnCall({ action, book: bookId, ...extra }); }
async function inboxOpen(bookId, id) {
  const f = await inboxCall('inbox-file', bookId, { id });
  const blob = new Blob([unb64(f.data)], { type: f.mime });
  return { ...f, blob, bytes: unb64(f.data) };
}
function showBlob(blob) {
  const u = URL.createObjectURL(blob);
  const w = window.open(u, '_blank');
  if (!w) { const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(u), 120000);
}
/* The text of a PDF (the library loads only when a file is read). Scans have no text; that is fine. */
async function pdfText(bytes) {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.min.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  let out = '';
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    out += c.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  return out;
}
/* What an invoice most likely says: the total (the largest amount), the VAT
   (an amount that is that total's VAT), the date, the supplier's tax id and
   the invoice number. Every guess is shown for the user to confirm. */
function guessInvoice(text, rate, ownIds = []) {
  const t = String(text || '').replace(/[‎‏‪-‮]/g, '');
  const amounts = [...t.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{1,7})\.(\d{2})(?![\d])/g)].map(m => Number(m[1].replace(/,/g, '') + '.' + m[2])).filter(n => n > 0 && n < 5e6);
  const out = {};
  if (amounts.length) {
    const total = Math.max(...amounts);
    out.gross = total;
    const rates = [...new Set([rate, 18, 17].filter(Boolean))];
    for (const r of rates) {
      const v = amounts.find(a => a !== total && Math.abs(a - total * r / (100 + r)) <= 0.06);
      if (v) { out.vat = v; out.vatMode = r === rate ? 'full' : 'manual'; if (r !== rate) out.vatManual = v; break; }
    }
    if (!out.vat && /עוסק\s*פטור|פטור\s*ממע|exempt|no\s*vat/i.test(t)) out.vatMode = 'none';
  }
  /* Abroad: the amount is not in shekels, and there is no Israeli VAT to deduct. */
  const cur = !/₪|ש["״]ח|ILS|NIS/i.test(t) && (/\bUSD\b|US\$|\$\s?\d|\d\s?\$/.test(t) ? 'USD' : /\bEUR\b|€/.test(t) ? 'EUR' : '');
  if (cur) { out.foreign = cur; out.vatMode = 'none'; delete out.vat; }
  const today = todayIso();
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](20\d{2}|\d{2})(?!\d)/g)) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3], mo = Number(m[2]), d = Number(m[1]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso <= today && iso >= addMonths(today.slice(0, 7), -18) + '-01') { out.date = iso; break; }
  }
  const own = new Set(ownIds.map(x => String(x || '').replace(/\D/g, '')).filter(Boolean));
  const ids = [...t.matchAll(/(?<!\d)(\d{9})(?!\d)/g)].map(m => m[1]).filter(x => !own.has(x) && !/^0{3}/.test(x));
  if (ids.length) out.taxId = ids[0];
  /* The number next to the word: after it, or before it when the PDF keeps Hebrew words in reverse order. */
  const skip = new Set([...own, out.taxId].filter(Boolean));
  const cands = [...t.matchAll(/(?:חשבונית|קבלה|invoice|receipt)(?:\s+(?:מס['׳]?|קבלה|מספר|no\.?|number|#|:)){0,3}\s*[:#]?\s*([A-Z]{0,4}[-/]?\d{3,12})(?![\d./])/gi),
                 ...t.matchAll(/(?<![\d.,/])([A-Z]{0,4}[-/]?\d{3,12})(?![\d.,/])\s+(?:[^\s\d]{1,6}\s+){0,3}(?:חשבונית|קבלה)/g)]
    .map(m => m[1]).filter(x => !skip.has(x.replace(/\D/g, '')));
  if (cands.length) out.docNo = cands[0];
  return out;
}
/* The supplier an invoice came from: by tax id, email, the email's domain, or name. */
function matchSupplier(suppliers, g) {
  const tax = String(g.taxId || '').replace(/\D/g, ''), em = String(g.from || '').toLowerCase(), dom = em.split('@')[1] || '';
  const free = /^(gmail|walla|hotmail|outlook|yahoo|icloud|live|me)\./i.test(dom);
  return suppliers.find(s => tax && String(s.taxId || '').replace(/\D/g, '') === tax)
      || suppliers.find(s => em && String(s.email || '').toLowerCase() === em)
      || (!free && dom ? suppliers.find(s => String(s.email || '').toLowerCase().endsWith('@' + dom)) : null)
      || suppliers.find(s => g.fromName && normName(s.name) && (normName(g.fromName).includes(normName(s.name)) || normName(s.name).includes(normName(g.fromName))))
      || null;
}

/* The script for the owner's Gmail: every hour, new mail with an invoice file
   is sent to this business's inbox and labelled, so nothing is sent twice. */
function gmailScript(endpoint, bookId, key, bookName) {
  return `/* Tizon Books · איסוף חשבוניות מ-Gmail עבור "${bookName}"
   רץ בחשבון Google שלך בלבד. שולח ל-Tizon Books קבצי PDF ותמונות
   ממיילים שנראים כמו חשבונית או קבלה, ומסמן אותם בתווית tizon-books.
   הפעלה: בחר את הפונקציה setup למעלה ולחץ "הרצה" (Run), ואשר את ההרשאות. */
const ENDPOINT = '${endpoint}?action=inbox-push&b=${bookId}&k=${key}';
const QUERY = 'has:attachment newer_than:45d -in:sent -from:me -label:tizon-books ' +
  '(חשבונית OR "חשבון עסקה" OR קבלה OR invoice OR receipt OR bill OR "tax invoice")';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('collect').timeBased().everyHours(1).create();
  collect();
}

function collect() {
  var label = GmailApp.getUserLabelByName('tizon-books') || GmailApp.createLabel('tizon-books');
  var threads = GmailApp.search(QUERY, 0, 40);
  threads.forEach(function (t) {
    var ok = true;
    t.getMessages().forEach(function (m) {
      m.getAttachments({ includeInlineImages: false }).forEach(function (a, i) {
        var type = String(a.getContentType() || '').toLowerCase();
        if (!/pdf|image\\/(jpe?g|png|webp|heic)/.test(type) || a.getSize() > 4200000) return;
        var res = UrlFetchApp.fetch(ENDPOINT, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ id: m.getId() + '_' + i, from: m.getFrom(), subject: m.getSubject(),
            date: m.getDate().toISOString(), name: a.getName(), mime: type, data: Utilities.base64Encode(a.getBytes()) }) });
        if (res.getResponseCode() >= 300) ok = false;
      });
    });
    if (ok) t.addLabel(label);
  });
}
`;
}

function GmailSetup({ book, onClose, flash }) {
  const [k, setK] = useState(null);
  const [err, setErr] = useState('');
  const load = async (renew) => { setErr(''); try { setK(await inboxCall('inbox-key', book.id, renew ? { renew: true } : {})); } catch (e) { setErr(String(e.message || e)); } };
  useEffect(() => { load(false); }, []);
  const code = k ? gmailScript(location.origin + FN, book.id, k.key, book.name) : '';
  const copy = async () => { try { await navigator.clipboard.writeText(code); flash('הסקריפט הועתק'); } catch { flash('סמן את הטקסט והעתק ידנית'); } };
  return (
    <Box title="איסוף חשבוניות מ-Gmail" onClose={onClose} wide footer={<button className="mg-btn ghost" onClick={onClose}>סגור</button>}>
      <div data-tour="gmail-setup">
        <div className="mg-note" style={{ marginBottom: 12 }}>
          סקריפט קטן שרץ <b>בחשבון Google שלך</b>, פעם בשעה. הוא מוצא מיילים עם חשבונית או קבלה מצורפת (PDF או תמונה), שולח את הקובץ לכאן, ומסמן את המייל בתווית <b dir="ltr">tizon-books</b>.
          הסיסמה של Gmail לא עוברת לשום מקום, ואפשר לעצור אותו בכל רגע.</div>
        <ol style={{ lineHeight: 1.9, paddingInlineStart: 22, margin: '0 0 12px' }}>
          <li>לחץ <b>העתק סקריפט</b>.</li>
          <li>פתח את <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com ← פרויקט חדש</a> (מחובר לחשבון שאליו מגיעות החשבוניות).</li>
          <li>מחק את מה שכתוב שם, הדבק, ולחץ 💾 שמירה.</li>
          <li>למעלה בחר את הפונקציה <b dir="ltr">setup</b> ולחץ <b>הרצה</b> (Run).</li>
          <li>אשר את ההרשאות: "Advanced" ← "Go to … (unsafe)" ← Allow. זה הסקריפט שלך, ולכן Google מבקש אישור.</li>
        </ol>
        {err && <div className="mg-note bad">{err}</div>}
        {k && <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button className="mg-btn" onClick={copy}>📋 העתק סקריפט</button>
            <button className="mg-btn ghost sm" onClick={() => window.confirm('ליצור מפתח חדש? הסקריפט הקיים יפסיק לעבוד עד שתדביק את החדש.') && load(true)}>מפתח חדש</button>
          </div>
          <textarea readOnly dir="ltr" value={code} style={{ width: '100%', height: 160, fontFamily: 'monospace', fontSize: 12 }} onFocus={e => e.target.select()} />
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
            {k.lastAt ? `קובץ אחרון התקבל ${new Date(k.lastAt).toLocaleString('he-IL')} · ${k.count} בסך הכול` : 'עוד לא התקבל קובץ. אחרי ההרצה הראשונה החשבוניות מ-45 הימים האחרונים יופיעו כאן.'}</div>
        </>}
      </div>
    </Box>
  );
}

function InboxCard({ book, server, role, onRecord, flash, refreshKey }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [setup, setSetup] = useState(false);
  const [open, setOpen] = useState(true);
  const load = async () => { try { setSt(await inboxCall('inbox-list', book.id)); } catch (e) { setSt({ err: String(e.message || e) }); } };
  useEffect(() => { if (cloud && server?.inbox) load(); }, [book.id, server?.inbox, refreshKey]);
  if (!cloud || !server?.inbox || !st) return null;
  const items = (st.items || []).slice().sort((a, b) => String(b.date || b.at).localeCompare(String(a.date || a.at)));
  const canAct = ['owner', 'clerk'].includes(role);
  const view = async (it) => { setBusy(it.id); try { showBlob((await inboxOpen(book.id, it.id)).blob); } catch { flash('פתיחת הקובץ נכשלה'); } setBusy(''); };
  const record = async (it) => {
    setBusy(it.id);
    let guess = {};
    try {
      const f = await inboxOpen(book.id, it.id);
      if (/pdf/i.test(f.mime)) guess = guessInvoice(await pdfText(f.bytes).catch(() => ''), rateOf(book), [book.taxId]);
    } catch { /* recorded by hand then */ }
    setBusy('');
    onRecord(it, guess, load);
  };
  const ignore = async (it) => { setBusy(it.id); try { await inboxCall('inbox-mark', book.id, { id: it.id, status: 'ignored' }); await load(); } catch { flash('לא הצלחתי לעדכן'); } setBusy(''); };
  if (!st.keyed && role !== 'owner') return null;
  return (
    <div data-tour="exp-inbox" className="mg-card" style={{ marginBottom: 14, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ flex: 1 }}>📥 חשבוניות שהגיעו במייל {items.length ? <span className="mg-chip warn">{items.length} ממתינות</span> : ''}</b>
        {items.length > 0 && <button className="mg-btn ghost sm" onClick={() => setOpen(o => !o)}>{open ? 'הסתר' : 'הצג'}</button>}
        {role === 'owner' && <button className="mg-btn ghost sm" onClick={() => setSetup(true)}>{st.keyed ? '⚙ הגדרות' : 'חבר את Gmail'}</button>}
      </div>
      {st.err && <div className="mg-note bad" style={{ marginTop: 8 }}>{st.err}</div>}
      {!st.keyed && <div style={{ fontSize: 14, marginTop: 6 }}>חשבוניות ספקים שמגיעות אליך ל-Gmail יכולות להגיע לכאן לבד, ולהירשם כהוצאה בלחיצה. ההגדרה לוקחת כ-2 דקות.</div>}
      {st.keyed && !items.length && <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 6 }}>
        אין חשבוניות ממתינות.{st.lastAt ? ` אחרונה התקבלה ${new Date(st.lastAt).toLocaleString('he-IL')}.` : ' עוד לא התקבלה אף חשבונית: ודא שהרצת את setup בסקריפט.'}</div>}
      {open && items.map(it => (
        <div key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', padding: '9px 0' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{it.fromName || it.from}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.date ? heDate(d10(it.date)) + ' · ' : ''}{it.subject || it.name}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="mg-btn ghost sm" disabled={!!busy} onClick={() => view(it)}>👁 צפה</button>
            {canAct && <button className="mg-btn sm" disabled={!!busy} onClick={() => record(it)}>{busy === it.id ? 'קורא…' : 'רשום כהוצאה'}</button>}
            {canAct && <button className="mg-btn ghost sm" disabled={!!busy} onClick={() => ignore(it)}>לא הוצאה</button>}
          </div>
        </div>))}
      {setup && <GmailSetup book={book} flash={flash} onClose={() => { setSetup(false); load(); }} />}
    </div>
  );
}


/* ===================================================== fixed monthly expenses */
/* Rent, phone, insurance, the accountant: set once, recorded every month on
   their day. Each month's expense has a fixed id (the rule and the month), so
   two devices, or opening the business twice, never record it twice. */
const REC_BACK = 12;           // at most a year is caught up at once
const recCat = (t) => {
  const s = String(t || '');
  const hit = EXP_CATS.find(c => s.includes(c) || c.split(' ')[0] && s.includes(c.split(' ')[0]));
  if (hit) return hit;
  if (/צמח|חומרי גלם|חומר גלם|מלאי|פורמול|תמצית|שמנים/.test(s)) return 'מלאי וחומרי גלם';
  if (/שכיר|ארנונה|חשמל|מים|ועד/.test(s)) return 'שכירות';
  if (/טלפון|סלולר|אינטרנט|מנוי|תוכנ|זום|גוגל|anthropic|claude|adobe|canva/i.test(s)) return 'תוכנה ומנויים';
  if (/ביטוח/.test(s)) return 'ביטוח';
  if (/רכב|דלק|ליסינג|חניה/.test(s)) return 'רכב ונסיעות';
  if (/רו["״]?ח|רואה חשבון|הנה["״]?ח|יועץ מס/.test(s)) return 'הנהלת חשבונות';
  if (/פרסום|שיווק|פייסבוק|גוגל אדס|ads/i.test(s)) return 'שיווק ופרסום';
  if (/סליקה|עמלה|בנק/.test(s)) return 'עמלות סליקה';
  return 'אחר';
};
/* "שכירות, 3500, 1" · "טלפון 89 ש״ח ב-10 לחודש" · one fixed expense a line. */
function parseRecurring(text) {
  return String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean).map(raw => {
    /* "25%" is the business's share of a home expense, not an amount. */
    const shareM = raw.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    const share = shareM ? Math.min(100, Math.max(1, Number(shareM[1]))) : 100;
    const line = shareM ? raw.replace(shareM[0], ' ') : raw;
    const nums = [...line.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)].map(m => ({ v: Number(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : '')), raw: m[0], at: m.index }));
    const dayM = line.match(/(?:ב-?|יום\s*|day\s*)(\d{1,2})(?:\s*(?:לחודש|בחודש))?/) || line.match(/(\d{1,2})\s*(?:לחודש|בחודש)/);
    const day = dayM ? Math.min(28, Math.max(1, Number(dayM[1]))) : null;
    const amounts = nums.filter(n => !(dayM && n.raw === dayM[1] && Math.abs(n.at - (line.indexOf(dayM[0]) + dayM[0].indexOf(dayM[1]))) < 2));
    const amount = amounts.length ? amounts[0].v : 0;
    const restDay = day ?? (amounts[1] && amounts[1].v >= 1 && amounts[1].v <= 31 && Number.isInteger(amounts[1].v) ? Math.min(28, amounts[1].v) : 1);
    /* Only whole words are taken out: "יום" must not cut "מילניום". */
    const name = line.replace(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g, ' ').replace(/₪/g, ' ')
      .replace(/(^|[\s,;|])(ש["״]?ח|nis|ils|לחודש|בחודש|יום|ב-|כל|ללא מע["״]?מ|פטור|כולל מע["״]?מ)(?=$|[\s,;|])/gi, '$1 ')
      .split(/[,;|\t]| - /)[0].replace(/\s+/g, ' ').trim() || 'הוצאה קבועה';
    const vatMode = /ללא מע|פטור|חו["״]?ל|abroad/i.test(line) ? 'none' : /רכב|דלק|ליסינג/.test(line) ? 'car' : 'full';
    const catTxt = line.split(/[,;|\t]/).slice(3).join(' ');
    const cat = catTxt && recCat(catTxt) !== 'אחר' ? recCat(catTxt) : recCat(line);
    /* "ממוצע", "משוער", "הערכה": an estimate, replaced by the real invoice when it comes. */
    const estimate = /ממוצע|משוער|הערכה|בערך|כ-?\s*\d/.test(line);
    return { name: name.replace(/\s*(ממוצע|משוער|הערכה|בערך)\s*/g, ' ').trim() || name, gross: amount, day: restDay, cat, vatMode, share, estimate, ok: amount > 0 };
  });
}
function recVat(gross, mode, rate) { return rate === 0 ? 0 : mode === 'full' ? vatOf(gross, rate) : mode === 'car' ? r2(vatOf(gross, rate) * 2 / 3) : 0; }
/* What is due now: every month from the rule's start (or the month after the
   last one recorded) through this one, when its day has come. */
function recurringDue(rules, today = todayIso()) {
  const ym = today.slice(0, 7), d = Number(today.slice(8, 10)), out = [];
  for (const r of rules) {
    if (r.active === false || !(Number(r.gross) > 0)) continue;
    let m = r.lastMonth ? addMonths(r.lastMonth, 1) : (r.from || ym);
    const floor = addMonths(ym, -REC_BACK + 1); if (m < floor) m = floor;
    for (; m <= ym; m = addMonths(m, 1)) {
      if (r.until && m > r.until) break;
      if (m === ym && d < (Number(r.day) || 1)) break;
      out.push({ rule: r, month: m });
    }
  }
  return out;
}
function recExpense(r, month, rate) {
  const day = String(Math.min(28, Math.max(1, Number(r.day) || 1))).padStart(2, '0');
  const share = Math.min(100, Math.max(1, Number(r.share) || 100));
  const gross = r2(Number(r.gross) * share / 100);
  return clean({ id: `rec_${r.id}_${month}`, date: `${month}-${day}`, desc: r.name + (share < 100 ? ` (${share}% לעסק)` : '') + (r.estimate ? ' (הערכה)' : ''), cat: r.cat || 'אחר', supplierId: r.supplierId || '',
                 pay: r.pay || 'הוראת קבע', gross, vatMode: r.vatMode || 'full', vatManual: '', vat: recVat(gross, r.vatMode || 'full', rate),
                 docNo: '', recurring: r.id, src: 'recurring', createdAt: new Date().toISOString(),
                 ...(r.estimate ? { estimate: true, review: true } : {}) });
}

function RecurringCard({ book, data, rate, cols, patch, flash, suppliers }) {
  const list = (data.recurring || []).slice().sort((a, b) => (Number(a.day) || 0) - (Number(b.day) || 0));
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(null);
  const [paste, setPaste] = useState(null);
  const part = (r) => (Number(r.gross) || 0) * Math.min(100, Math.max(1, Number(r.share) || 100)) / 100;
  const monthly = list.filter(r => r.active !== false).reduce((a, r) => a + part(r), 0);
  const saveRule = async (r) => {
    const rec = clean({ ...r, gross: r2(r.gross), day: Math.min(28, Math.max(1, Number(r.day) || 1)), updatedAt: new Date().toISOString() });
    try { await withTimeout(cols.recurring.put(rec.id, rec), 12000); patch('recurring', l => [...l.filter(x => x.id !== rec.id), rec]); return true; }
    catch { flash('השמירה נכשלה'); return false; }
  };
  const del = async (r) => {
    if (!window.confirm(`להפסיק את "${r.name}"? הוצאות שכבר נרשמו נשארות.`)) return;
    try { await cols.recurring.del(r.id); patch('recurring', l => l.filter(x => x.id !== r.id)); } catch { flash('המחיקה נכשלה'); }
  };
  const parsed = paste !== null ? parseRecurring(paste) : [];
  const yearStart = todayIso().slice(0, 4) + '-01';
  const [pasteFrom, setPasteFrom] = useState(thisMonth());
  const addParsed = async () => {
    const good = parsed.filter(x => x.ok); let n = 0;
    for (const x of good) if (await saveRule({ id: uid('rec'), ...x, from: pasteFrom || thisMonth(), active: true, pay: 'הוראת קבע' })) n++;
    flash(pasteFrom < thisMonth() ? `נוספו ${n} הוצאות קבועות, ונרשמות עכשיו מ-${monthName(pasteFrom)}.` : `נוספו ${n} הוצאות קבועות. החודש נרשם לבד בכל אחת, ביום שלה.`); setPaste(null);
  };
  /* Back to January: every active fixed expense is recorded for each month of the year so far (a month already there is kept, not doubled). */
  const fillYear = async () => {
    const act = list.filter(r => r.active !== false && (r.from || thisMonth()) > yearStart);
    if (!act.length) { flash('כל ההוצאות הקבועות כבר רשומות מתחילת השנה'); return; }
    if (!window.confirm(`לרשום ${act.length} הוצאות קבועות לכל חודש מינואר ${yearStart.slice(0, 4)} ועד היום? חודש שכבר נרשם לא יירשם שוב.`)) return;
    let n = 0; for (const r of act) if (await saveRule({ ...r, from: yearStart, lastMonth: '' })) n++;
    flash(`${n} הוצאות קבועות מתעדכנות מינואר. זה לוקח כמה שניות.`);
  };
  return (
    <div data-tour="exp-recurring" className="mg-card" style={{ marginBottom: 14, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ flex: 1 }}>🔁 הוצאות קבועות {list.length ? <span className="mg-chip">{list.length} · {fmt(monthly)} בחודש</span> : ''}</b>
        {list.length > 0 && <button className="mg-btn ghost sm" onClick={() => setOpen(o => !o)}>{open ? 'הסתר' : 'הצג'}</button>}
        <button className="mg-btn ghost sm" onClick={() => setEdit({ id: uid('rec'), name: '', gross: '', day: 1, cat: 'אחר', vatMode: rate > 0 ? 'full' : 'none', pay: 'הוראת קבע', from: thisMonth(), active: true })}>＋ הוספה</button>
        <button className="mg-btn ghost sm" onClick={() => setPaste('')}>📋 הדבקת רשימה</button>
        {list.some(r => r.active !== false && (r.from || thisMonth()) > yearStart) && <button className="mg-btn ghost sm" onClick={fillYear}>📅 השלם מתחילת השנה</button>}
      </div>
      {!list.length && <div style={{ fontSize: 14, marginTop: 6 }}>שכירות, טלפון, ביטוח, רואה חשבון: מגדירים פעם אחת, וכל חודש ההוצאה נרשמת לבד ביום שלה.</div>}
      {open && list.map(r => (
        <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', padding: '8px 0', opacity: r.active === false ? .5 : 1 }}>
          <div style={{ flex: '1 1 180px' }}><b>{r.name}</b> <span style={{ color: 'var(--muted)', fontSize: 13 }}>· ב-{r.day} לחודש · {r.cat}{r.vatMode === 'none' ? ' · ללא מע״מ' : r.vatMode === 'car' ? ' · רכב 2/3' : ''}{Number(r.share) > 0 && Number(r.share) < 100 ? ` · ${r.share}% לעסק מתוך ${fmt(r.gross)}` : ''}{r.estimate ? ' · משוער' : ''}{r.active === false ? ' · מושהית' : ''}</span></div>
          <b dir="ltr">{fmt(part(r))}</b>
          <button className="mg-btn ghost sm" onClick={() => setEdit(r)}>✎</button>
          <button className="mg-btn ghost sm" onClick={() => saveRule({ ...r, active: r.active === false })}>{r.active === false ? 'הפעל' : 'השהה'}</button>
          <button className="mg-btn ghost sm" onClick={() => del(r)}>🗑</button>
        </div>))}
      {edit && <Box title={list.some(x => x.id === edit.id) ? 'עריכת הוצאה קבועה' : 'הוצאה קבועה חדשה'} onClose={() => setEdit(null)}
                    footer={<><button className="mg-btn" disabled={!String(edit.name).trim() || !(Number(edit.gross) > 0)} onClick={async () => { if (await saveRule(edit)) setEdit(null); }}>שמור</button>
                              <button className="mg-btn ghost" onClick={() => setEdit(null)}>ביטול</button></>}>
        <div style={grid}>
          <Field label="שם"><input value={edit.name} onChange={e => setEdit(x => ({ ...x, name: e.target.value, cat: x.cat === 'אחר' ? recCat(e.target.value) : x.cat }))} placeholder="שכירות קליניקה" /></Field>
          <Field label="סכום לחודש כולל מע״מ (₪)"><input inputMode="decimal" value={edit.gross} onChange={e => setEdit(x => ({ ...x, gross: e.target.value }))} /></Field>
          <Field label="יום בחודש"><input inputMode="numeric" value={edit.day} onChange={e => setEdit(x => ({ ...x, day: e.target.value }))} /></Field>
          <Field label="חלק העסק (%)"><input inputMode="decimal" value={edit.share ?? 100} onChange={e => setEdit(x => ({ ...x, share: e.target.value }))} /></Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, gridColumn: '1 / -1' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!edit.estimate} onChange={e => setEdit(x => ({ ...x, estimate: e.target.checked }))} />
            סכום משוער (ממוצע). כל חודש נרשמת הערכה "לבדיקה", והחשבונית בפועל מחליפה אותה.</label>
          <Field label="קטגוריה"><select value={edit.cat} onChange={e => setEdit(x => ({ ...x, cat: e.target.value }))}>{EXP_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="ספק"><select value={edit.supplierId || ''} onChange={e => setEdit(x => ({ ...x, supplierId: e.target.value }))}>
            <option value="">— ללא —</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="אמצעי תשלום"><select value={edit.pay || 'הוראת קבע'} onChange={e => setEdit(x => ({ ...x, pay: e.target.value }))}>{PAY_METHODS.map(c => <option key={c}>{c}</option>)}</select></Field>
          {rate > 0 && <Field label="מע״מ לקיזוז"><select value={edit.vatMode} onChange={e => setEdit(x => ({ ...x, vatMode: e.target.value }))}>
            <option value="full">מלא ({rate}%)</option><option value="car">רכב פרטי (2/3)</option><option value="none">ללא (ספק פטור / חו״ל)</option></select></Field>}
          <Field label="מחודש"><input type="month" value={edit.from || thisMonth()} onChange={e => setEdit(x => ({ ...x, from: e.target.value, lastMonth: '' }))} /></Field>
          <Field label="עד חודש (לא חובה)"><input type="month" value={edit.until || ''} onChange={e => setEdit(x => ({ ...x, until: e.target.value }))} /></Field>
        </div>
        <div className="mg-note" style={{ marginTop: 10, fontSize: 13 }}>קליניקה בתוך הבית: רושמים את הסכום המלא ואת חלק העסק (למשל 25%), ונרשם רק החלק של העסק. ההוצאה נרשמת לבד כל חודש ביום שנקבע, כשפותחים את העסק. אם "מחודש" הוא חודש שעבר, החודשים שעברו יירשמו מיד (עד שנה אחורה).</div>
      </Box>}
      {paste !== null && <Box title="הדבקת רשימת הוצאות קבועות" onClose={() => setPaste(null)} wide
                    footer={<><button className="mg-btn" disabled={!parsed.some(x => x.ok)} onClick={addParsed}>הוסף {parsed.filter(x => x.ok).length} הוצאות</button>
                              <button className="mg-btn ghost" onClick={() => setPaste(null)}>ביטול</button></>}>
        <div style={{ fontSize: 14, marginBottom: 6 }}>שורה לכל הוצאה: <b>שם, סכום, יום בחודש</b>. למשל:</div>
        <div dir="rtl" style={{ fontSize: 13, color: 'var(--muted)', background: 'var(--soft)', borderRadius: 8, padding: '6px 10px', marginBottom: 8, whiteSpace: 'pre-line' }}>{'שכירות קליניקה, 4500, 1\nטלפון סלולרי, 89, 10\nביטוח מקצועי, 250, 15\nרואה חשבון, 590, 5\nClaude מנוי, 75, 20, ללא מע״מ'}</div>
        <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={7} style={{ width: '100%' }} placeholder="הדבק או הקלד כאן…" autoFocus />
        <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}>
          <Field label="לרשום החל מחודש"><input type="month" value={pasteFrom} onChange={e => setPasteFrom(e.target.value || thisMonth())} /></Field>
          <button type="button" className={'mg-btn sm' + (pasteFrom === yearStart ? '' : ' ghost')} onClick={() => setPasteFrom(yearStart)}>מתחילת השנה</button>
          <button type="button" className={'mg-btn sm' + (pasteFrom === thisMonth() ? '' : ' ghost')} onClick={() => setPasteFrom(thisMonth())}>מהחודש</button>
        </div>
        {parsed.length > 0 && <div style={{ marginTop: 10 }}>{parsed.map((x, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px dashed var(--line)', color: x.ok ? undefined : 'var(--bad)', fontSize: 14 }}>
            <span style={{ flex: 1 }}>{x.ok ? '✓' : '✗'} <b>{x.name}</b> · ב-{x.day} לחודש · {x.cat}{x.vatMode === 'none' ? ' · ללא מע״מ' : x.vatMode === 'car' ? ' · רכב' : ''}{x.share < 100 ? ` · ${x.share}% לעסק מתוך ${fmt(x.gross)}` : ''}{x.estimate ? ' · משוער' : ''}</span>
            <b dir="ltr">{x.ok ? fmt(x.gross * x.share / 100) : 'חסר סכום'}</b></div>))}</div>}
      </Box>}
    </div>
  );
}

function ExpenseList({ outgo, supName, onEdit, onDel, onFile }) {
  const [month, setMonth] = useState('');
  const [cat, setCat] = useState('');
  const list = outgo.filter(e => (!month || (e.date || '').startsWith(month)) && (!cat || e.cat === cat));
  const sum = list.reduce((a, e) => a + e.gross, 0), vat = list.reduce((a, e) => a + e.vat, 0);
  const [lim, more] = useLimit([month, cat]);
  return (
    <>
      <div data-tour="exp-filters" style={{ ...row, marginBottom: 12 }}>
        <Field label="חודש"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
        <Field label="קטגוריה"><select value={cat} onChange={e => setCat(e.target.value)}>
          <option value="">הכול</option>{EXP_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`expenses-${month || 'all'}.csv`, [
          ['תאריך', 'ספק', 'תיאור', 'קטגוריה', 'אמצעי תשלום', 'מסמך', 'לפני מע״מ', 'מע״מ מוכר', 'סה״כ'],
          ...list.map(e => [e.date, supName(e.supplierId) || e.supplierName || '', e.desc, e.cat, e.pay, e.docNo, r2(e.gross - e.vat), e.vat, e.gross])
        ])}>⬇ ייצוא</button>
      </div>
      <div data-tour="exp-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>תאריך</th><th>ספק</th><th>תיאור</th><th>קטגוריה</th><th>מסמך</th><th>לפני מע״מ</th><th>מע״מ</th><th>סה״כ</th><th></th></tr></thead>
        <tbody>
          {list.slice(0, lim).map(e => (
            <tr key={e.id}>
              <td>{heDate(e.date)}</td>
              <td>{supName(e.supplierId) || e.supplierName || '—'}</td>
              <td>{e.desc}{e.review && <span className="mg-chip warn" style={{ marginInlineStart: 6 }}>לבדיקה</span>}{e.recurring && <span className="mg-chip" style={{ marginInlineStart: 6 }}>🔁 קבועה</span>}</td>
              <td><span className="mg-chip">{e.cat}</span></td>
              <td>{e.docNo || (e.hasDoc ? 'יש' : e.recurring ? <span style={{ color: 'var(--muted)' }}>—</span> : <span style={{ color: 'var(--warn)' }}>חסר</span>)}
                {e.file?.inboxId && onFile && <button className="mg-btn ghost sm" style={{ marginInlineStart: 6 }} title="החשבונית" onClick={() => onFile(e)}>📎</button>}</td>
              <td>{fmt(e.gross - e.vat)}</td><td>{fmt(e.vat)}</td><td><b>{fmt(e.gross)}</b></td>
              <td><div style={{ display: 'flex', gap: 4 }}>
                <button className="mg-btn ghost sm" onClick={() => onEdit(e)}>✎</button>
                <button className="mg-btn ghost sm" onClick={() => onDel(e)}>🗑</button></div></td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={9}><div className="mg-empty">אין הוצאות בסינון הזה.</div></td></tr>}
          <ShowMore n={lim} total={list.length} onMore={more} cols={9} />
        </tbody>
      </table></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 10, gap: 18, fontSize: 14 }}>
        <span>סה״כ: <b>{fmt(sum)}</b></span><span>מע״מ לקיזוז: <b>{fmt(vat)}</b></span><span>לפני מע״מ: <b>{fmt(sum - vat)}</b></span>
      </div>
    </>
  );
}

function ExpenseForm({ rec, init, rate, suppliers, onSave, onClose, onNewSupplier, onFile }) {
  const [f, setF] = useState(() => {
    const base = { id: uid('exp'), date: todayIso(), supplierId: '', desc: '', cat: EXP_CATS[0], pay: PAY_METHODS[0],
                   gross: '', vatMode: rate > 0 ? 'full' : 'none', vatManual: '', docNo: '', ...(rec || init?.f || {}) };
    const s = suppliers.find(x => x.id === base.supplierId);
    return init && s?.cat ? { ...base, cat: s.cat } : base;
  });
  const [newSup, setNewSup] = useState(init?.newSup || '');
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const g = Number(f.gross) || 0;
  /* Deductible VAT: full, a private car's two thirds, none, or typed in. */
  const vat = rate === 0 ? 0
            : f.vatMode === 'full' ? vatOf(g, rate)
            : f.vatMode === 'car' ? r2(vatOf(g, rate) * 2 / 3)
            : f.vatMode === 'manual' ? r2((g < 0 ? -1 : 1) * Math.abs(Number(f.vatManual) || 0)) : 0;
  /* A supplier's credit note is a negative expense. */
  const ok = String(f.desc).trim() && g !== 0 && f.date;
  const pickSupplier = (id) => {
    const s = suppliers.find(x => x.id === id);
    setF(p => ({ ...p, supplierId: id, cat: s?.cat && !rec ? s.cat : p.cat }));
  };
  return (
    <Box title={rec ? 'עריכת הוצאה' : init ? 'רישום חשבונית שהגיעה במייל' : 'הוצאה חדשה'} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={!ok}
                           onClick={() => onSave({ ...f, gross: g, vat, desc: f.estimate ? String(f.desc).replace(/\s*\(הערכה\)/, '').trim() : String(f.desc).trim(), hasDoc: !!f.docNo || !!f.hasDoc || !!f.file, review: false, estimate: false })}>שמור</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      {init?.replaces && <div className="mg-note warn" style={{ marginBottom: 8 }}>החשבונית מחליפה את ההערכה של החודש ({fmt(init.replaces.gross)}). בדוק את הסכום בפועל ושמור.</div>}
      {init && <div className="mg-note" style={{ marginBottom: 12 }}>
        {init.read ? <>מה שנקרא מהקובץ כבר מולא. <b>בדוק את הסכום, המע״מ והתאריך</b> לפני השמירה.</> : <>לא הצלחתי לקרוא טקסט מהקובץ (למשל תמונה או סריקה). מלא את הסכום לפי החשבונית.</>}
        {init.foreign && <div style={{ marginTop: 6, color: 'var(--warn)', fontWeight: 700 }}>⚠ החשבונית ב-{init.foreign}. הסכום שנקרא ({init.f.gross}) אינו בשקלים: הזן את הסכום בשקלים כפי שחויב בכרטיס. מע״מ: ללא (ספק מחו״ל).</div>}
        {onFile && <>{' '}<button className="mg-btn ghost sm" onClick={() => onFile(f)}>👁 פתח את החשבונית</button></>}</div>}
      {!init && f.file?.inboxId && onFile && <div style={{ marginBottom: 10 }}><button className="mg-btn ghost sm" onClick={() => onFile(f)}>📎 {f.file.name || 'החשבונית'}</button></div>}
      <div style={grid}>
        <Field label="תאריך"><input type="date" value={f.date} onChange={e => set('date', e.target.value)} /></Field>
        <Field label="ספק"><select value={f.supplierId} onChange={e => pickSupplier(e.target.value)}>
          <option value="">— ללא —</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="או ספק חדש">
          <div style={{ display: 'flex', gap: 6 }}><input value={newSup} onChange={e => setNewSup(e.target.value)} />
            <button type="button" className="mg-btn ghost sm" disabled={!newSup.trim()} onClick={async () => {
              const s = { id: uid('sup'), name: newSup.trim(), cat: f.cat, taxId: init?.supTax || '', phone: '', email: init?.supEmail || '' };
              if (await onNewSupplier(s)) { setF(p => ({ ...p, supplierId: s.id })); setNewSup(''); }
            }}>＋</button></div></Field>
        <Field label="תיאור"><input value={f.desc} onChange={e => set('desc', e.target.value)} /></Field>
        <Field label="קטגוריה"><select value={f.cat} onChange={e => set('cat', e.target.value)}>{EXP_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="אמצעי תשלום"><select value={f.pay} onChange={e => set('pay', e.target.value)}>{PAY_METHODS.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="מספר חשבונית של הספק"><input value={f.docNo} onChange={e => set('docNo', e.target.value)} /></Field>
        <Field label="סכום כולל מע״מ (₪)"><input inputMode="decimal" value={f.gross} onChange={e => set('gross', e.target.value)} /></Field>
        {rate > 0 && <Field label="מע״מ מוכר לקיזוז"><select value={f.vatMode} onChange={e => set('vatMode', e.target.value)}>
          <option value="full">מלא ({rate}%)</option><option value="car">רכב פרטי (2/3)</option>
          <option value="none">ללא (ספק פטור / חו״ל)</option><option value="manual">סכום ידני</option></select></Field>}
        {rate > 0 && f.vatMode === 'manual' && <Field label="סכום המע״מ"><input inputMode="decimal" value={f.vatManual} onChange={e => set('vatManual', e.target.value)} /></Field>}
      </div>
      <div className="mg-note" style={{ marginTop: 12 }}>
        לפני מע״מ <b>{fmt(g - vat)}</b> · מע״מ לקיזוז <b>{fmt(vat)}</b> · סה״כ <b>{fmt(g)}</b>
      </div>
    </Box>
  );
}

/* ------------------------------------------------------------------- ספקים */
function SupplierList({ suppliers, outgo, onEdit, onDel }) {
  const year = new Date().getFullYear().toString();
  return (
    <>
      <div data-tour="sup-new" style={{ marginBottom: 12 }}><button className="mg-btn" onClick={() => onEdit(null)}>＋ ספק חדש</button></div>
      <div data-tour="sup-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>שם</th><th>ח.פ. / ע.מ.</th><th>טלפון</th><th>אימייל</th><th>קטגוריה</th><th>השנה</th><th>סה״כ</th><th></th></tr></thead>
        <tbody>
          {[...suppliers].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he')).map(s => {
            const mine = outgo.filter(e => e.supplierId === s.id);
            return (
              <tr key={s.id}>
                <td><b>{s.name}</b>{s.review && <span className="mg-chip warn" style={{ marginInlineStart: 6 }}>יובא</span>}</td>
                <td dir="ltr" style={{ textAlign: 'right' }}>{s.taxId || '—'}</td>
                <td dir="ltr" style={{ textAlign: 'right' }}>{s.phone || '—'}</td>
                <td>{s.email || '—'}</td><td>{s.cat || '—'}</td>
                <td>{fmt(mine.filter(e => (e.date || '').startsWith(year)).reduce((a, e) => a + e.gross, 0))}</td>
                <td>{fmt(mine.reduce((a, e) => a + e.gross, 0))} <span style={{ color: 'var(--muted)', fontSize: 12 }}>({mine.length})</span></td>
                <td><div style={{ display: 'flex', gap: 4 }}>
                  <button className="mg-btn ghost sm" onClick={() => onEdit(s)}>✎</button>
                  <button className="mg-btn ghost sm" onClick={() => onDel(s)}>🗑</button></div></td>
              </tr>
            );
          })}
          {!suppliers.length && <tr><td colSpan={8}><div className="mg-empty">עוד אין ספקים.</div></td></tr>}
        </tbody>
      </table></div>
    </>
  );
}

function SupplierForm({ rec, onSave, onClose }) {
  const [f, setF] = useState(() => ({ id: uid('sup'), name: '', taxId: '', phone: '', email: '', cat: EXP_CATS[0], notes: '', ...(rec || {}) }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <Box title={rec ? 'עריכת ספק' : 'ספק חדש'} onClose={onClose}
         footer={<><button className="mg-btn" disabled={!String(f.name).trim()} onClick={() => onSave({ ...f, name: String(f.name).trim(), review: false })}>שמור</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div style={grid}>
        <Field label="שם"><input value={f.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="ח.פ. / ע.מ."><input dir="ltr" value={f.taxId} onChange={e => set('taxId', e.target.value)} /></Field>
        <Field label="טלפון"><input dir="ltr" value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
        <Field label="אימייל"><input dir="ltr" value={f.email} onChange={e => set('email', e.target.value)} /></Field>
        <Field label="קטגוריה קבועה"><select value={f.cat} onChange={e => set('cat', e.target.value)}>{EXP_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="הערות"><input value={f.notes || ''} onChange={e => set('notes', e.target.value)} /></Field>
      </div>
    </Box>
  );
}

/* --------------------------------------------------------------------- בנק */
function BankTab({ bank, income, outgo, onSave, onDel, onBulk, flash }) {
  const [show, setShow] = useState('open');
  const [add, setAdd] = useState(null);
  const [busy, setBusy] = useState(false);

  const taken = new Set(bank.map(b => b.matchId).filter(Boolean));
  /* Same amount, within a week. */
  const candidates = (b) => {
    const t = Date.parse(b.date);
    const near = (d) => Math.abs(Date.parse(d) - t) <= 7 * 86400000;
    const pool = b.amount > 0
      ? income.map(i => ({ id: i.id, label: `${heDate(i.date)} · ${i.desc}`, amt: i.gross, date: i.date }))
      : outgo.map(e => ({ id: 'e:' + e.id, label: `${heDate(e.date)} · ${e.desc}`, amt: e.gross, date: e.date }));
    return pool.filter(p => Math.abs(p.amt - Math.abs(b.amount)) < 1 && p.date && near(p.date)
                         && (!taken.has(p.id) || p.id === b.matchId));
  };
  const labelOf = (id) => {
    if (id.startsWith('e:')) { const e = outgo.find(x => 'e:' + x.id === id); return e ? `הוצאה · ${e.desc}` : 'הוצאה שנמחקה'; }
    const i = income.find(x => x.id === id); return i ? `הכנסה · ${i.desc}` : 'הכנסה שנמחקה';
  };

  const autoMatch = async () => {
    setBusy(true);
    const used = new Set(taken);
    const recs = [];
    bank.filter(b => !b.matchId && !b.ignored).forEach(b => {
      const c = candidates(b).filter(x => !used.has(x.id));
      if (c.length === 1) { used.add(c[0].id); recs.push({ ...b, matchId: c[0].id }); }
    });
    const n = recs.length ? await onBulk(recs) : 0;
    setBusy(false);
    flash(n ? `הותאמו ${n} שורות` : 'לא נמצאו התאמות חד-משמעיות. אפשר להתאים ידנית.');
  };

  const importFile = async (file) => {
    if (!file) return;
    const rows = parseBankCSV(await file.text());
    if (!rows.length) { flash('לא זוהו שורות בקובץ. צריך CSV עם תאריך, תיאור וסכום.'); return; }
    const have = new Set(bank.map(b => `${b.date}|${b.amount}|${b.desc}`));
    const batch = uid('imp');
    const fresh = rows.filter(r => !have.has(`${r.date}|${r.amount}|${r.desc}`))
      .map(r => ({ ...r, id: uid('bk'), batch, matchId: '', ignored: false }));
    setBusy(true);
    const n = fresh.length ? await onBulk(fresh) : 0;
    setBusy(false);
    flash(`יובאו ${n} שורות חדשות${rows.length - fresh.length ? ` · ${rows.length - fresh.length} כבר היו` : ''}`);
  };

  const list = [...bank].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter(b => show === 'all' || (show === 'open' ? !b.matchId && !b.ignored : !!b.matchId));

  return (
    <>
      <div data-tour="bank-stats" className="mg-stats" style={{ marginBottom: 14 }}>
        <div className="mg-stat"><div className="lb">שורות בנק</div><div className="vl">{bank.length}</div></div>
        <div className="mg-stat"><div className="lb">הותאמו</div><div className="vl">{bank.filter(b => b.matchId).length}</div></div>
        <div className="mg-stat"><div className="lb">פתוחות</div><div className="vl">{bank.filter(b => !b.matchId && !b.ignored).length}</div></div>
        <div className="mg-stat"><div className="lb">תנועה נטו</div><div className="vl">{fmt(bank.reduce((a, b) => a + (Number(b.amount) || 0), 0))}</div></div>
      </div>
      <div data-tour="bank-tools" style={{ ...row, marginBottom: 12, alignItems: 'center' }}>
        <label className="mg-btn" style={{ cursor: 'pointer' }}>⬆ ייבוא דף בנק (CSV)
          <input type="file" accept=".csv,text/csv,.txt" hidden onChange={e => { importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <button className="mg-btn ghost" disabled={busy} onClick={autoMatch}>↻ התאמה אוטומטית</button>
        <button className="mg-btn ghost" onClick={() => setAdd({ id: uid('bk'), date: todayIso(), desc: '', amount: '', matchId: '' })}>＋ שורה ידנית</button>
        <select value={show} onChange={e => setShow(e.target.value)} style={{ width: 'auto' }}>
          <option value="open">פתוחות</option><option value="done">מותאמות</option><option value="all">הכול</option></select>
      </div>
      <div className="mg-note" style={{ marginBottom: 12 }}>
        מורידים מאתר הבנק את התנועות לאקסל, שומרים כ-CSV ומעלים כאן. ההתאמה מחפשת תנועה באותו סכום, עד שבוע מהתאריך.
      </div>
      <div data-tour="bank-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>תאריך</th><th>תיאור בבנק</th><th>סכום</th><th>מותאם ל</th><th></th></tr></thead>
        <tbody>
          {list.map(b => {
            const c = candidates(b);
            return (
              <tr key={b.id} style={b.ignored ? { opacity: .5 } : undefined}>
                <td>{heDate(b.date)}</td><td>{b.desc}</td>
                <td style={{ color: b.amount > 0 ? 'var(--green2)' : 'var(--bad)', fontWeight: 700 }} dir="ltr">{fmt(b.amount)}</td>
                <td>{b.matchId ? <span className="mg-chip ok">{labelOf(b.matchId)}</span>
                  : b.ignored ? <span className="mg-chip">לא רלוונטי</span>
                  : c.length
                    ? <select value="" onChange={e => e.target.value && onSave({ ...b, matchId: e.target.value })}>
                        <option value="">{c.length} הצעות, בחר…</option>
                        {c.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
                    : <span style={{ color: 'var(--warn)', fontSize: 13 }}>אין תנועה תואמת. הוסף הכנסה או הוצאה.</span>}</td>
                <td><div style={{ display: 'flex', gap: 4 }}>
                  {b.matchId && <button className="mg-btn ghost sm" onClick={() => onSave({ ...b, matchId: '' })}>בטל התאמה</button>}
                  {!b.matchId && <button className="mg-btn ghost sm" onClick={() => onSave({ ...b, ignored: !b.ignored })}>{b.ignored ? 'החזר' : 'התעלם'}</button>}
                  <button className="mg-btn ghost sm" onClick={() => onDel(b)}>🗑</button></div></td>
              </tr>
            );
          })}
          {!list.length && <tr><td colSpan={5}><div className="mg-empty">{show === 'open' ? 'אין שורות פתוחות.' : 'אין שורות.'}</div></td></tr>}
        </tbody>
      </table></div>

      {add && (
        <Box title="שורת בנק" onClose={() => setAdd(null)}
             footer={<><button className="mg-btn" disabled={!add.date || !num(add.amount)}
                               onClick={async () => { if (await onSave({ ...add, amount: r2(num(add.amount)) })) setAdd(null); }}>שמור</button>
                       <button className="mg-btn ghost" onClick={() => setAdd(null)}>ביטול</button></>}>
          <div style={grid}>
            <Field label="תאריך"><input type="date" value={add.date} onChange={e => setAdd(a => ({ ...a, date: e.target.value }))} /></Field>
            <Field label="תיאור"><input value={add.desc} onChange={e => setAdd(a => ({ ...a, desc: e.target.value }))} /></Field>
            <Field label="סכום (זיכוי חיובי, חיוב במינוס)"><input dir="ltr" value={add.amount} onChange={e => setAdd(a => ({ ...a, amount: e.target.value }))} /></Field>
          </div>
        </Box>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- מע״מ */
function VatTab({ totals, rate, book }) {
  const [mode, setMode] = useState('bi');
  const [month, setMonth] = useState(thisMonth());
  const start = mode === 'bi' ? biStart(month) : month;
  const end = mode === 'bi' ? addMonths(start, 1) : start;
  const t = totals(start, end);
  const label = start === end ? monthName(start) : `${monthName(start)}–${monthName(end)}`;

  if (rate === 0) return (
    <div className="mg-note">
      העסק מוגדר כ<b>עוסק פטור</b>, ולכן אין דיווח מע״מ תקופתי. מחזור השנה עד כה:{' '}
      <b>{fmt(totals(month.slice(0, 4) + '-01', month.slice(0, 4) + '-12').incGross)}</b>.
      עוסק פטור שעובר את תקרת המחזור השנתית צריך לעבור לעוסק מורשה.
    </div>
  );

  return (
    <>
      <div data-tour="vat-period" style={{ ...row, marginBottom: 14 }}>
        <Field label="תדירות דיווח"><select value={mode} onChange={e => setMode(e.target.value)}>
          <option value="bi">דו-חודשי</option><option value="month">חודשי</option></select></Field>
        <Field label="תקופה"><input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} /></Field>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`vat-${book.name}-${start}${start !== end ? '_' + end : ''}.csv`, [
          ['דוח מע״מ', label], ['עוסק', book.legalName || book.name, book.taxId || ''], [],
          ['', 'בסיס (לפני מע״מ)', 'מע״מ'],
          ['עסקאות חייבות', r2(t.incNet), r2(t.incVat)],
          ['תשומות', r2(t.expNet), r2(t.expVat)],
          ['לתשלום / להחזר', '', r2(t.vatDue)], [],
          ['פירוט עסקאות'], ['תאריך', 'תיאור', 'מסמך', 'לפני מע״מ', 'מע״מ', 'סה״כ'],
          ...t.inc.map(i => [i.date, i.desc, i.docNo, r2(i.gross - i.vat), i.vat, i.gross]), [],
          ['פירוט תשומות'], ['תאריך', 'תיאור', 'מסמך', 'לפני מע״מ', 'מע״מ', 'סה״כ'],
          ...t.exp.map(e => [e.date, e.desc, e.docNo, r2(e.gross - e.vat), e.vat, e.gross]),
        ])}>⬇ דוח לרואה החשבון</button>
      </div>
      <div data-tour="vat-stats" className="mg-stats" style={{ marginBottom: 16 }}>
        <div className="mg-stat"><div className="lb">עסקאות (לפני מע״מ)</div><div className="vl">{fmt(t.incNet)}</div><div className="dl">מע״מ עסקאות {fmt(t.incVat)}</div></div>
        <div className="mg-stat"><div className="lb">תשומות (לפני מע״מ)</div><div className="vl">{fmt(t.expNet)}</div><div className="dl">מע״מ תשומות {fmt(t.expVat)}</div></div>
        <div className="mg-stat"><div className="lb">{t.vatDue >= 0 ? 'לתשלום' : 'להחזר'} · {label}</div><div className="vl">{fmt(Math.abs(t.vatDue))}</div>
          <div className="dl">עד ה-15 בחודש שאחרי התקופה</div></div>
      </div>
      {t.inc.some(i => !i.docNo) && <div className="mg-note warn" style={{ marginBottom: 12 }}>
        {t.inc.filter(i => !i.docNo).length} הכנסות בתקופה בלי מסמך. המע״מ שלהן נספר, אבל כל אחת צריכה חשבונית.</div>}
      {t.exp.some(e => e.vat > 0 && !e.docNo && !e.hasDoc) && <div className="mg-note warn" style={{ marginBottom: 12 }}>
        יש תשומות בלי מספר חשבונית. בלי חשבונית מס מקורית אי אפשר לקזז אותן.</div>}
      <div className="mg-note">
        חישוב עזר לפי מה שרשום במערכת, לא דיווח רשמי. אם כמה עסקים רשומים תחת אותו ע.מ., הדיווח המאוחד נמצא בדף "כל העסקים".
      </div>
    </>
  );
}

/* ------------------------------------------------------------ רווח והפסד */

/* ============================================================ income tax */
/* A forecast, not a return: 2026 figures for an individual (self-employed),
   and the company rate for a company. They change every January and are
   kept together here. Sources: kolzchut.org.il (brackets, credit point),
   Bituach Leumi rates for the self-employed, 2026. */
const TAX = {
  year: 2026,
  brackets: [[84120, 0.10], [120720, 0.14], [228000, 0.20], [301200, 0.31], [560280, 0.35], [721560, 0.47], [Infinity, 0.50]],
  point: 2904,                 // one credit point, a year
  ni: { low: 7703, max: 51910, niLow: 0.0287, niHigh: 0.1283, hLow: 0.0323, hHigh: 0.0517, deductible: 0.52 },
  company: 0.23,
};
const TAX_PROFILE_KEY = 'tzbooks_taxprofile';
const isCompanyId = (t) => /^5\d{8}$/.test(digitsOf(t));
function bracketTax(income) {
  let tax = 0, prev = 0; const steps = [];
  for (const [top, rate] of TAX.brackets) {
    if (income <= prev) break;
    const part = Math.min(income, top) - prev;
    if (part > 0) { tax += part * rate; steps.push({ from: prev, to: Math.min(income, top), rate, tax: part * rate }); }
    prev = top;
  }
  return { tax, steps, marginal: steps.length ? steps[steps.length - 1].rate : TAX.brackets[0][1] };
}
/* National Insurance and health tax on a year's business profit, self-employed. */
function niOf(annual) {
  const m = Math.max(0, annual) / 12, n = TAX.ni;
  const low = Math.min(m, n.low), high = Math.max(0, Math.min(m, n.max) - n.low);
  const ni = 12 * (low * n.niLow + high * n.niHigh), health = 12 * (low * n.hLow + high * n.hHigh);
  return { ni, health, total: ni + health, deduct: ni * n.deductible };
}
function taxForecast(profit, { points = 2.25, other = 0, company = false } = {}) {
  const p = Math.max(0, profit);
  if (company) { const tax = p * TAX.company; return { company: true, profit: p, tax, ni: 0, health: 0, total: tax, rate: p ? tax / p : 0 }; }
  const n = niOf(p);
  const taxable = Math.max(0, p - n.deduct - Math.max(0, other));
  const b = bracketTax(taxable);
  const credit = Math.max(0, points) * TAX.point;
  const tax = Math.max(0, b.tax - credit);
  return { profit: p, taxable, deductNi: n.deduct, other, gross: b.tax, credit, tax, ni: n.ni, health: n.health,
           total: tax + n.total, rate: p ? (tax + n.total) / p : 0, marginal: b.marginal, steps: b.steps };
}
/* How far into the year: whole months plus today's share of this one. */
function yearShare(now = todayIso()) {
  const [y, m, d] = now.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  return ((m - 1) + d / days) / 12;
}

const fmtRound = (n) => fmt(Math.round(Number(n) || 0));
function TaxForecast({ book, rows, onLoad, compact }) {
  const y = todayIso().slice(0, 4);
  const [prof, setProf] = useState(() => lsGet(TAX_PROFILE_KEY, {}) || {});
  const save = (patchObj) => { const n = { ...prof, ...patchObj }; setProf(n); try { lsSet(TAX_PROFILE_KEY, n); } catch {} };
  const [mode, setMode] = useState('year');
  const [open, setOpen] = useState(false);
  useEffect(() => { onLoad?.(); }, []);
  const company = isCompanyId(book.taxId);
  const share = yearShare();
  const ytd = rows.filter(r => r.ready).reduce((a, r) => a + r.profit, 0);
  const waiting = rows.filter(r => !r.ready);
  const base = mode === 'year' && share > 0.04 ? ytd / share : ytd;
  /* Advances are per taxpayer: each tax id (a person, or a company) keeps its own. */
  const tid = digitsOf(book.taxId) || book.id, advKey = `${tid}:${y}`;
  /* Two payees, two sets of advances: the Tax Authority, and Bituach Leumi. */
  const blKey = `${advKey}:bl`;
  const points = prof.points ?? 2.25, adv = Number(prof.adv?.[advKey]) || 0, advBl = Number(prof.adv?.[blKey]) || 0, other = Number(prof.deduct) || 0;
  const f = taxForecast(base, { points, other, company });
  const dueNow = mode === 'year' ? f.total : f.total;
  const bl = company ? 0 : f.ni + f.health;
  const leftTax = Math.max(0, f.tax - adv), leftBl = Math.max(0, bl - advBl), left = leftTax + leftBl;
  const monthsLeft = Math.max(1, 12 - Number(todayIso().slice(5, 7)) + 1);
  const fmt = (n) => fmtRound(n);
  const L = ({ l, v, b, c, sub }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderBottom: '1px solid #f0ebe0', fontWeight: b ? 800 : 400, color: c }}>
    <span style={{ flex: 1, minWidth: 0 }}>{l}{sub && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 13 }}> · {sub}</span>}</span><span dir="ltr" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{fmt(v)}</span></div>;
  if (compact) return (
    <div className="mg-stat" data-tour="tax-tile"><div className="lb">{company ? 'מס חברות צפוי' : 'מס הכנסה צפוי'} {y}</div>
      <div className="vl">{fmt(f.tax)}</div>
      <div className="dl">{company ? `${fmt(f.tax / 12)} לחודש` : <>ביטוח לאומי + בריאות {fmt(bl)}<br />להפריש יחד {fmt((f.tax + bl) / 12)} לחודש</>}{waiting.length ? ' · חלקי' : ''}</div></div>
  );
  return (
    <div data-tour="tax-forecast" className="mg-card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>צפי {company ? 'מס חברות' : 'מס הכנסה · ביטוח לאומי'} · {y}</h3>
        <div className="seg" style={{ maxWidth: 320 }}>
          <button className={mode === 'year' ? 'on' : ''} onClick={() => setMode('year')}>צפי לשנה מלאה</button>
          <button className={mode === 'ytd' ? 'on' : ''} onClick={() => setMode('ytd')}>על מה שהיה עד היום</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 10px' }}>
        {rows.length > 1 ? `כולל את כל העסקים שלך באותו מספר עוסק: ${rows.map(r => r.name).join(', ')}. ` : ''}
        רווח מתחילת השנה {fmt(ytd)}{mode === 'year' && share > 0.04 ? ` (${Math.round(share * 100)}% מהשנה), ולכן לשנה מלאה בערך ${fmt(base)}` : ''}.
        {waiting.length > 0 && <> <b style={{ color: 'var(--warn)' }}>עוד לא נטען: {waiting.map(r => r.name).join(', ')}.</b></>}</div>
      <div className="mg-stats" style={{ marginBottom: 12 }}>
        <div className="mg-stat"><div className="lb">{company ? 'מס חברות' : 'מס הכנסה'} · {mode === 'year' ? 'צפוי לשנה' : 'עד היום'}</div><div className="vl">{fmt(f.tax)}</div>
          <div className="dl">{fmt(mode === 'year' ? f.tax / 12 : f.tax / Math.max(1, share * 12))} לחודש · נותר {fmt(leftTax)} אחרי מקדמות {fmt(adv)}</div></div>
        {!company && <div className="mg-stat"><div className="lb">ביטוח לאומי + מס בריאות</div><div className="vl">{fmt(bl)}</div>
          <div className="dl">ביטוח לאומי {fmt(f.ni)} · בריאות {fmt(f.health)}<br />{fmt(mode === 'year' ? bl / 12 : bl / Math.max(1, share * 12))} לחודש · נותר {fmt(leftBl)} אחרי מקדמות {fmt(advBl)}</div></div>}
        <div className="mg-stat"><div className="lb">להפריש כל חודש {company ? '' : '(שניהם)'}</div><div className="vl">{fmt(mode === 'year' ? (f.tax + bl) / 12 : (f.tax + bl) / Math.max(1, share * 12))}</div>
          <div className="dl">{Math.round(f.rate * 100)}% מהרווח{mode === 'year' && left > 0 ? ` · ${fmt(left / monthsLeft)} לחודש עד סוף השנה כדי לסגור את היתרה` : ''}</div></div>
        {!company && <div className="mg-stat"><div className="lb">מדרגת מס שולית</div><div className="vl">{Math.round((f.marginal || 0) * 100)}%</div>
          <div className="dl">כל ₪1,000 רווח נוסף ≈ {fmt(1000 * ((f.marginal || 0) + (base / 12 > TAX.ni.low ? TAX.ni.niHigh + TAX.ni.hHigh : TAX.ni.niLow + TAX.ni.hLow)))} מס וביטוח לאומי</div></div>}
      </div>
      <button className="mg-linkish" onClick={() => setOpen(o => !o)}>{open ? 'הסתר פירוט' : 'איך זה חושב?'}</button>
      {open && <div style={{ marginTop: 8 }}>
        <L l="רווח (הכנסות פחות הוצאות, לפני מע״מ)" v={f.profit} />
        {company ? <L l={`מס חברות ${Math.round(TAX.company * 100)}%`} v={f.tax} b /> : <>
          <L l="ניכוי 52% מדמי הביטוח הלאומי" v={-f.deductNi} />
          {f.other > 0 && <L l="ניכויים נוספים (פנסיה, קרן השתלמות)" v={-f.other} />}
          <L l="הכנסה חייבת" v={f.taxable} b />
          {f.steps.map((st, i) => <L key={i} l={`מדרגה ${Math.round(st.rate * 100)}%`} sub={`${fmt(st.from)}–${fmt(st.to)}`} v={st.tax} />)}
          <L l={`נקודות זיכוי (${points} × ${fmt(TAX.point)})`} v={-Math.min(f.credit, f.gross)} />
          <L l="מס הכנסה" v={f.tax} b />
          <L l="ביטוח לאומי" v={f.ni} /><L l="מס בריאות" v={f.health} />
        </>}
        <L l="סה״כ" v={f.total} b c="var(--green)" />
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(170px,100%),1fr))', gap: 10, marginTop: 12 }}>
        {!company && <Field label="נקודות זיכוי"><input inputMode="decimal" value={prof.points ?? 2.25} onChange={e => save({ points: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>}
        <Field label={`מקדמות ${company ? 'מס' : 'מס הכנסה'} ששולמו ב-${y}`}><input inputMode="decimal" value={prof.adv?.[advKey] ?? ''} placeholder="0" onChange={e => save({ adv: { ...(prof.adv || {}), [advKey]: e.target.value } })} /></Field>
        {!company && <Field label={`מקדמות ביטוח לאומי ששולמו ב-${y}`}><input inputMode="decimal" value={prof.adv?.[`${advKey}:bl`] ?? ''} placeholder="0" onChange={e => save({ adv: { ...(prof.adv || {}), [`${advKey}:bl`]: e.target.value } })} /></Field>}
        {!company && <Field label="ניכויים בשנה (פנסיה, השתלמות)"><input inputMode="decimal" value={prof.deduct ?? ''} placeholder="0" onChange={e => save({ deduct: e.target.value })} /></Field>}
      </div>
      <div className="mg-note" style={{ marginTop: 10, fontSize: 13 }}>
        הערכה בלבד, לפי מדרגות {TAX.year} ליחיד {company ? '' : 'ושיעורי ביטוח לאומי לעצמאי'}. לא כולל הכנסות אחרות (משכורת, שכר דירה), זיכויים מיוחדים או הוצאות שלא נרשמו כאן. המספר הסופי נקבע בדוח השנתי מול רואה החשבון.
      </div>
    </div>
  );
}

/* ============================================== payments to the authorities */
/* What a period should cost: VAT (sales less purchases), the income tax
   advance (turnover × the rate on the Tax Authority's notice) and Bituach
   Leumi's monthly advance, for every business under one tax id. Each line can
   be checked against what the accountant sent. Rates not entered yet are
   estimated from the year's forecast, and say so. */
const nMonths = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1) + 1; };
function periodOf(freq, ym) { const s = freq === 'month' ? ym : biStart(ym); return { start: s, end: freq === 'month' ? s : addMonths(s, 1) }; }
/* The last period that has ended. */
function lastPeriod(freq, today = thisMonth()) { const cur = periodOf(freq, today); return periodOf(freq, addMonths(cur.start, -1)); }
function authReport(rows, period, prof, tid) {
  const sum = { incNet: 0, incVat: 0, incGross: 0, expNet: 0, expVat: 0, vatBooks: 0, ytdProfit: 0, ytdTurn: 0, books: [] };
  const y = period.end.slice(0, 4), ytdTo = period.end < thisMonth() ? period.end : thisMonth();
  for (const { book, data } of rows) {
    if (!data || data.histPending) { sum.books.push({ name: book.name, ready: false }); continue; }
    const L = buildLedger(book, data), t = totals(L, period.start, period.end), ytd = totals(L, `${y}-01`, ytdTo);
    sum.incNet += t.incNet; sum.incVat += t.incVat; sum.incGross += t.incGross; sum.expNet += t.expNet; sum.expVat += t.expVat;
    if (L.rate > 0) sum.vatBooks++;
    sum.ytdProfit += ytd.profit; sum.ytdTurn += ytd.incNet; sum.books.push({ name: book.name, ready: true });
  }
  const months = nMonths(period.start, period.end);
  const company = isCompanyId(tid);
  /* The year so far, carried to a full year, for estimates. */
  const share = Math.max(0.08, Math.min(1, ytdTo === thisMonth() ? yearShare() : nMonths(`${y}-01`, ytdTo) / 12));
  const f = taxForecast(sum.ytdProfit / share, { points: prof.points ?? 2.25, other: Number(prof.deduct) || 0, company });
  const rateIn = Number(prof.advRate?.[tid]);
  const estRate = sum.ytdTurn > 0 ? f.tax / (sum.ytdTurn / share) : 0;
  const advRate = rateIn > 0 ? rateIn / 100 : estRate;
  const blIn = Number(prof.blMonthly?.[tid]);
  const blMonth = company ? 0 : blIn > 0 ? blIn : (f.ni + f.health) / 12;
  const lines = [
    sum.vatBooks ? { k: 'vat', label: 'מע״מ', amount: r2(sum.incVat - sum.expVat), to: 'רשות המסים (מע״מ)',
      detail: `עסקאות ${fmt(sum.incNet)} · מע״מ עסקאות ${fmt(sum.incVat)} · מע״מ תשומות ${fmt(sum.expVat)}` } : null,
    { k: 'tax', label: company ? 'מקדמת מס חברות' : 'מקדמת מס הכנסה', amount: r2(Math.max(0, sum.incNet) * advRate), to: 'מס הכנסה', est: !(rateIn > 0),
      detail: `מחזור ${fmt(sum.incNet)} × ${(advRate * 100).toFixed(1)}%${rateIn > 0 ? ' (מהודעת מס הכנסה)' : ' (הערכה לפי צפי המס: הזן את השיעור מהפנקס)'}` },
    company ? null : { k: 'bl', label: 'ביטוח לאומי + מס בריאות', amount: r2(blMonth * months), to: 'ביטוח לאומי', est: !(blIn > 0),
      detail: `${fmt(blMonth)} לחודש × ${months}${blIn > 0 ? ' (מהודעת ביטוח לאומי)' : ' (הערכה לפי צפי המס: הזן את המקדמה החודשית)'}` },
  ].filter(Boolean);
  return { period, months, lines, total: r2(lines.reduce((a, l) => a + l.amount, 0)), books: sum.books, partial: sum.books.some(b => !b.ready) };
}
const periodLabel = (p) => p.start === p.end ? monthName(p.start) : `${monthName(p.start)}–${monthName(p.end)}`;
const dueOf = (p) => { const n = addMonths(p.end, 1); return `15/${n.slice(5, 7)}/${n.slice(0, 4)}`; };

function AuthPayTab({ book, rows, onLoad, flash }) {
  const tid = digitsOf(book.taxId) || book.id;
  const [prof, setProf] = useState(() => lsGet(TAX_PROFILE_KEY, {}) || {});
  const save = (o) => { const n = { ...prof, ...o }; setProf(n); try { lsSet(TAX_PROFILE_KEY, n); } catch {} };
  const freq = prof.freq?.[tid] || 'bi';
  const [ym, setYm] = useState(() => lastPeriod(freq).start);
  useEffect(() => { onLoad?.(); }, []);
  const period = periodOf(freq, ym);
  const rep = authReport(rows, period, prof, tid);
  const pk = `${tid}:${period.start}:${period.end}`;
  const acct = prof.acct?.[pk] || {};
  const setAcct = (k, v) => save({ acct: { ...(prof.acct || {}), [pk]: { ...acct, [k]: v } } });
  const diffOf = (l) => acct[l.k] === undefined || acct[l.k] === '' ? null : r2(Number(acct[l.k]) - l.amount);
  const ended = period.end < thisMonth();
  const csv = () => downloadCSV(`payments-${book.name}-${period.start}_${period.end}.csv`, [
    ['תשלומים לרשויות', periodLabel(period), book.legalName || book.name, book.taxId || ''], [],
    ['תשלום', 'לפי המערכת', 'לפי רו״ח', 'הפרש', 'פירוט'],
    ...rep.lines.map(l => [l.label, l.amount, acct[l.k] ?? '', diffOf(l) ?? '', l.detail]), ['סה״כ', rep.total]]);
  const print = () => printHTML(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>תשלומים לרשויות</title>
    <style>body{font-family:Arial;padding:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:right}th{background:#f3efe6}.n{direction:ltr;text-align:left}</style></head><body>
    <h2>תשלומים לרשויות · ${periodLabel(period)}</h2><div>${book.legalName || book.name} · ${book.taxId || ''} · לתשלום עד ${dueOf(period)} (בדרך כלל)</div><br>
    <table><tr><th>תשלום</th><th>לפי המערכת</th><th>לפי רו״ח</th><th>הפרש</th><th>פירוט</th></tr>
    ${rep.lines.map(l => `<tr><td>${l.label}${l.est ? ' (הערכה)' : ''}</td><td class="n">${fmt(l.amount)}</td><td class="n">${acct[l.k] ? fmt(acct[l.k]) : ''}</td><td class="n">${diffOf(l) === null ? '' : fmt(diffOf(l))}</td><td>${l.detail}</td></tr>`).join('')}
    <tr><th>סה״כ</th><th class="n">${fmt(rep.total)}</th><th></th><th></th><th></th></tr></table>
    <p style="font-size:12px;color:#666">הופק ב-Tizon Books ${VERSION}. הערכה לבקרה פנימית בלבד; הסכומים לתשלום הם אלה שבהודעות הרשויות ומרואה החשבון.</p></body></html>`);
  return (
    <div data-tour="pay-auth">
      <div style={{ ...row, marginBottom: 12 }}>
        <Field label="תדירות"><select value={freq} onChange={e => { save({ freq: { ...(prof.freq || {}), [tid]: e.target.value } }); setYm(lastPeriod(e.target.value).start); }}>
          <option value="bi">דו-חודשי</option><option value="month">חודשי</option></select></Field>
        <Field label="תקופה"><input type="month" value={ym} onChange={e => e.target.value && setYm(e.target.value)} /></Field>
        <button className="mg-btn ghost sm keep" onClick={() => setYm(addMonths(period.start, -1))}>‹ קודמת</button>
        <button className="mg-btn ghost sm keep" onClick={() => setYm(addMonths(period.end, 1))}>הבאה ›</button>
      </div>
      <div className="mg-card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>לתשלום לרשויות · {periodLabel(period)}</h3>
          <span style={{ color: ended ? 'var(--ink)' : 'var(--warn)', fontSize: 14, fontWeight: 700 }}>{ended ? `לתשלום עד ${dueOf(period)} (בדרך כלל)` : 'התקופה עוד לא הסתיימה: הסכומים עד היום'}</span>
        </div>
        {(rows.length > 1 || rep.partial) && <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0' }}>
          {rows.length > 1 ? `כולל את כל העסקים שלך במספר עוסק ${book.taxId}: ${rows.map(r => r.book.name).join(', ')}. ` : ''}
          {rep.partial && <b style={{ color: 'var(--warn)' }}>עוד נטען: {rep.books.filter(b => !b.ready).map(b => b.name).join(', ')}.</b>}</div>}
        <div className="mg-tblwrap" style={{ marginTop: 10 }}><table className="mg-tbl">
          <thead><tr><th>תשלום</th><th>לפי המערכת</th><th>לפי רו״ח (הזן)</th><th>בדיקה</th></tr></thead>
          <tbody>{rep.lines.map(l => { const d = diffOf(l); return (
            <tr key={l.k}>
              <td className="stack"><span><b>{l.label}</b>{l.est && <span className="mg-chip warn" style={{ marginInlineStart: 6 }}>הערכה</span>}</span>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 400 }}>{l.detail}</div></td>
              <td><b dir="ltr">{fmt(l.amount)}</b></td>
              <td><input inputMode="decimal" style={{ maxWidth: 130 }} value={acct[l.k] ?? ''} placeholder="—" onChange={e => setAcct(l.k, e.target.value)} /></td>
              <td>{d === null ? <span style={{ color: 'var(--muted)' }}>—</span> : Math.abs(d) <= 1 ? <span style={{ color: 'var(--green)', fontWeight: 800 }}>✓ תואם</span>
                : <span style={{ color: 'var(--bad)', fontWeight: 800 }}>⚠ הפרש {fmt(d)}</span>}</td>
            </tr>); })}
            <tr><td><b>סה״כ</b></td><td><b dir="ltr">{fmt(rep.total)}</b></td>
              <td>{Object.values(acct).some(v => v !== '') ? <b dir="ltr">{fmt(Object.values(acct).reduce((a, v) => a + (Number(v) || 0), 0))}</b> : ''}</td><td></td></tr>
          </tbody></table></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="mg-btn ghost sm" onClick={print}>🖨 הדפסה / PDF</button>
          <button className="mg-btn ghost sm" onClick={csv}>⬇ ייצוא</button>
        </div>
        {rep.lines.some(l => diffOf(l) !== null && Math.abs(diffOf(l)) > 1) && <div className="mg-note warn" style={{ marginTop: 10, fontSize: 14 }}>
          יש הפרש מול רואה החשבון. סיבות נפוצות: הוצאה או חשבונית שלא נרשמו כאן (או נרשמו פעמיים), מסמך בתאריך של תקופה אחרת, שיעור מקדמה שהשתנה, או הוצאה שהוכרה אחרת (רכב, בית). כדאי להשוות את רשימת ההוצאות של התקופה.</div>}
      </div>
      <div className="mg-card">
        <b>מה כתוב בהודעות שלך</b>
        <div style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 10px' }}>עם הנתונים האלה הדוח מחשב בדיוק כמו הרשויות. בלעדיהם הוא מעריך לפי צפי המס.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(200px,100%),1fr))', gap: 10 }}>
          <Field label="שיעור מקדמת מס הכנסה (%)"><input inputMode="decimal" value={prof.advRate?.[tid] ?? ''} placeholder="למשל 5" onChange={e => save({ advRate: { ...(prof.advRate || {}), [tid]: e.target.value } })} /></Field>
          {!isCompanyId(tid) && <Field label="מקדמת ביטוח לאומי לחודש (₪)"><input inputMode="decimal" value={prof.blMonthly?.[tid] ?? ''} placeholder="מהודעת ביטוח לאומי" onChange={e => save({ blMonthly: { ...(prof.blMonthly || {}), [tid]: e.target.value } })} /></Field>}
        </div>
        <div className="mg-note" style={{ marginTop: 10, fontSize: 13 }}>בקרה פנימית בלבד. הסכום לתשלום הוא מה שבהודעות הרשויות ומה שרואה החשבון מגיש. בכל סוף חודש הדוח של התקופה שהסתיימה נשלח גם במייל הארכיון החודשי.</div>
      </div>
    </div>
  );
}

function PnlTab({ totals, supName, book, taxRows, onLoadSiblings }) {
  const y = new Date().getFullYear();
  const [from, setFrom] = useState(`${y}-01`);
  const [to, setTo] = useState(thisMonth());
  const t = totals(from, to);
  const group = (list, key) => {
    const g = {};
    list.forEach(x => { const k = key(x); g[k] = (g[k] || 0) + (x.gross - x.vat); });
    return Object.entries(g).sort((a, b) => b[1] - a[1]);
  };
  const incBy = group(t.inc, i => i.cat || 'אחר');
  const expBy = group(t.exp, e => e.cat || 'אחר');
  const supBy = group(t.exp.filter(e => e.supplierId || e.supplierName), e => supName(e.supplierId) || e.supplierName).slice(0, 8);
  const margin = t.incNet ? Math.round(t.profit / t.incNet * 100) : 0;
  const Line = ({ l, v, strong, color }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0ebe0', fontWeight: strong ? 800 : 400, color }}>
      <span>{l}</span><span dir="ltr">{fmt(v)}</span></div>
  );
  return (
    <>
      {taxRows && <TaxForecast book={book} rows={taxRows} onLoad={onLoadSiblings} />}
      <div data-tour="pnl-range" style={{ ...row, marginBottom: 14 }}>
        <Field label="מחודש"><input type="month" value={from} onChange={e => e.target.value && setFrom(e.target.value)} /></Field>
        <Field label="עד חודש"><input type="month" value={to} onChange={e => e.target.value && setTo(e.target.value)} /></Field>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`pnl-${book.name}-${from}_${to}.csv`, [
          ['דוח רווח והפסד', book.legalName || book.name, `${from} עד ${to}`], [],
          ['הכנסות לפי קטגוריה'], ...incBy.map(([k, v]) => [k, r2(v)]), ['סה״כ הכנסות', r2(t.incNet)], [],
          ['הוצאות לפי קטגוריה'], ...expBy.map(([k, v]) => [k, r2(v)]), ['סה״כ הוצאות', r2(t.expNet)], [],
          ['רווח', r2(t.profit)]
        ])}>⬇ ייצוא</button>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`ledger-${book.name}-${from}_${to}.csv`, [
          ['סוג', 'תאריך', 'תיאור', 'קטגוריה', 'ספק / מקור', 'מסמך', 'אמצעי תשלום', 'לפני מע״מ', 'מע״מ', 'סה״כ'],
          ...t.inc.map(i => ['הכנסה', i.date, i.desc, i.cat, i.src === 'shop' ? 'חנות' : 'ידני', i.docNo, i.pay, r2(i.gross - i.vat), i.vat, i.gross]),
          ...t.exp.map(e => ['הוצאה', e.date, e.desc, e.cat, supName(e.supplierId) || e.supplierName || '', e.docNo, e.pay, r2(e.gross - e.vat), e.vat, e.gross]),
        ])}>⬇ כל התנועות לרואה החשבון</button>
      </div>
      <div data-tour="pnl-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(300px,100%),1fr))', gap: 16 }}>
        <div className="mg-card">
          <h3 style={{ marginTop: 0 }}>תמצית · {monthName(from)} עד {monthName(to)}</h3>
          <Line l="הכנסות (לפני מע״מ)" v={t.incNet} color="var(--green2)" />
          <Line l="הוצאות (לפני מע״מ)" v={-t.expNet} color="#b8641c" />
          <Line l="רווח" v={t.profit} strong color={t.profit < 0 ? 'var(--bad)' : 'var(--green)'} />
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>שיעור רווח: {margin}%</div>
        </div>
        <div className="mg-card">
          <h3 style={{ marginTop: 0 }}>הכנסות לפי קטגוריה</h3>
          {incBy.map(([k, v]) => <Line key={k} l={k} v={v} />)}
          {!incBy.length && <div className="mg-empty">אין הכנסות בטווח.</div>}
        </div>
        <div className="mg-card">
          <h3 style={{ marginTop: 0 }}>הוצאות לפי קטגוריה</h3>
          {expBy.map(([k, v]) => (
            <div key={k} style={{ padding: '6px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>{k}</span><span dir="ltr">{fmt(v)}</span></div>
              <div style={{ height: 6, background: '#f0ebe0', borderRadius: 4, marginTop: 4 }}>
                <div style={{ width: `${t.expNet ? v / t.expNet * 100 : 0}%`, height: '100%', background: '#d9822b', borderRadius: 4 }} /></div>
            </div>
          ))}
          {!expBy.length && <div className="mg-empty">אין הוצאות בטווח.</div>}
        </div>
        {supBy.length > 0 && <div className="mg-card">
          <h3 style={{ marginTop: 0 }}>ספקים מובילים</h3>
          {supBy.map(([k, v]) => <Line key={k} l={k} v={v} />)}
        </div>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- ייבוא */
/* The old ERP (tizon-event) kept everything in one Realtime Database node.
   Copied into this book under ids built from the old ones, so a second run
   skips what is already here. Its amounts never separated VAT. */
function ImportTab({ book, data, cols, flash, onDone, onDeleteBook, onLog, server }) {
  const [old, setOld] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState({ incomes: true, expenses: true, suppliers: true });

  const fetchOld = async () => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(OLD_ERP_URL);
      if (!res.ok) throw new Error(res.status === 401 ? 'המערכת הישנה דורשת הרשאה' : 'שגיאה ' + res.status);
      const d = await res.json();
      if (!d) throw new Error('המערכת הישנה ריקה');
      const arr = (x) => Array.isArray(x) ? x.filter(Boolean) : x && typeof x === 'object' ? Object.values(x) : [];
      setOld({ incomes: arr(d.incomes), expenses: arr(d.expenses), suppliers: arr(d.suppliers), customers: arr(d.customers) });
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const run = async () => {
    setBusy(true);
    const have = new Set([...(data.incomes || []), ...(data.expenses || []), ...(data.suppliers || [])].map(x => x.id));
    const put = async (col, rec) => { try { await withTimeout(col.put(rec.id, clean(rec)), 12000); return 1; } catch { return 0; } };
    let n = 0, skipped = 0;
    if (pick.suppliers) for (const s of old.suppliers) {
      const id = 'erp_sup_' + s.id;
      if (have.has(id)) { skipped++; continue; }
      n += await put(cols.suppliers, { id, name: s.name || '', phone: s.phone || '', email: s.email || '', taxId: '',
                                       cat: 'אחר', notes: s.service || '', review: true, src: 'erp' });
    }
    if (pick.incomes) for (const i of old.incomes) {
      const id = 'erp_inc_' + i.id;
      if (have.has(id)) { skipped++; continue; }
      n += await put(cols.incomes, { id, src: 'erp', date: d10(i.date), desc: i.desc || 'הכנסה מהמערכת הישנה',
                                     cat: 'אחר', pay: i.status || '', gross: r2(i.totalAmount), docNo: '', review: true });
    }
    if (pick.expenses) for (const e of old.expenses) {
      const id = 'erp_exp_' + e.id;
      if (have.has(id)) { skipped++; continue; }
      n += await put(cols.expenses, { id, src: 'erp', date: d10(e.date), desc: e.desc || 'הוצאה מהמערכת הישנה',
                                      cat: EXP_CATS.includes(e.cat) ? e.cat : 'אחר',
                                      ...(e.cat && !EXP_CATS.includes(e.cat) ? { oldCat: e.cat } : {}),
                                      pay: '', gross: r2(e.totalAmount), vat: 0, vatMode: 'none', docNo: '', hasDoc: false, review: true });
    }
    setBusy(false);
    flash(`יובאו ${n} רשומות${skipped ? ` · ${skipped} כבר היו` : ''}`);
    onDone();
  };

  return (
    <>
      <ICountLive book={book} data={data} cols={cols} flash={flash} onDone={onDone} onLog={onLog} server={server} />
      <ICountImport book={book} data={data} cols={cols} flash={flash} onDone={onDone} onLog={onLog} />
      <div data-tour="imp-erp" className="mg-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>ייבוא מה-ERP הישן</h3>
        <p style={{ marginTop: 0 }}>מעתיק לעסק הזה את ההכנסות, ההוצאות והספקים מהמערכת הקודמת (tizon-event). המערכת הישנה לא נפגעת, והרצה חוזרת לא מכפילה.</p>
        {!old && <button className="mg-btn" disabled={busy} onClick={fetchOld}>{busy ? 'קורא…' : 'קרא את המערכת הישנה'}</button>}
        {err && <div className="mg-note bad" style={{ marginTop: 10 }}>לא הצלחתי לקרוא: {err}</div>}
        {old && <>
          <div className="mg-stats" style={{ margin: '12px 0' }}>
            <div className="mg-stat"><div className="lb">הכנסות</div><div className="vl">{old.incomes.length}</div>
              <div className="dl">{fmt(old.incomes.reduce((a, i) => a + (Number(i.totalAmount) || 0), 0))}</div></div>
            <div className="mg-stat"><div className="lb">הוצאות</div><div className="vl">{old.expenses.length}</div>
              <div className="dl">{fmt(old.expenses.reduce((a, i) => a + (Number(i.totalAmount) || 0), 0))}</div></div>
            <div className="mg-stat"><div className="lb">ספקים</div><div className="vl">{old.suppliers.length}</div></div>
            <div className="mg-stat"><div className="lb">לקוחות</div><div className="vl">{old.customers.length}</div><div className="dl">לא מיובאים</div></div>
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            {[['incomes', 'הכנסות'], ['expenses', 'הוצאות'], ['suppliers', 'ספקים']].map(([k, l]) => (
              <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={pick[k]} onChange={e => setPick(p => ({ ...p, [k]: e.target.checked }))} />{l}</label>
            ))}
          </div>
          <div className="mg-note warn" style={{ marginBottom: 12 }}>
            במערכת הישנה הסכומים נשמרו בלי פירוק מע״מ. ההוצאות ייכנסו בלי מע״מ לקיזוז ויסומנו "לבדיקה". פותחים כל אחת ומעדכנים.
            אם חלק מההכנסות הישנות הן מכירות שכבר נמשכות מהחנות, מוחקים אותן כדי שלא ייספרו פעמיים.
          </div>
          <button className="mg-btn" disabled={busy} onClick={run}>{busy ? 'מייבא…' : 'ייבא לעסק הזה'}</button>
        </>}
      </div>
      <div data-tour="imp-danger" className="mg-card" style={{ borderColor: '#f0c9c5' }}>
        <h3 style={{ marginTop: 0, color: 'var(--bad)' }}>מחיקת העסק</h3>
        <p style={{ marginTop: 0 }}>מוחק את הספר ואת כל ההכנסות, ההוצאות, הספקים ושורות הבנק שלו. ההזמנות בחנות לא נפגעות.</p>
        <button className="mg-btn danger" onClick={onDeleteBook}>מחק את העסק</button>
      </div>
    </>
  );
}

/* ================================================================ documents */
/* Phase 1 of issuing documents from Tizon Books itself.

   The rules it keeps, because a tax document is not an ordinary record:
     · every type has its own running number, with no gaps and no repeats —
       the number is taken in the same transaction that writes the document;
     · a document is never edited or deleted once issued. A mistake is put
       right with a credit note (330) that points at it;
     · dates go forward: a document cannot be dated before the last one of
       its type;
     · the first print is the original, every later one says "copy";
     · a book starts in TEST mode — its own "T-" numbers, a watermark on every
       page, and nothing counted as income. REAL mode needs the cloud and an
       explicit tick that the accountant approved it.
   The type codes are the Tax Authority's, for the unified file of phase 2. */
const DOC_TYPES = {
  320: { label: 'חשבונית מס קבלה', short: 'מס קבלה', lines: true, pay: true, vat: true },
  305: { label: 'חשבונית מס', short: 'חשבונית', lines: true, pay: false, vat: true },
  400: { label: 'קבלה', short: 'קבלה', lines: false, pay: true, vat: false },
  330: { label: 'חשבונית זיכוי', short: 'זיכוי', lines: true, pay: false, vat: true, credit: true },
  300: { label: 'חשבון עסקה', short: 'עסקה', lines: true, pay: false, vat: true },
};
const allowedTypes = (book) => book.dealerType === 'exempt' ? ['400', '300'] : ['320', '305', '400', '330', '300'];
/* Invoices with VAT above this, before VAT, to a dealer, need an allocation
   number (from 1.6.2026). Kept in one place because it keeps changing. */
const ALLOC_THRESHOLD = 5000;
/* חוק לצמצום השימוש במזומן: a business may take up to ₪6,000 in cash; above
   that, the lower of ₪6,000 and 10% of the deal. */
const CASH_CAP = 6000;
const cashAllowed = (deal) => deal <= CASH_CAP ? deal : Math.min(CASH_CAP, deal * 0.1);
/* Which real invoices need an allocation number: a tax invoice (305) or tax
   invoice-receipt (320) with VAT, to a dealer (9-digit number), above the
   threshold before VAT. */
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
const needsAlloc = (book, d) => d?.series === 'live' && ['305', '320'].includes(d.type) && rateOf(book) > 0
  && digitsOf(d.customer?.taxId).length === 9 && (Number(d.net) || 0) > ALLOC_THRESHOLD;
/* The request to the Approval API (v2), field names as published. */
function itaPayload(book, d) {
  const soft = lsGet('tzbooks_software', {});
  const rate = Number(d.vatRate) || 0;
  return {
    invoice_id: d.id, invoice_type: Number(d.type), vat_number: Number(digitsOf(book.taxId)),
    user_name: String(d.createdBy || cloud?.auth?.currentUser?.email || '').slice(0, 25),
    invoice_reference_number: String(d.number), customer_vat_number: Number(digitsOf(d.customer?.taxId)),
    customer_name: String(d.customer?.name || '').slice(0, 25), invoice_date: d.date, invoice_issuance_date: todayIso(),
    accounting_software_number: Number(digitsOf(soft.regNo)) || 0,
    amount_before_discount: r2(d.net), discount: 0, payment_amount: r2(d.net), vat_amount: r2(d.vat), payment_amount_including_vat: r2(d.total),
    items_list: (d.lines || []).map((l, i) => {
      const unit = d.incl && rate ? (Number(l.price) || 0) / (1 + rate / 100) : (Number(l.price) || 0);
      const net = r2(unit * (Number(l.qty) || 0));
      return { index: i + 1, description: String(l.desc || '').slice(0, 30), quantity: Number(l.qty) || 0, price_per_unit: r2(unit),
               discount: 0, total_amount: net, vat_rate: rate, vat_amount: r2(net * rate / 100) };
    }),
  };
}
const PAY_KINDS = ['מזומן', 'העברה בנקאית', 'כרטיס אשראי', 'ביט', 'פייבוקס', 'צ׳ק'];
const docSeries = (book) => (cloud && book.docMode === 'live' && book.docApproved) ? 'live' : 'test';
const docNum = (d) => (d.series === 'test' ? 'T-' : '') + d.number;
const isImported = (d) => d?.series === 'import';
const docTitle = (d) => `${DOC_TYPES[d.type]?.label || 'מסמך'} ${docNum(d)}${isImported(d) ? ' (iCount)' : ''}`;

/* Totals of a document from its lines. Prices typed with or without VAT. */
function docTotals(lines, incl, rate) {
  const sum = r2((lines || []).reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
  if (!rate) return { net: sum, vat: 0, total: sum };
  if (incl) { const net = r2(sum / (1 + rate / 100)); return { net, vat: r2(sum - net), total: sum }; }
  const vat = r2(sum * rate / 100); return { net: sum, vat, total: r2(sum + vat) };
}
async function stampOf(d) {
  const core = JSON.stringify([d.type, d.series, d.number, d.date, d.customer?.name, d.customer?.taxId, d.total, d.vat, d.lines, d.payments]);
  try {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(core));
    return [...new Uint8Array(h)].slice(0, 5).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  } catch { return ''; }
}
/* What is still owed on an invoice: its total, less receipts and credit notes
   that point at it. */
function openOf(inv, docs) {
  const paid = docs.filter(d => d.refId === inv.id && d.type === '400').reduce((a, d) => a + d.total + (Number(d.withholding) || 0), 0);
  const cred = docs.filter(d => d.refId === inv.id && d.type === '330').reduce((a, d) => a + d.total, 0);
  return r2(inv.total - paid - cred);
}

/* ------------------------------------------------------------------ print */
function docHTML(book, d, copy) {
  const T = DOC_TYPES[d.type] || {};
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const m = (n) => '₪' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const c = d.customer || {};
  const lines = (d.lines || []).map(l => `<tr><td>${esc(l.desc)}</td><td class="n">${esc(l.qty)}</td><td class="n">${m(l.price)}</td><td class="n">${m((Number(l.qty) || 0) * (Number(l.price) || 0))}</td></tr>`).join('');
  const pays = (d.payments || []).map(p => `<tr><td>${esc(p.kind)}</td><td>${esc(heDate(p.date))}</td><td>${esc(p.details)}</td><td class="n">${m(p.amount)}</td></tr>`).join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(docTitle(d))}</title>
<style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,'Segoe UI',sans-serif;color:#222;margin:0;font-size:13px}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #a8783f;padding-bottom:12px}
.biz b{font-size:20px;display:block;color:#6e4d22}.biz div{color:#555;line-height:1.6}
.logo{max-height:80px;max-width:200px}
h1{font-size:24px;margin:18px 0 4px;color:#222}.copy{display:inline-block;border:2px solid #a8783f;color:#a8783f;padding:2px 10px;border-radius:6px;font-weight:700;margin-inline-start:10px;font-size:14px}
.meta{display:flex;justify-content:space-between;gap:20px;margin:14px 0;background:#faf6ee;padding:12px 14px;border-radius:8px}
.meta div{line-height:1.7}.lb{color:#777;font-size:12px}
table{width:100%;border-collapse:collapse;margin:10px 0}th{background:#f1e8d6;text-align:right;padding:8px;font-size:12px}td{padding:8px;border-bottom:1px solid #eee}
.n{text-align:left;white-space:nowrap}
.tot{width:280px;margin-inline-start:auto}.tot div{display:flex;justify-content:space-between;padding:5px 0}.tot .g{font-size:17px;font-weight:800;border-top:2px solid #222;margin-top:4px;padding-top:8px}
.ref,.notes{margin:10px 0;padding:8px 12px;background:#faf6ee;border-radius:6px}
.foot{margin-top:28px;border-top:1px solid #ddd;padding-top:8px;color:#888;font-size:11px;display:flex;justify-content:space-between}
.sign{margin-top:36px;width:220px;border-top:1px solid #444;padding-top:4px;text-align:center;color:#555}
.wm{position:fixed;top:40%;left:0;right:0;text-align:center;transform:rotate(-24deg);font-size:54px;font-weight:800;color:rgba(200,40,40,.13);pointer-events:none}
</style></head><body>
${d.series === 'test' ? '<div class="wm">מסמך ניסיון · לא לצורכי מס</div>' : ''}
<div class="top"><div class="biz"><b>${esc(book.legalName || book.name)}</b>
<div>${esc(DEALERS[book.dealerType] || '')} ${esc(book.taxId || '')}</div>
<div>${esc(book.address || '')}</div><div>${esc([book.phone, book.email].filter(Boolean).join(' · '))}</div></div>
${book.logo ? `<img class="logo" src="${book.logo}">` : ''}</div>
<h1>${esc(T.label)} מס׳ ${esc(docNum(d))}<span class="copy">${copy ? 'העתק נאמן למקור' : 'מקור'}</span></h1>
<div class="meta"><div><span class="lb">לכבוד</span><br><b>${esc(c.name)}</b>${c.taxId ? `<br>ח.פ./ת.ז. ${esc(c.taxId)}` : ''}${c.address ? `<br>${esc(c.address)}` : ''}${c.phone ? `<br>${esc(c.phone)}` : ''}</div>
<div><span class="lb">תאריך</span><br><b>${esc(heDate(d.date))}</b>${d.allocationNo ? `<br><span class="lb">מספר הקצאה</span><br><b>${esc(String(d.allocationNo).slice(-9))}</b>` : ''}</div></div>
${d.refId ? `<div class="ref">${d.type === '330' ? 'זיכוי בגין' : 'תשלום עבור'} ${esc(d.refTitle || '')}</div>` : ''}
${T.lines ? `<table><thead><tr><th>תיאור</th><th class="n">כמות</th><th class="n">מחיר ליחידה</th><th class="n">סה״כ</th></tr></thead><tbody>${lines}</tbody></table>
<div class="tot">${d.vatRate ? `<div><span>${d.incl ? 'סה״כ לפני מע״מ' : 'סה״כ'}</span><span>${m(d.net)}</span></div><div><span>מע״מ ${d.vatRate}%</span><span>${m(d.vat)}</span></div>` : ''}
<div class="g"><span>${d.type === '330' ? 'סה״כ זיכוי' : 'סה״כ לתשלום'}</span><span>${m(d.total)}</span></div></div>` : ''}
${T.pay && pays ? `<h3 style="margin:18px 0 0;font-size:15px">פרטי התשלום</h3><table><thead><tr><th>אמצעי</th><th>תאריך</th><th>פרטים</th><th class="n">סכום</th></tr></thead><tbody>${pays}</tbody></table>
${d.withholding ? `<div class="tot"><div><span>ניכוי במקור</span><span>${m(d.withholding)}</span></div></div>` : ''}
${!T.lines ? `<div class="tot"><div class="g"><span>סה״כ התקבל</span><span>${m(d.total)}</span></div></div>` : ''}` : ''}
${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ''}
<div class="sign">חתימה</div>
<div class="foot">${isImported(d) ? `<span>העתק של מסמך שהופק במקור ב-iCount · הודפס מ-Tizon Books ${VERSION} · ${esc(new Date().toLocaleString('he-IL'))}</span><span></span>`
  : `<span>הופק ב-Tizon Books ${VERSION} · ${esc(new Date(d.createdAt).toLocaleString('he-IL'))}</span><span>קוד אימות ${esc(d.stamp || '')}</span>`}</div>
</body></html>`;
}
/* Printed from a hidden frame — no pop-up to be blocked. "Save as PDF" is
   the same dialog. */
function printHTML(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch {} setTimeout(() => f.remove(), 60000); }, 450);
}
const waPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1); return d; };

/* ------------------------------------------------------------ the list */
/* Right after issuing: what the customer gets, in one place. */
function IssuedPanel({ d, book, busy, canShareFiles, canMail, onShare, onMail, onPrint, onPdf, onAnother, onClose }) {
  const [to, setTo] = useState(d.customer?.email || '');
  const [sent, setSent] = useState('');
  return (
    <Box title="המסמך הופק" onClose={onClose}
         footer={<><button className="mg-btn" onClick={onAnother}>＋ מסמך נוסף</button><button className="mg-btn ghost" onClick={onClose}>סגור</button></>}>
      <div data-tour="doc-issued">
        <div style={{ textAlign: 'center', margin: '4px 0 16px' }}>
          <div style={{ fontSize: 44, lineHeight: 1, color: 'var(--green2)', fontWeight: 800 }}>✓</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{docTitle(d)}</div>
          <div style={{ fontSize: 16, marginTop: 2 }}>{d.customer?.name} · <b>{fmt(d.total)}</b>{d.series === 'test' ? ' · ניסיון' : ''}</div>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <button className="mg-btn" style={{ padding: '14px', fontSize: 17 }} disabled={busy} onClick={() => onShare(d)}>
            {busy ? 'מכין PDF…' : canShareFiles ? '📲 שלח ללקוח (וואטסאפ ועוד)' : '📲 וואטסאפ + שמירת PDF'}</button>
          {canMail && <div style={{ display: 'flex', gap: 8 }}>
            <input dir="ltr" type="email" inputMode="email" value={to} onChange={e => setTo(e.target.value)} placeholder="אימייל הלקוח" style={{ flex: 1 }} />
            <button className="mg-btn ghost" disabled={busy || !to.trim()} onClick={async () => { if (await onMail(d, to.trim())) setSent(to.trim()); }}>✉️ שלח חתום</button>
          </div>}
          {sent && <div style={{ color: 'var(--green)', fontWeight: 700, fontSize: 14 }}>✓ נשלח ל-{sent}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="mg-btn ghost" style={{ flex: 1 }} onClick={() => onPrint(d)}>🖨 הדפס</button>
            <button className="mg-btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => onPdf(d)}>⬇ PDF</button>
          </div>
        </div>
      </div>
    </Box>
  );
}

function DocsTab({ quick = null, book, docs, customers = [], items = [], onIssue, onPrinted, onSent, onLog, server, ro, flash, ita, onRequestAlloc, onManualAlloc,
                  payreqs = [], payOk = null, onPayCreated, onPayCancel, onPayRefresh, onSetup, icount = null, onPayReplace = null }) {
  const [busyId, setBusyId] = useState('');
  const [payForm, setPayForm] = useState(false);
  const [form, setForm] = useState(null);
  const [done, setDone] = useState(null);
  const [month, setMonth] = useState('');
  const [type, setType] = useState('');
  const [src, setSrc] = useState('');
  const series = docSeries(book);
  /* The quick button at the top of the business opens a new document here at once. */
  useEffect(() => {
    if (!quick || ro) return;
    if (quick.pay) { setPayForm(true); return; }
    if (allowedTypes(book).length) setForm({ type: quick.type && allowedTypes(book).includes(quick.type) ? quick.type : allowedTypes(book)[0] });
  }, [quick]);
  const hasImp = docs.some(isImported);
  const list = docs.filter(d => (!month || d.date.startsWith(month)) && (!type || d.type === type)
                              && (!src || (src === 'import' ? isImported(d) : !isImported(d))))
    /* Newest first: by the document's date, then by its number. */
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || ((Number(b.number) || 0) - (Number(a.number) || 0)) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const openInv = docs.filter(d => d.type === '305' && d.series === series && openOf(d, docs) > 0.009);

  /* One original only: a second quick click, or a print whose count did not save yet, prints a copy. */
  const printedNow = useRef(new Set());
  const isCopy = (d) => { const c = (d.printCount || 0) > 0 || printedNow.current.has(d.id); printedNow.current.add(d.id); return c; };
  const print = async (d) => { printHTML(docHTML(book, d, isCopy(d))); onPrinted(d); };
  const canSign = !!(cloud && server?.sign);
  const canMail = !!(cloud && server?.sign && server?.mail);
  /* A PDF: signed when the certificate is set up, plain otherwise. */
  /* The document as a PDF: signed when the certificate is set up. */
  const makePdf = async (d) => {
    const raw = await docPDF(book, d, isCopy(d));
    let bytes = new Uint8Array(raw);
    if (canSign) {
      const r = await fnCall({ action: 'doc', pdf: b64(raw), title: docTitle(d), business: book.legalName || book.name, businessEmail: book.email || '' });
      bytes = unb64(r.pdf);
    }
    onLog({ action: canSign ? 'sign' : 'pdf', docId: d.id, title: docTitle(d), series: d.series });
    onPrinted(d, true);
    return bytes;
  };
  const pdf = async (d) => {
    setBusyId(d.id);
    try { saveBytes(pdfName(d), await makePdf(d), 'application/pdf'); }
    catch (e) { flash('הפקת ה-PDF נכשלה · ' + (e.message || '')); }
    setBusyId('');
  };
  /* On a phone: the PDF itself goes to WhatsApp (or anywhere) through the share sheet.
     Where files cannot be shared, the PDF is saved and WhatsApp opens with the message. */
  const shareMsg = (d) => `שלום ${d.customer?.name || ''},\nמצורפת ${docTitle(d)} על סך ${fmt(d.total)}.\nתודה, ${book.legalName || book.name}`;
  const share = async (d) => {
    setBusyId(d.id);
    try {
      const bytes = await makePdf(d);
      const file = new File([bytes], pdfName(d), { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: docTitle(d), text: shareMsg(d) }).catch(e => { if (e?.name !== 'AbortError') throw e; });
      } else {
        saveBytes(pdfName(d), bytes, 'application/pdf');
        if (d.customer?.phone) window.open(`https://wa.me/${waPhone(d.customer.phone)}?text=${encodeURIComponent(shareMsg(d) + '\n(ה-PDF נשמר במחשב: גרור אותו לשיחה)')}`, '_blank');
        else flash('ה-PDF נשמר. אפשר לצרף אותו לכל שיחה.');
      }
      onSent(d, 'share');
    } catch (e) { flash('השיתוף נכשל · ' + (e.message || '')); }
    setBusyId('');
  };
  const canShareFiles = typeof navigator !== 'undefined' && !!navigator.canShare && (() => { try { return navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); } catch { return false; } })();
  const sendSigned = async (d, toIn) => {
    const to = toIn || window.prompt('לאיזה אימייל לשלוח?', d.customer?.email || '');
    if (!to) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) { flash('כתובת האימייל לא תקינה'); return false; }
    setBusyId(d.id);
    try {
      const raw = await docPDF(book, d, (d.printCount || 0) > 0);
      await fnCall({ action: 'doc', pdf: b64(raw), to, replyTo: book.email || '', filename: pdfName(d),
        title: docTitle(d), business: book.legalName || book.name, businessEmail: book.email || '',
        subject: `${docTitle(d)} · ${book.legalName || book.name}`,
        text: `שלום ${d.customer?.name || ''},\n\nמצורפת ${docTitle(d)} על סך ${fmt(d.total)}, חתומה דיגיטלית.\n\nתודה,\n${book.legalName || book.name}` });
      onSent(d, to);
      flash(`${docTitle(d)} נשלחה חתומה ל-${to}`);
      setBusyId(''); return true;
    } catch (e) {
      flash(e.message === 'no-cert' ? 'אין תעודת חתימה מוגדרת בשרת' : e.message === 'no-mail' ? 'שליחת מייל לא מוגדרת בשרת' : 'השליחה נכשלה · ' + (e.message || ''));
    }
    setBusyId(''); return false;
  };
  const send = (d, how) => {
    const text = `שלום ${d.customer?.name || ''},\nמצורפת ${docTitle(d)} על סך ${fmt(d.total)}.\nתודה, ${book.legalName || book.name}`;
    if (how === 'wa') window.open(`https://wa.me/${waPhone(d.customer?.phone)}?text=${encodeURIComponent(text)}`, '_blank');
    else window.location.href = `mailto:${d.customer?.email || ''}?subject=${encodeURIComponent(docTitle(d))}&body=${encodeURIComponent(text + '\n\n(המסמך מצורף כ-PDF)')}`;
  };

  const [lim, more] = useLimit([month, type, src]);
  return (
    <>
      {series === 'test'
        ? <div data-tour="docs-mode" className="mg-note warn" style={{ marginBottom: 12 }}>
            <b>מצב ניסיון.</b> המסמכים מקבלים מספרי T-, עליהם מודפס "מסמך ניסיון · לא לצורכי מס", והם לא נספרים כהכנסה.
            {!cloud ? ' מצב אמיתי אפשרי רק כשהמערכת מחוברת לענן.' : ' מעבר למצב אמיתי: הגדרות העסק ← מסמכים.'}</div>
        : <div data-tour="docs-mode" className="mg-note" style={{ marginBottom: 12 }}><b>מצב אמיתי.</b> המסמכים הם מסמכי מס, נספרים כהכנסה ואי אפשר למחוק או לערוך אותם.</div>}
      <div data-tour="docs-new" style={{ ...row, marginBottom: 12 }}>
        {allowedTypes(book).map(t => (
          <button key={t} className={'mg-btn' + (t === allowedTypes(book)[0] ? '' : ' ghost')} onClick={() => setForm({ type: t })}>＋ {DOC_TYPES[t].label}</button>
        ))}
        {(payOk?.zcredit || payOk?.upay) && !ro && <button data-tour="docs-paynew" className="mg-btn" style={{ background: '#1f4e79' }} onClick={() => setPayForm(true)}>💳 דף סליקה</button>}
      </div>
      {icount && <div data-tour="docs-icount" className={'mg-note' + (icount.err ? ' bad' : '')} style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
        <span style={{ flex: 1, minWidth: 180 }}>🔗 <b>iCount</b> · {icount.busy ? 'מושך מסמכים…' : icount.err ? icount.err : icount.msg ? icount.msg : icount.at ? `עודכן ${new Date(icount.at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'עוד לא נמשך'}</span>
        <button className="mg-btn sm keep" disabled={icount.busy} onClick={icount.sync}>{icount.busy ? '…' : '↻ משוך מ-iCount'}</button>
      </div>}
      <PayList book={book} list={payreqs} onCancel={onPayCancel} onRefresh={onPayRefresh} flash={flash} ro={ro} onEdit={onPayReplace && (payOk?.zcredit || payOk?.upay) ? (p) => setPayForm({ preset: p }) : null} />
      {payOk && (payOk.zcredit || payOk.upay) && !payreqs.length && !ro && <div className="mg-note" style={{ marginBottom: 12, fontSize: 14 }}>💳 דפי סליקה מוכנים. "דף סליקה" למעלה שולח ללקוח קישור לתשלום בכרטיס, ואחרי התשלום מופקת לו חשבונית לבד.</div>}
      {onSetup && !ro && cloud && !(payOk && (payOk.zcredit || payOk.upay)) && <div className="mg-note" style={{ marginBottom: 12, fontSize: 14 }}>💳 רוצה לשלוח ללקוח קישור לתשלום בכרטיס, עם חשבונית אוטומטית? <button className="mg-linkish" onClick={onSetup}>הגדרת דפי סליקה (זד קרדיט או יופיי)</button></div>}
      <div data-tour="docs-filters" style={{ ...row, marginBottom: 12 }}>
        <Field label="חודש"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
        <Field label="סוג"><select value={type} onChange={e => setType(e.target.value)}>
          <option value="">הכול</option>{allowedTypes(book).map(t => <option key={t} value={t}>{DOC_TYPES[t].label}</option>)}</select></Field>
        {hasImp && <Field label="מקור"><select value={src} onChange={e => setSrc(e.target.value)}>
          <option value="">הכול</option><option value="own">Tizon Books</option><option value="import">iCount</option></select></Field>}
        {openInv.length > 0 && <div className="mg-note" style={{ alignSelf: 'center' }}>
          {openInv.length} חשבוניות פתוחות בסך {fmt(openInv.reduce((a, d) => a + openOf(d, docs), 0))}</div>}
      </div>
      <div data-tour="docs-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>מסמך</th><th>תאריך</th><th>לקוח</th><th>סה״כ</th><th>מצב</th><th></th></tr></thead>
        <tbody>
          {list.slice(0, lim).map(d => {
            const open = d.type === '305' ? openOf(d, docs) : 0;
            const credited = docs.some(x => x.refId === d.id && x.type === '330');
            return (
              <tr key={d.id}>
                <td><b>{DOC_TYPES[d.type]?.label}</b> <span dir="ltr">{docNum(d)}</span>{d.series === 'test' && <span className="mg-chip warn" style={{ marginInlineStart: 6 }}>ניסיון</span>}
                  {isImported(d) && <span className="mg-chip" style={{ marginInlineStart: 6 }}>iCount</span>}
                  {d.cancelled && <span className="mg-chip bad" style={{ marginInlineStart: 6 }}>מבוטל</span>}
                  {d.allocationNo && <span className="mg-chip ok" style={{ marginInlineStart: 6 }} title={d.allocationNo}>הקצאה {String(d.allocationNo).slice(-9)}</span>}
                  {needsAlloc(book, d) && !d.allocationNo && <span className="mg-chip bad" style={{ marginInlineStart: 6 }}>חסר מספר הקצאה</span>}</td>
                <td>{heDate(d.date)}</td>
                <td>{d.customer?.name}</td>
                <td><b>{d.type === '330' ? '‎-' : ''}{fmt(d.total)}</b></td>
                <td>{isImported(d) ? <span className="mg-chip">היסטוריה</span>
                  : credited ? <span className="mg-chip bad">זוכתה</span>
                  : d.type === '305' ? (open > 0.009 ? <span className="mg-chip warn">פתוחה · {fmt(open)}</span> : <span className="mg-chip ok">שולמה</span>)
                  : <span className="mg-chip ok">הופק</span>}
                  {(d.printCount || 0) > 0 && !isImported(d) && <span className="mg-chip" style={{ marginInlineStart: 4 }}>הודפס</span>}</td>
                <td>{isImported(d) ? <><button className="mg-btn ghost sm keep" onClick={() => printHTML(docHTML(book, d, true))}>🖨 העתק</button>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>המקור הופק ב-iCount</div></> :
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <button className="mg-btn ghost sm keep" onClick={() => print(d)}>🖨 {(d.printCount || 0) > 0 ? 'העתק' : 'הדפס'}</button>
                  <button className="mg-btn ghost sm keep" disabled={busyId === d.id} onClick={() => pdf(d)}>{busyId === d.id ? '…' : canSign ? 'PDF חתום' : 'PDF'}</button>
                  {canMail && <button className="mg-btn ghost sm" disabled={busyId === d.id} onClick={() => sendSigned(d)}>✉ שלח חתום</button>}
                  {d.sentTo && <span className="mg-chip ok" title={d.sentAt}>נשלח</span>}
                  {needsAlloc(book, d) && !d.allocationNo && <>
                    {ita?.connected && <button className="mg-btn sm" disabled={busyId === d.id}
                      onClick={async () => { setBusyId(d.id); await onRequestAlloc(d); setBusyId(''); }}>בקש מספר הקצאה</button>}
                    <button className="mg-btn ghost sm" onClick={() => { const n = window.prompt('מספר ההקצאה שהתקבל מרשות המסים:'); if (n && n.trim()) onManualAlloc(d, n.trim()); }}>הזן הקצאה</button></>}
                  {canShareFiles ? <button className="mg-btn ghost sm" disabled={busyId === d.id} onClick={() => share(d)}>📲 שתף</button>
                    : d.customer?.phone && <button className="mg-btn ghost sm" onClick={() => send(d, 'wa')}>וואטסאפ</button>}
                  {d.customer?.email && <button className="mg-btn ghost sm" onClick={() => send(d, 'mail')}>מייל</button>}
                  {d.type === '305' && d.series === series && open > 0.009 && <button className="mg-btn ghost sm" onClick={() => setForm({ type: '400', ref: d })}>קבלה</button>}
                  {['305', '320'].includes(d.type) && d.series === series && !credited && book.dealerType !== 'exempt' &&
                    <button className="mg-btn ghost sm" onClick={() => setForm({ type: '330', ref: d })}>זיכוי</button>}
                </div>}</td>
              </tr>
            );
          })}
          {!list.length && <tr><td colSpan={6}><div className="mg-empty">עוד לא הופקו מסמכים.</div></td></tr>}
          <ShowMore n={lim} total={list.length} onMore={more} cols={9} />
        </tbody>
      </table></div>
      <div className="mg-note" style={{ marginTop: 12 }}>
        {canMail ? 'שליחה חתומה: "שלח חתום" מייצר PDF, חותם עליו בתעודה הדיגיטלית ושולח במייל.'
          : canSign ? 'PDF חתום מוכן. לשליחה במייל ישירות מכאן, צריך להגדיר בשרת גם שליחת מייל.'
          : 'חשבונית שנשלחת דיגיטלית צריכה חתימה אלקטרונית מאובטחת. עד שתוגדר תעודה: מדפיסים ומוסרים ביד, או שולחים PDF רק למטרות ניסיון.'}
        {' '}מסמך שהופק לא נמחק ולא נערך; טעות מתקנים בחשבונית זיכוי.
      </div>
      {payForm && <PayForm book={book} payOk={payOk} docs={docs} customers={customers} items={items} flash={flash} preset={payForm.preset || null}
                           onCreated={(r, c) => { onPayCreated(r, c); if (payForm.preset) onPayReplace(payForm.preset, r); }} onClose={() => setPayForm(false)} />}
      {form && <DocForm book={book} docs={docs} customers={customers} items={items} preset={form} itaReady={!!ita?.connected} series={series} onClose={() => setForm(null)}
                        onIssue={async (rec) => { const d = await onIssue(rec); if (d) { setForm(null); setDone(d); } return d; }} />}
      {done && <IssuedPanel d={docs.find(x => x.id === done.id) || done} book={book} busy={busyId === done.id} canShareFiles={canShareFiles} canMail={canMail}
                            onShare={share} onMail={sendSigned} onPrint={print} onPdf={pdf}
                            onAnother={() => { const t = done.type; setDone(null); setForm({ type: t === '400' || t === '330' ? allowedTypes(book)[0] : t }); }}
                            onClose={() => setDone(null)} />}
    </>
  );
}

/* ------------------------------------------------------------ issuing */
/* A search box with its own list, for choosing a customer or an item by any
   part of the name, a phone, an email, an id or a code. Works the same on a
   phone (big rows, no browser datalist) and with thousands of entries: only
   the best few are shown. Typing freely is always allowed. */
const searchNorm = (v) => normName(v).replace(/[םןץףך]/g, ch => HEB_FINAL[ch]);
function searchRank(hay, q) {
  if (!q) return 0;
  const words = q.split(' ').filter(Boolean); let score = 0;
  for (const w of words) {
    const d = w.replace(/\D/g, '');
    let best = 0;
    for (const h of hay) {
      if (!h) continue;
      if (h === w) best = Math.max(best, 5);
      else if (h.startsWith(w)) best = Math.max(best, 4);
      else if (h.includes(' ' + w)) best = Math.max(best, 3);
      else if (h.includes(w)) best = Math.max(best, 2);
      else if (d.length >= 3 && h.replace(/\D/g, '').includes(d)) best = Math.max(best, 2);
    }
    if (!best) return -1;
    score += best;
  }
  return score;
}
function SearchPick({ value, onType, options, onPick, placeholder, disabled, renderSub, max = 8, autoFocus, emptyHint, inputProps = {} }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const q = searchNorm(value);
  const shown = useMemo(() => {
    if (!open) return [];
    if (!q) return options.slice(0, max);
    const r = [];
    for (const o of options) { const sc = searchRank(o.hay, q); if (sc >= 0) r.push([sc, o]); }
    return r.sort((a, b) => b[0] - a[0] || (b[1].rank || 0) - (a[1].rank || 0)).slice(0, max).map(x => x[1]);
  }, [open, q, options, max]);
  useEffect(() => setHi(0), [q]);
  const pick = (o) => { onPick(o); setOpen(false); };
  return (
    <div className="tz-pick" style={{ position: 'relative' }}>
      <input value={value} disabled={disabled} placeholder={placeholder} autoFocus={autoFocus} autoComplete="off" {...inputProps}
             onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 180)}
             onChange={e => { onType(e.target.value); setOpen(true); }}
             onKeyDown={e => {
               if (!shown.length) return;
               if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, shown.length - 1)); }
               else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
               else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hi]); }
               else if (e.key === 'Escape') setOpen(false);
             }} />
      {value && !disabled && <button type="button" className="tz-pick-x" aria-label="נקה" onMouseDown={e => e.preventDefault()} onClick={() => { onType(''); setOpen(true); }}>×</button>}
      {open && (shown.length > 0 || (q && emptyHint)) && (
        <div className="tz-pick-list" role="listbox">
          {shown.map((o, i) => (
            <div key={o.key} role="option" aria-selected={i === hi} className={'tz-pick-row' + (i === hi ? ' on' : '')}
                 onMouseDown={e => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setHi(i)}>
              <div className="t">{o.label}</div>{renderSub && <div className="s">{renderSub(o)}</div>}
            </div>))}
          {!shown.length && <div className="tz-pick-row empty">{emptyHint}</div>}
        </div>)}
    </div>
  );
}

function DocForm({ book, docs, customers = [], items = [], preset, series, onIssue, onClose, itaReady = false }) {
  const rate = rateOf(book);
  const ref = preset.ref || null;
  const [type, setType] = useState(preset.type);
  const T = DOC_TYPES[type];
  /* A credit note follows the invoice it credits, even if the rate changed since. */
  const vatRate = !T.vat ? 0 : (type === '330' && ref && ref.vatRate !== undefined ? Number(ref.vatRate) || 0 : rate);
  /* One id for this document however many times issuing is tried: a retry after a timeout finds it issued. */
  const docId = useRef(uid('doc'));
  const [date, setDate] = useState(todayIso());
  const [cust, setCust] = useState(() => ref ? { ...ref.customer } : { name: '', taxId: '', address: '', phone: '', email: '' });
  const [incl, setIncl] = useState(ref ? !!ref.incl : true);
  const [lines, setLines] = useState(() => ref && type === '330' ? ref.lines.map(l => ({ ...l })) : [{ desc: '', qty: 1, price: '' }]);
  const tot = T.lines ? docTotals(lines, incl, vatRate) : null;
  const refOpen = ref && type === '400' ? openOf(ref, docs) : 0;
  const [pays, setPays] = useState(() => [{ kind: 'העברה בנקאית', amount: ref && type === '400' ? refOpen : '', date: todayIso(), details: '' }]);
  const paySum = r2(pays.reduce((a, p) => a + (Number(p.amount) || 0), 0));
  const [alloc, setAlloc] = useState('');
  const [wh, setWh] = useState('');
  const whAmt = r2(Number(wh) || 0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /* Customers to search: the customer list, and anyone issued to before who
     is not on it. The most recently served come first. */
  const custOpts = useMemo(() => {
    const last = {}; docs.forEach(d => { const k = normName(d.customer?.name); if (k && (d.date || '') > (last[k] || '')) last[k] = d.date; });
    const out = []; const idx = custIndex([]);
    customers.filter(c => c.name).forEach(c => { out.push({ key: c.id, label: c.name, c,
      val: { name: c.name, taxId: c.taxId || '', address: [c.address, c.city].filter(Boolean).join(', '), phone: c.phone || '', email: c.email || '' } }); idx.add(c); });
    const seen = new Set();
    docs.forEach(d => { const c = d.customer; const k = normName(c?.name);
      if (!k || seen.has(k)) return; seen.add(k); if (idx.find(c).length) return;
      out.push({ key: 'doc:' + k, label: c.name, c, val: { name: c.name, taxId: c.taxId || '', address: c.address || '', phone: c.phone || '', email: c.email || '' } }); });
    out.forEach(o => { o.hay = custIdents(o.c).flatMap(x => [searchNorm(x.name), String(x.phone || '').replace(/\D/g, ''), normEmail(x.email), String(x.taxId || '').replace(/\D/g, '')]);
      o.rank = Math.max(...custIdents(o.c).map(x => Number(String(last[normName(x.name)] || '').replace(/\D/g, '')) || 0)); });
    return out.sort((a, b) => b.rank - a.rank);
  }, [docs, customers]);
  const [picked, setPicked] = useState(false);
  /* Picking a customer fills their details; typing past one clears them, so
     one customer's tax id never ends up on another's document. */
  const typeName = (name) => {
    /* A name typed in full that belongs to exactly one customer counts as picking them. */
    const n = searchNorm(name), hit = n ? custOpts.filter(o => searchNorm(o.label) === n) : [];
    if (hit.length === 1) { setCust({ ...hit[0].val, name }); setPicked(true); return; }
    setCust(c => picked ? { name, taxId: '', address: '', phone: '', email: '' } : { ...c, name }); setPicked(false);
  };
  const pickCust = (o) => { setCust({ ...o.val }); setPicked(true); };

  const total = T.lines ? tot.total : paySum;
  const needAlloc = ['305', '320'].includes(type) && vatRate > 0 && digitsOf(cust.taxId).length === 9 && (tot?.net || 0) > ALLOC_THRESHOLD;
  const lastDate = docs.filter(d => d.type === type && d.series === series).map(d => d.date).sort().pop() || '';

  useEffect(() => { if (T.pay && T.lines && pays.length === 1) setPays(p => [{ ...p[0], amount: r2((tot.total || 0) - whAmt) || '' }]); }, [tot?.total, type, whAmt]);

  const problems = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push('חסר תאריך');
  if (ref && ref.series !== series) problems.push(ref.series === 'test' ? 'זה מסמך ניסיון: אי אפשר להפיק עליו קבלה או זיכוי אמיתיים' : 'אי אפשר להפיק מסמך ניסיון על מסמך אמיתי');
  if (!String(cust.name).trim()) problems.push('חסר שם לקוח');
  if (T.lines && !lines.some(l => String(l.desc).trim() && Number(l.qty) && Number(l.price))) problems.push('צריך לפחות שורה אחת עם תיאור, כמות ומחיר');
  if (total <= 0) problems.push('הסכום צריך להיות גדול מאפס');
  if (T.pay && T.lines && Math.abs(paySum + whAmt - tot.total) > 0.009) problems.push(`התשלומים${whAmt ? ' והניכוי במקור' : ''} (${fmt(paySum + whAmt)}) שונים מסה״כ המסמך (${fmt(tot.total)})`);
  if (type === '400' && ref && paySum + whAmt - refOpen > 0.009) problems.push(`הקבלה גבוהה מהיתרה הפתוחה (${fmt(refOpen)})`);
  if (type === '330' && ref && total - ref.total > 0.009) problems.push('הזיכוי גבוה מהחשבונית המקורית');
  if (lastDate && date < lastDate) problems.push(`התאריך מוקדם מהמסמך האחרון מסוג זה (${heDate(lastDate)})`);
  if (needAlloc && series === 'live' && !alloc.trim() && !itaReady) problems.push('חסר מספר הקצאה');
  /* Cash: counted against the whole deal — the invoice a receipt pays, or
     this document itself. */
  /* Including cash already taken on earlier receipts for the same invoice. */
  const cashBefore = ref && type === '400' ? r2(docs.filter(d => d.type === '400' && d.refId === ref.id && !d.cancelled)
    .reduce((a, d) => a + (d.payments || []).filter(p => p.kind === 'מזומן').reduce((x, p) => x + (Number(p.amount) || 0), 0), 0)) : 0;
  const cash = r2(cashBefore + pays.filter(p => p.kind === 'מזומן').reduce((a, p) => a + (Number(p.amount) || 0), 0));
  const dealValue = ref && type === '400' ? ref.total : total;
  const cashMax = r2(cashAllowed(dealValue));
  const cashOver = T.pay && cash > cashMax + 0.009;
  if (cashOver && series === 'live') problems.push(`מזומן ${fmt(cash)} מעל המותר בעסקה של ${fmt(dealValue)} (עד ${fmt(cashMax)}, לפי החוק לצמצום השימוש במזומן)`);

  const issue = async () => {
    if (!window.confirm(`להפיק ${T.label} על סך ${fmt(total)} ל${cust.name}?\nאחרי ההפקה אי אפשר לערוך או למחוק את המסמך.`)) return;
    setBusy(true); setErr('');
    const cleanLines = T.lines ? lines.filter(l => String(l.desc).trim()).map(l => clean({ desc: String(l.desc).trim(), qty: Number(l.qty) || 0, price: r2(l.price),
                                                                                        ...(l.itemId ? { itemId: l.itemId, sku: l.sku || '' } : {}) })) : [];
    const rec = {
      id: docId.current, type, series, date, customer: { ...cust, name: String(cust.name).trim() },
      lines: cleanLines, incl: T.lines ? incl : false, vatRate: T.lines ? vatRate : 0,
      net: T.lines ? tot.net : paySum, vat: T.lines ? tot.vat : 0, total: r2(total),
      payments: T.pay ? pays.filter(p => Number(p.amount)).map(p => ({ ...p, amount: r2(p.amount) })) : [],
      allocationNo: alloc.trim(), notes: notes.trim(), withholding: T.pay ? whAmt : 0,
      createdBy: cloud?.auth?.currentUser?.email || '',
      refId: ref?.id || '', refTitle: ref ? docTitle(ref) : '',
      printCount: 0, createdAt: new Date().toISOString(),
    };
    try { await onIssue(rec); } catch (e) { setErr('ההפקה נכשלה · ' + (e?.code || e?.message || '')); }
    setBusy(false);
  };

  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [k]: v } : l));
  /* Picking an item fills its price, converted to this document's VAT setting. */
  const activeItems = items.filter(x => x.active !== false);
  const itemOpts = useMemo(() => {
    const used = {}; docs.forEach(d => (d.lines || []).forEach(l => { if (l.itemId) used[l.itemId] = (used[l.itemId] || 0) + 1; }));
    return activeItems.map(it => ({ key: it.id, label: it.name, it, rank: used[it.id] || 0,
      hay: [searchNorm(it.name), searchNorm(it.sku), searchNorm(it.cat || it.category), searchNorm(it.desc)] })).sort((a, b) => b.rank - a.rank);
  }, [items, docs]);
  const typeItem = (i, v) => {
    const n = searchNorm(v), hit = n ? itemOpts.filter(o => searchNorm(o.label) === n) : [];
    if (hit.length === 1) return pickItem(i, hit[0]);
    setLines(ls => ls.map((l, j) => j !== i ? l : { ...l, desc: v, itemId: '', sku: '' }));
  };
  const pickItem = (i, o) => setLines(ls => ls.map((l, j) => j !== i ? l : { ...l, desc: o.it.name, price: itemPrice(o.it, incl, vatRate), itemId: o.it.id, sku: o.it.sku || '' }));
  /* The quick way: search once, tap, and the item is on the document (again = one more). */
  const [quickQ, setQuickQ] = useState('');
  const addItem = (o) => {
    setLines(ls => {
      const j = ls.findIndex(l => l.itemId === o.it.id);
      if (j >= 0) return ls.map((l, k) => k === j ? { ...l, qty: (Number(l.qty) || 0) + 1 } : l);
      const row = { desc: o.it.name, qty: 1, price: itemPrice(o.it, incl, vatRate), itemId: o.it.id, sku: o.it.sku || '' };
      const blank = ls.findIndex(l => !String(l.desc).trim() && !Number(l.price));
      return blank >= 0 ? ls.map((l, k) => k === blank ? row : l) : [...ls, row];
    });
    setQuickQ('');
  };
  const setPay = (i, k, v) => setPays(ps => ps.map((p, j) => j === i ? { ...p, [k]: v } : p));

  return (
    <Box title={`${T.label}${series === 'test' ? ' · ניסיון' : ''}`} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={busy || problems.length > 0} onClick={issue}>{busy ? 'מפיק…' : 'הפק מסמך'}</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      {ref && <div className="mg-note" style={{ marginBottom: 12 }}>{type === '330' ? 'זיכוי בגין' : 'תשלום עבור'} <b>{docTitle(ref)}</b> · {fmt(ref.total)}{type === '400' ? ` · יתרה ${fmt(refOpen)}` : ''}</div>}
      <div style={grid}>
        {!ref && <Field label="סוג מסמך"><select value={type} onChange={e => setType(e.target.value)}>
          {allowedTypes(book).filter(t => t !== '330').map(t => <option key={t} value={t}>{DOC_TYPES[t].label}</option>)}</select></Field>}
        <Field label="תאריך"><input type="date" value={date} min={lastDate || undefined} onChange={e => setDate(e.target.value)} /></Field>
        <div data-tour="doc-cust" style={{ gridColumn: '1 / -1' }}><Field label="לקוח · חיפוש לפי שם, טלפון, אימייל או ח.פ.">
          <SearchPick value={cust.name} onType={typeName} onPick={pickCust} options={custOpts} disabled={!!ref} autoFocus={!ref}
                      placeholder="הקלד שם או טלפון…" emptyHint="לקוח חדש: המשך להקליד את השם ומלא את הפרטים למטה"
                      renderSub={o => [o.val.phone, o.val.email, o.val.taxId && 'ח.פ. ' + o.val.taxId, o.val.address].filter(Boolean).join(' · ') || (o.key.startsWith('doc:') ? 'ממסמך קודם' : '')} />
        </Field>{picked && <div style={{ fontSize: 13, color: 'var(--green)', marginTop: 4 }}>✓ לקוח קיים · הפרטים מולאו</div>}</div>
        <Field label="ח.פ. / ת.ז."><input dir="ltr" value={cust.taxId || ''} onChange={e => setCust(c => ({ ...c, taxId: e.target.value }))} disabled={!!ref} /></Field>
        <Field label="כתובת"><input value={cust.address || ''} onChange={e => setCust(c => ({ ...c, address: e.target.value }))} disabled={!!ref} /></Field>
        <Field label="טלפון"><input dir="ltr" value={cust.phone || ''} onChange={e => setCust(c => ({ ...c, phone: e.target.value }))} /></Field>
        <Field label="אימייל"><input dir="ltr" value={cust.email || ''} onChange={e => setCust(c => ({ ...c, email: e.target.value }))} /></Field>
      </div>

      {T.lines && <>
        <h4 style={{ margin: '16px 0 6px' }}>פריטים</h4>
        {itemOpts.length > 0 && <div data-tour="doc-items" style={{ marginBottom: 10 }}><Field label="הוספת פריט · חיפוש לפי שם או קוד">
          <SearchPick value={quickQ} onType={setQuickQ} onPick={addItem} options={itemOpts} placeholder="הקלד כדי לחפש פריט…" max={10}
                      emptyHint="לא נמצא פריט. אפשר לכתוב תיאור חופשי בשורה למטה."
                      renderSub={o => [fmt(itemPrice(o.it, incl, vatRate)), o.it.sku, o.rank ? `נמכר ${o.rank} פעמים` : ''].filter(Boolean).join(' · ')} />
        </Field></div>}
        <div className="mg-tblwrap" style={{ overflow: 'visible' }}><table className="mg-tbl">
          <thead><tr><th>תיאור</th><th style={{ width: 80 }}>כמות</th><th style={{ width: 120 }}>מחיר ליחידה</th><th style={{ width: 100 }}>סה״כ</th><th style={{ width: 40 }}></th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><SearchPick value={l.desc} onType={v => typeItem(i, v)} onPick={o => pickItem(i, o)} options={itemOpts} max={6}
                              placeholder={itemOpts.length ? 'פריט או תיאור חופשי' : 'טיפול דיקור'} renderSub={o => fmt(itemPrice(o.it, incl, vatRate))} /></td>
              <td><input inputMode="decimal" value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} /></td>
              <td><input inputMode="decimal" value={l.price} onChange={e => setLine(i, 'price', e.target.value)} /></td>
              <td>{fmt((Number(l.qty) || 0) * (Number(l.price) || 0))}</td>
              <td>{lines.length > 1 && <button className="mg-btn ghost sm" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>×</button>}</td>
            </tr>))}
          </tbody></table></div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <button className="mg-btn ghost sm" onClick={() => setLines(ls => [...ls, { desc: '', qty: 1, price: '' }])}>＋ שורה</button>
          {vatRate > 0 && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={incl} onChange={e => setIncl(e.target.checked)} />המחירים כוללים מע״מ</label>}
        </div>
        <div className="mg-note" style={{ marginTop: 10 }}>
          {vatRate > 0 && <>לפני מע״מ <b>{fmt(tot.net)}</b> · מע״מ {vatRate}% <b>{fmt(tot.vat)}</b> · </>}סה״כ <b>{fmt(tot.total)}</b></div>
      </>}

      {T.pay && <>
        <h4 style={{ margin: '16px 0 6px' }}>תשלומים</h4>
        {pays.map((p, i) => (
          <div key={i} style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit,minmax(min(130px,100%),1fr))', marginBottom: 8 }}>
            <Field label="אמצעי"><select value={p.kind} onChange={e => setPay(i, 'kind', e.target.value)}>{PAY_KINDS.map(k => <option key={k}>{k}</option>)}</select></Field>
            <Field label="סכום"><input inputMode="decimal" value={p.amount} onChange={e => setPay(i, 'amount', e.target.value)} /></Field>
            <Field label="תאריך"><input type="date" value={p.date} onChange={e => setPay(i, 'date', e.target.value)} /></Field>
            <Field label={p.kind === 'צ׳ק' ? 'בנק · סניף · חשבון · מס׳ צ׳ק' : p.kind === 'כרטיס אשראי' ? '4 ספרות · תשלומים' : 'אסמכתא'}>
              <input value={p.details} onChange={e => setPay(i, 'details', e.target.value)} /></Field>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="mg-btn ghost sm" onClick={() => setPays(ps => [...ps, { kind: 'מזומן', amount: '', date: todayIso(), details: '' }])}>＋ אמצעי תשלום</button>
          <span style={{ fontSize: 14 }}>סה״כ תשלומים: <b>{fmt(paySum)}</b></span>
        </div>
        <div style={{ marginTop: 10, maxWidth: 260 }}><Field label="ניכוי במקור (אם הלקוח ניכה)"><input inputMode="decimal" value={wh} onChange={e => setWh(e.target.value)} placeholder="0" /></Field></div>
      </>}

      {needAlloc && (
        <div className="mg-note warn" style={{ marginTop: 14 }}>
          חשבונית מעל {fmt(ALLOC_THRESHOLD)} לפני מע״מ ללקוח עם ח.פ. צריכה <b>מספר הקצאה</b> מרשות המסים.
          {itaReady ? ' העסק מחובר: המספר יתבקש אוטומטית מיד אחרי ההפקה. אפשר גם להזין כאן מספר שכבר התקבל.' : ' מקבלים אותו באזור האישי ("חשבוניות ישראל") ומזינים כאן.'}
          <div style={{ marginTop: 8 }}><Field label="מספר הקצאה"><input dir="ltr" value={alloc} onChange={e => setAlloc(e.target.value)} /></Field></div>
        </div>
      )}
      <div style={{ marginTop: 12 }}><Field label="הערות שיודפסו במסמך"><input value={notes} onChange={e => setNotes(e.target.value)} /></Field></div>
      {cashOver && series === 'test' && <div className="mg-note warn" style={{ marginTop: 12 }}>
        מזומן {fmt(cash)} מעל המותר בעסקה של {fmt(dealValue)} (עד {fmt(cashMax)}). במצב אמיתי המסמך הזה ייחסם.</div>}
      {problems.length > 0 && <div className="mg-note warn" style={{ marginTop: 12 }}>{problems.map((p, i) => <div key={i}>• {p}</div>)}</div>}
      {err && <div className="mg-note bad" style={{ marginTop: 12 }}>{err}</div>}
    </Box>
  );
}

/* ================================================================ server */
/* The signing and sending function (netlify/functions/books-mail.mjs). It
   exists only when the site is deployed with its functions, so every screen
   asks first and hides what is not there. */
const FN = '/.netlify/functions/books-mail';
async function fnStatus() {
  try { const r = await withTimeout(fetch(FN + '?action=status'), 8000); if (!r.ok) return null;
        const j = await r.json(); return j && j.ok ? j : null; } catch { return null; }
}
async function fnCall(body) {
  if (!cloud?.auth?.currentUser) throw new Error('צריך להיות מחובר לענן');
  const idToken = await cloud.auth.currentUser.getIdToken();
  const r = await fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, idToken }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { body: j });
  return j;
}
const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
function saveBytes(name, bytes, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/* A real PDF of a document, drawn from the same page that is printed. The
   libraries load only when a PDF is asked for. */
async function docPDF(book, d, copy) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;background:#fff';
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(docHTML(book, d, copy)); f.contentDocument.close();
  await new Promise(r => setTimeout(r, 500));
  const body = f.contentDocument.body;
  body.style.cssText += ';padding:44px;width:794px;background:#fff';
  const canvas = await html2canvas(body, { scale: 2, backgroundColor: '#ffffff', windowWidth: 794, useCORS: true });
  f.remove();
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
  const per = Math.floor(canvas.width * H / W);
  for (let off = 0, page = 0; off < canvas.height; off += per, page++) {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = Math.min(per, canvas.height - off);
    c.getContext('2d').drawImage(canvas, 0, off, c.width, c.height, 0, 0, c.width, c.height);
    if (page) pdf.addPage();
    pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, c.height * W / c.width);
  }
  pdf.setProperties({ title: docTitle(d), creator: 'Tizon Books ' + VERSION, author: book.legalName || book.name });
  return pdf.output('arraybuffer');
}
const PDF_SLUG = { 320: 'tax-invoice-receipt', 305: 'tax-invoice', 400: 'receipt', 330: 'credit-note', 300: 'deal-invoice' };
const pdfName = (d) => `${PDF_SLUG[d.type] || 'document'}-${docNum(d)}.pdf`;

/* ============================================================ the log */
/* What was done, by whom, when. Written once and never changed. */
async function logAct(bookId, entry) {
  const rec = clean({ id: uid('log'), at: new Date().toISOString(), user: cloud?.auth?.currentUser?.email || 'local', ...entry });
  try { await DB.put(`books/${bookId}/log`, rec.id, rec); } catch {}
  return rec;
}

/* ======================================================= unified format */
/* The Tax Authority's unified file (הוראה 1.31): INI.TXT and BKMVDATA.TXT,
   fixed-width records, ISO-8859-8, lines ending CR LF, in
   OPENFRMT/<8 digits>.<yy>/<MMDDhhmm>/. Documents only (C100, D110, D120):
   this software issues documents; it does not keep a double-entry ledger. */
const OF_CONST = '&OF1.31&';
const SOFT_KEY = 'tzbooks_software';
/* Hebrew punctuation that ISO-8859-8 lacks, as its nearest ASCII. */
const PUNCT = { 0x5F3: 39, 0x5F4: 34, 0x2013: 45, 0x2014: 45, 0x2018: 39, 0x2019: 39, 0x201C: 34, 0x201D: 34, 0x200E: null, 0x200F: null, 0xA0: 32, 0x20AA: 32 };
const enc8859 = (s) => { const out = []; for (const ch of s) { const c = ch.codePointAt(0);
  const v = c < 128 ? c : (c >= 0x5D0 && c <= 0x5EA) ? c - 0x5D0 + 0xE0 : (c in PUNCT ? PUNCT[c] : 63); if (v !== null) out.push(v); } return out; };
const fX = (v, n) => { const s = [...String(v ?? '').replace(/[\u200E\u200F]/g, '').replace(/[\r\n]+/g, ' ')].slice(0, n).join(''); return s + ' '.repeat(n - [...s].length); };
const fN = (v, n) => { const s = String(v ?? '').replace(/\D/g, '').slice(-n); return s.padStart(n, '0'); };
const fS = (v, int, dec) => { const x = Math.round(Math.abs(Number(v) || 0) * 10 ** dec); return ((Number(v) || 0) < 0 ? '-' : '+') + String(x).padStart(int + dec, '0').slice(-(int + dec)); };
const ymd = (d) => String(d || '').replace(/-/g, '').slice(0, 8);
const PAY_CODE = { 'מזומן': 1, 'צ׳ק': 2, 'כרטיס אשראי': 3, 'העברה בנקאית': 4, 'ביט': 9, 'פייבוקס': 9 };

/* ---------------------------------------------------- the journal (B100/B110)
   A double-entry journal built from what the books already hold:
     invoice      Dr customer            Cr income, Cr output VAT
     credit note  the same, reversed
     receipt      Dr cash/bank/cards…    (Dr withholding)   Cr customer
     other income Dr bank                Cr income, Cr output VAT
     expense      Dr expense, Dr input VAT                  Cr the account it was paid from
   Every entry balances; the account list carries each account's totals. */
const PAY_ACC = { 'מזומן': '1010', 'העברה בנקאית': '1020', 'הוראת קבע': '1020', 'כרטיס אשראי': '1030', 'צ׳ק': '1040', 'ביט': '1050', 'פייבוקס': '1050' };
function buildJournal(book, ownDocs, ledger, from, to) {
  const inRange = (d) => d && d >= from && d <= to;
  const acc = {};
  const A = (key, name, tb, tbName, extra = {}) => (acc[key] = acc[key] || { key, name, tb, tbName, dr: 0, cr: 0, ...extra });
  A('1010', 'קופה - מזומן', '100', 'רכוש שוטף'); A('1020', 'בנק', '100', 'רכוש שוטף'); A('1030', 'חברות כרטיסי אשראי', '100', 'רכוש שוטף');
  A('1040', 'שיקים לגבייה', '100', 'רכוש שוטף'); A('1050', 'ארנקים דיגיטליים', '100', 'רכוש שוטף'); A('1100', 'לקוחות', '100', 'רכוש שוטף');
  A('1410', 'מע״מ תשומות', '100', 'רכוש שוטף'); A('1500', 'ניכוי במקור מלקוחות', '100', 'רכוש שוטף'); A('2210', 'מע״מ עסקאות', '200', 'התחייבויות שוטפות');
  A('4000', 'הכנסות חייבות', '400', 'הכנסות'); A('4100', 'הכנסות פטורות', '400', 'הכנסות');
  const custKey = (c) => { const t = digitsOf(c?.taxId); const k = t || normName(c?.name).replace(/\s/g, '').slice(0, 12) || 'X'; return ('C' + k).slice(0, 15); };
  const cust = (c) => A(custKey(c), String(c?.name || 'לקוח').slice(0, 50), '100', 'רכוש שוטף',
    { parent: '1100', street: c?.address || '', osek: digitsOf(c?.taxId).length === 9 ? digitsOf(c.taxId) : '' }).key;
  const expCats = {};
  const expAcc = (cat) => { const c = cat || 'אחר'; if (!expCats[c]) expCats[c] = '6' + String(100 + Object.keys(expCats).length).padStart(3, '0'); return A(expCats[c], c, '600', 'הוצאות').key; };
  const tx = []; let n = 0;
  const entry = (date, ref, refType, desc, lines) => {
    n++; lines.filter(l => Math.abs(l.amt) > 0.004).forEach((l, i) => {
      const side = l.amt >= 0 ? l.side : (l.side === 1 ? 2 : 1);
      const amt = r2(Math.abs(l.amt));
      if (side === 1) acc[l.acc].dr += amt; else acc[l.acc].cr += amt;
      tx.push({ n, line: i + 1, date, ref: String(ref || ''), refType: refType || 0, desc: String(desc || '').slice(0, 50), acc: l.acc, side, amt });
    });
  };
  const ownIds = new Set();
  ownDocs.filter(d => d.series === 'live' && !d.cancelled && inRange(d.date)).forEach(d => {
    ownIds.add(d.id);
    const sign = d.type === '330' ? -1 : 1, num = docNum(d);
    if (['305', '320', '330'].includes(d.type) || (d.type === '400' && book.dealerType === 'exempt' && !d.refId)) {
      const c = cust(d.customer);
      entry(d.date, num, Number(d.type), `${DOC_TYPES[d.type]?.label} ${num} ${d.customer?.name || ''}`, [
        { acc: c, side: 1, amt: sign * d.total },
        { acc: d.vat ? '4000' : '4100', side: 2, amt: sign * (d.total - d.vat) },
        { acc: '2210', side: 2, amt: sign * d.vat },
      ]);
    }
    if (['320', '400'].includes(d.type) && (d.payments || []).length) {
      const c = cust(d.customer);
      const got = d.payments.map(p => ({ acc: PAY_ACC[p.kind] || '1020', side: 1, amt: Number(p.amount) || 0 }));
      const wh = Number(d.withholding) || 0;
      entry(d.date, docNum(d), Number(d.type), `תקבול ${docNum(d)} ${d.customer?.name || ''}`,
        [...got, { acc: '1500', side: 1, amt: wh }, { acc: c, side: 2, amt: got.reduce((a, x) => a + x.amt, 0) + wh }]);
    }
  });
  ledger.income.filter(i => inRange(i.date) && !(i.src === 'doc' && ownIds.has(String(i.id).slice(2)))).forEach(i => {
    entry(i.date, i.docNo || '', 0, i.desc, [
      { acc: '1020', side: 1, amt: i.gross },
      { acc: i.vat ? '4000' : '4100', side: 2, amt: i.gross - i.vat },
      { acc: '2210', side: 2, amt: i.vat },
    ]);
  });
  ledger.outgo.filter(e => inRange(e.date)).forEach(e => {
    entry(e.date, e.docNo || '', 0, `${e.desc || ''} ${e.supplierName || ''}`.trim(), [
      { acc: expAcc(e.cat), side: 1, amt: e.gross - e.vat },
      { acc: '1410', side: 1, amt: e.vat },
      { acc: PAY_ACC[e.pay] || '1020', side: 2, amt: e.gross },
    ]);
  });
  return { tx, accounts: Object.values(acc).filter(a => a.dr || a.cr || !a.parent) };
}

function buildUnified(book, docs, soft, from, to, opts = {}) {
  const osek = fN(book.taxId, 9);
  const mainId = String(Math.floor(1e14 + Math.random() * 9e14)).slice(0, 15);
  const now = new Date();
  const recs = []; const counts = {};
  const push = (code, body) => { recs.push(code + fN(recs.length + 1, 9) + body); counts[code] = (counts[code] || 0) + 1; };
  push('A100', osek + mainId + OF_CONST + fX('', 50));
  const journal = opts.ledger ? buildJournal(book, docs, opts.ledger, from, to) : null;
  if (journal) {
    const entered = ymd(now.toISOString());
    journal.tx.forEach(t => push('B100', osek + fN(t.n, 10) + fN(t.line, 5) + fN(0, 8) + fX('', 15) + fX(t.ref, 20) + fN(t.refType, 3)
      + fX('', 20) + fN(0, 3) + fX(t.desc, 50) + fN(ymd(t.date), 8) + fN(ymd(t.date), 8) + fX(t.acc, 15) + fX('', 15) + String(t.side)
      + fX('', 3) + fS(t.amt, 12, 2) + fS(0, 12, 2) + fX('', 12) + fX('', 10) + fX('', 10) + fX('', 7) + fN(entered, 8) + fX('', 9) + fX('', 25)));
    journal.accounts.forEach(a => push('B110', osek + fX(a.key, 15) + fX(a.name, 50) + fX(a.tb, 15) + fX(a.tbName, 30) + fX(a.street || '', 50)
      + fX('', 10) + fX('', 30) + fX('', 8) + fX('', 30) + fX('', 2) + fX(a.parent || '', 15) + fS(0, 12, 2) + fS(a.dr, 12, 2) + fS(a.cr, 12, 2)
      + fN(0, 4) + fN(a.osek || 0, 9) + fX('', 7) + fS(0, 12, 2) + fX('', 3) + fX('', 16)));
  }
  const sorted = [...docs].sort((a, b) => (a.date + a.type + String(a.number).padStart(9, '0')).localeCompare(b.date + b.type + String(b.number).padStart(9, '0')));
  const byType = {};
  sorted.forEach(d => {
    const sign = d.type === '330' ? -1 : 1;
    const num = docNum(d), c = d.customer || {};
    const custOsek = String(c.taxId || '').replace(/\D/g, '').length === 9 ? c.taxId : '';
    const custKey = (String(c.taxId || '').replace(/\D/g, '') || c.name || '').slice(0, 15);
    const ct = new Date(d.createdAt || Date.now());
    const time = pad(ct.getHours()) + pad(ct.getMinutes());
    const head = recs.length + 1;
    push('C100', osek + fN(d.type, 3) + fX(num, 20) + fN(ymd(d.date), 8) + fN(time, 4) + fX(c.name, 50) + fX(c.address, 50) + fX('', 10)
      + fX('', 30) + fX('', 8) + fX('', 30) + fX('', 2) + fX(c.phone, 15) + fN(custOsek, 9) + fN(ymd(d.date), 8)
      + fS(0, 12, 2) + fX('', 3) + fS(sign * d.net, 12, 2) + fS(0, 12, 2) + fS(sign * d.net, 12, 2) + fS(sign * d.vat, 12, 2)
      + fS(sign * d.total, 12, 2) + fS(d.withholding || 0, 9, 2) + fX(custKey, 15) + fX('', 10) + fX('', 1) + fN(ymd(d.date), 8)
      + fX('', 7) + fX((d.createdBy || '').split('@')[0], 9) + fN(0, 7) + fX('', 13));
    const ref = d.refId ? docs.find(x => x.id === d.refId) : null;
    (d.lines || []).forEach((l, i) => {
      const unit = d.incl && d.vatRate ? (Number(l.price) || 0) / (1 + d.vatRate / 100) : (Number(l.price) || 0);
      push('D110', osek + fN(d.type, 3) + fX(num, 20) + fN(i + 1, 4) + fN(ref ? ref.type : 0, 3) + fX(ref ? docNum(ref) : '', 20)
        + '1' + fX('', 20) + fX(l.desc, 30) + fX('', 50) + fX('', 30) + fX('יחידה', 20) + fS(l.qty, 12, 4) + fS(unit, 12, 2)
        + fS(0, 12, 2) + fS(sign * unit * (Number(l.qty) || 0), 12, 2) + fN(Math.round((d.vatRate || 0) * 100), 4) + fX('', 7)
        + fN(ymd(d.date), 8) + fN(head, 7) + fX('', 7) + fX('', 21));
    });
    (d.payments || []).forEach((p, i) => {
      const k = PAY_CODE[p.kind] || 9;
      const parts = k === 2 ? String(p.details || '').split(/\D+/).filter(Boolean) : [];
      push('D120', osek + fN(d.type, 3) + fX(num, 20) + fN(i + 1, 4) + String(k) + fN(parts[0], 10) + fN(parts[1], 10) + fN(parts[2], 15)
        + fN(parts[3], 10) + fN(k === 2 || k === 3 ? ymd(p.date) : '', 8) + fS(p.amount, 12, 2) + fN(0, 1) + fX(k === 3 ? p.details : '', 20)
        + fN(k === 3 ? 1 : 0, 1) + fX('', 7) + fN(ymd(d.date), 8) + fN(head, 7) + fX('', 60));
    });
    const t = byType[d.type] = byType[d.type] || { count: 0, total: 0 };
    t.count++; t.total += sign * d.total;
  });
  const total = recs.length + 1;
  push('Z900', osek + mainId + OF_CONST + fN(total, 15) + fX('', 50));

  const yy = String(now.getFullYear()).slice(2);
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const dir = `OPENFRMT/${osek.slice(0, 8)}.${yy}/${stamp}`;
  const addr = String(book.address || '');
  const street = addr.split(',')[0] || '', city = addr.split(',').slice(1).join(',').trim();
  const ini = ['A000' + fX('', 5) + fN(total, 15) + osek + mainId + OF_CONST + fN(soft.regNo, 8) + fX('Tizon Books', 20) + fX(VERSION, 20)
    + fN(soft.makerId, 9) + fX(soft.makerName || 'Tizon Health', 20) + '2' + fX(dir.replace(/\//g, '\\'), 50) + (journal ? '2' : '0') + (journal ? '1' : '0')
    + fN(0, 9) + fN(0, 9) + fX('', 10) + fX(book.legalName || book.name, 50) + fX(street, 50) + fX('', 10) + fX(city, 30) + fX('', 8)
    + fN(0, 4) + fN(ymd(from), 8) + fN(ymd(to), 8) + fN(ymd(now.toISOString()), 8) + stamp.slice(4) + '0' + '1' + fX('', 20)
    + fX('ILS', 3) + '0' + fX('', 46)];
  ['B100', 'B110', 'C100', 'D110', 'D120'].forEach(code => { if (counts[code]) ini.push(code + fN(counts[code], 15)); });
  const bytes = (lines) => new Uint8Array(enc8859(lines.join('\r\n') + '\r\n'));
  return { dir, ini: bytes(ini), data: bytes(recs), counts: { ...counts, total }, byType, journal, lengths: { A000: ini[0].length } , recs, iniLines: ini };
}

/* ---------------------------------------------------- monthly archive */
/* Last month, kept apart from everything else: every business's unified
   files (documents and journal) and a full backup, in one zip. Emailed to
   the owner on the first visit of each month when the server can send mail;
   otherwise offered for download. */
const ARCH_KEY = 'tzbooks_archive';
async function makeArchive(books, month, email) {
  const { zipSync, strToU8 } = await import('fflate');
  const soft = lsGet(SOFT_KEY, {});
  const from = month + '-01', to = month + '-31';
  const files = {}; const lines = [];
  for (const b of books) {
    const d = await loadBook(b);
    const docs = (d.documents || []).filter(x => x.series === 'live' && x.date >= from && x.date <= to);
    const safe = String(b.name || b.id).replace(/[\\/:*?"<>|]/g, '_');
    if (digitsOf(b.taxId).length === 9) {
      const u = buildUnified(b, docs, soft, from, to, { ledger: buildLedger(b, d) });
      files[`${safe}/${u.dir}/INI.TXT`] = u.ini; files[`${safe}/${u.dir}/BKMVDATA.TXT`] = u.data;
      lines.push(`${b.name}: ${docs.length} מסמכים, ${u.counts.total} רשומות`);
    } else lines.push(`${b.name}: אין מספר עוסק, רק גיבוי`);
  }
  /* Payments to the authorities for the period that ended with this month. */
  try {
    const prof = lsGet(TAX_PROFILE_KEY, {}) || {};
    const groups = {};
    for (const b of books) { const k = digitsOf(b.taxId) || b.id; (groups[k] = groups[k] || []).push(b); }
    for (const [tid, bs] of Object.entries(groups)) {
      const freq = prof.freq?.[tid] || 'bi', p = periodOf(freq, month);
      if (p.end !== month) continue;                   // a bi-monthly period ends every second month
      const rows = []; for (const b of bs) rows.push({ book: b, data: await loadBook(b) });
      const r = authReport(rows, p, prof, tid);
      lines.push('', `לתשלום לרשויות · ${periodLabel(p)} · ${bs.map(b => b.name).join(', ')} (${tid}) · עד ${dueOf(p)}:`,
        ...r.lines.map(l => `  ${l.label}: ${fmt(l.amount)}${l.est ? ' (הערכה)' : ''}`), `  סה״כ: ${fmt(r.total)}`);
    }
  } catch (e) { console.warn('pay report', e); }
  const backup = await exportAll(email);
  backup.books = backup.books.filter(x => books.some(b => b.id === x.id));
  files['backup.json'] = strToU8(JSON.stringify(backup));
  files['README.txt'] = strToU8(`Tizon Books ${VERSION} · ארכיון ${month}\r\n\r\n${lines.join('\r\n')}\r\n`);
  return { zip: zipSync(files), lines };
}

/* ------------------------------------------------------ the export tab
   Everything out, the way every accounting program offers it: one Excel
   workbook with a sheet per list, the unified file, a package for the
   accountant, and CSV of any single list. Nothing here writes anywhere. */
const EXP_RANGES = [['month', 'החודש'], ['prev', 'חודש קודם'], ['bi', 'דו-חודש קודם'], ['quarter', 'רבעון קודם'], ['year', 'השנה'], ['lastyear', 'שנה שעברה'], ['all', 'הכול'], ['custom', 'טווח אחר']];
function expRange(k) {
  const m = thisMonth(), y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
  const end = (mm) => { const [a, b] = mm.split('-').map(Number); return `${mm}-${pad(new Date(a, b, 0).getDate())}`; };
  if (k === 'month') return [m + '-01', todayIso()];
  if (k === 'prev') { const p = addMonths(m, -1); return [p + '-01', end(p)]; }
  if (k === 'bi') { const e = addMonths(m, mo % 2 ? -1 : -2); return [addMonths(e, -1) + '-01', end(e)]; }
  if (k === 'quarter') { const e = addMonths(m, -(((mo - 1) % 3) + 1)); return [addMonths(e, -2) + '-01', end(e)]; }
  if (k === 'year') return [`${y}-01-01`, todayIso()];
  if (k === 'lastyear') return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  if (k === 'all') return ['2000-01-01', '2099-12-31'];
  return null;
}
const SERIES_LABEL = { live: 'אמיתי', import: 'iCount', test: 'ניסיון' };
/* Every sheet as rows (first row the headings), for Excel and for CSV alike. */
function exportSheets(book, data, ledger, from, to, withTest) {
  const inR = (d) => { const x = String(d || '').slice(0, 10); return x >= from && x <= to; };
  const supName = (id) => (data.suppliers || []).find(s => s.id === id)?.name || '';
  const docs = (data.documents || []).filter(d => inR(d.date) && (d.series !== 'test' || withTest))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  const inc = ledger.income.filter(i => inR(i.date)).slice().reverse();
  const out = ledger.outgo.filter(e => inR(e.date)).slice().reverse();
  const S = {};
  S.docs = { name: 'מסמכים', rows: [['תאריך', 'סוג', 'מספר', 'סדרה', 'לקוח', 'ח.פ. / ת.ז.', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'ניכוי במקור', 'אמצעי תשלום', 'בגין', 'מספר הקצאה', 'מבוטל'],
    ...docs.map(d => [d.date, DOC_TYPES[d.type]?.label || d.type, docNum(d), SERIES_LABEL[d.series] || d.series || '', d.customer?.name || '', d.customer?.taxId || '',
      r2(d.net ?? (d.total - (d.vat || 0))), r2(d.vat || 0), r2(d.total), r2(d.withholding || 0) || '', (d.payments || []).map(p => p.kind).join(', '), d.refTitle || '',
      d.allocationNo || '', d.cancelled ? 'כן' : ''])] };
  S.lines = { name: 'שורות מסמכים', rows: [['תאריך', 'סוג', 'מספר', 'לקוח', 'תיאור', 'כמות', 'מחיר', 'מחיר כולל מע״מ', 'סה״כ שורה'],
    ...docs.flatMap(d => (d.lines || []).map(l => [d.date, DOC_TYPES[d.type]?.short || d.type, docNum(d), d.customer?.name || '', l.desc || '', Number(l.qty) || 0,
      Number(l.price) || 0, d.incl ? 'כן' : 'לא', r2((Number(l.qty) || 0) * (Number(l.price) || 0))]))] };
  S.pays = { name: 'תקבולים', rows: [['תאריך מסמך', 'מסמך', 'לקוח', 'אמצעי', 'תאריך פירעון', 'פרטים', 'סכום'],
    ...docs.flatMap(d => (d.payments || []).map(p => [d.date, `${DOC_TYPES[d.type]?.short || ''} ${docNum(d)}`, d.customer?.name || '', p.kind || '', p.date || '', p.details || '', r2(p.amount)]))] };
  S.income = { name: 'הכנסות', rows: [['תאריך', 'תיאור', 'לקוח', 'קטגוריה', 'אמצעי תשלום', 'מסמך', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'מקור'],
    ...inc.map(i => [i.date, i.desc || '', i.customer || '', i.cat || '', i.pay || '', i.docNo || '', r2(i.gross - i.vat), r2(i.vat), r2(i.gross),
      i.src === 'shop' ? 'חנות' : i.src === 'doc' ? 'מסמך' : 'ידני'])] };
  S.expenses = { name: 'הוצאות', rows: [['תאריך', 'ספק', 'ח.פ. ספק', 'תיאור', 'קטגוריה', 'אמצעי תשלום', 'מסמך', 'לפני מע״מ', 'מע״מ מוכר', 'סה״כ', 'הערכה'],
    ...out.map(e => { const s = (data.suppliers || []).find(x => x.id === e.supplierId); return [e.date, s?.name || e.supplierName || '', s?.taxId || '', e.desc || '', e.cat || '',
      e.pay || '', e.docNo || '', r2(e.gross - e.vat), r2(e.vat), r2(e.gross), e.estimate ? 'כן' : '']; })] };
  /* VAT and profit month by month. */
  const months = [...new Set([...inc, ...out].map(x => String(x.date || '').slice(0, 7)).filter(Boolean))].sort();
  const vrows = months.map(m => { const t = totals(ledger, m, m); return [m, r2(t.incNet), r2(t.incVat), r2(t.expNet), r2(t.expVat), r2(t.vatDue), r2(t.profit)]; });
  const sum = (i) => r2(vrows.reduce((a, r) => a + r[i], 0));
  S.vat = { name: 'מע״מ ורווח לפי חודש', rows: [['חודש', 'עסקאות לפני מע״מ', 'מע״מ עסקאות', 'הוצאות לפני מע״מ', 'מע״מ תשומות', 'מע״מ לתשלום', 'רווח'],
    ...vrows, ...(vrows.length ? [['סה״כ', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6)]] : [])] };
  const j = buildJournal(book, data.documents || [], ledger, from, to);
  const accName = Object.fromEntries(j.accounts.map(a => [a.key, a.name]));
  S.journal = { name: 'פקודות יומן', rows: [['פקודה', 'שורה', 'תאריך', 'אסמכתא', 'פרטים', 'חשבון', 'שם חשבון', 'חובה', 'זכות'],
    ...j.tx.map(t => [t.n, t.line, t.date, t.ref, t.desc, t.acc, accName[t.acc] || '', t.side === 1 ? t.amt : '', t.side === 2 ? t.amt : ''])] };
  const tbr = j.accounts.map(a => [a.key, a.name, a.tbName, r2(a.dr), r2(a.cr), r2(a.dr - a.cr)]).filter(r => r[3] || r[4]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  S.tb = { name: 'מאזן בוחן', rows: [['חשבון', 'שם', 'קבוצה', 'חובה', 'זכות', 'יתרה'], ...tbr,
    ['', 'סה״כ', '', r2(tbr.reduce((a, r) => a + r[3], 0)), r2(tbr.reduce((a, r) => a + r[4], 0)), r2(tbr.reduce((a, r) => a + r[5], 0))]] };
  S.customers = { name: 'לקוחות', rows: [CUST_FIELDS.map(k => CUST_LABELS[k]), ...(data.customers || []).filter(c => !c.mergedInto)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he')).map(c => CUST_FIELDS.map(k => c[k] || ''))] };
  S.suppliers = { name: 'ספקים', rows: [['שם', 'ח.פ. / ע.מ.', 'טלפון', 'אימייל', 'קטגוריה', 'סה״כ בתקופה'],
    ...(data.suppliers || []).map(s => [s.name || '', s.taxId || '', s.phone || '', s.email || '', s.cat || '', r2(out.filter(e => e.supplierId === s.id).reduce((a, e) => a + e.gross, 0))])] };
  S.items = { name: 'פריטים', rows: [['שם הפריט', 'מק״ט', 'מחיר', 'כולל מע״מ', 'יחידה', 'קטגוריה', 'תיאור נוסף', 'פעיל'],
    ...(data.items || []).map(x => [x.name || '', x.sku || '', Number(x.price) || 0, x.incl ? 'כן' : 'לא', x.unit || '', x.category || '', x.desc || '', x.active === false ? 'לא' : 'כן'])] };
  S.bank = { name: 'בנק', rows: [['תאריך', 'תיאור', 'סכום', 'אסמכתא', 'הותאם', 'הוסתר'],
    ...(data.banktx || []).filter(b => inR(b.date)).sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(b => [b.date, b.desc || '', Number(b.amount) || 0, b.ref || '', b.matchId ? 'כן' : '', b.ignored ? 'כן' : ''])] };
  const t = totals(ledger, from.slice(0, 7), to.slice(0, 7));
  S.summary = { name: 'סיכום', rows: [['', ''], ['עסק', book.legalName || book.name], ['מספר עוסק', book.taxId || ''], ['סוג עוסק', DEALERS[book.dealerType] || ''],
    ['תקופה', from === '2000-01-01' ? 'הכול' : `${heDate(from)} עד ${heDate(to)}`], ['הופק', new Date().toLocaleString('he-IL', { timeZone: IL_TZ })], ['', ''],
    ['הכנסות לפני מע״מ', r2(t.incNet)], ['מע״מ עסקאות', r2(t.incVat)], ['הוצאות לפני מע״מ', r2(t.expNet)], ['מע״מ תשומות', r2(t.expVat)],
    ['מע״מ לתשלום', r2(t.vatDue)], ['רווח', r2(t.profit)], ['', ''],
    ['מסמכים', docs.length], ['הכנסות', inc.length], ['הוצאות', out.length], ['פקודות יומן', j.tx.length ? j.tx[j.tx.length - 1].n : 0],
    ['', ''], ['Tizon Books ' + VERSION, '']] };
  return S;
}
const SHEET_ORDER = ['summary', 'docs', 'lines', 'pays', 'income', 'expenses', 'vat', 'journal', 'tb', 'customers', 'suppliers', 'items', 'bank'];
async function sheetsToXlsx(S, keys) {
  const X = await import('xlsx');
  const wb = X.utils.book_new();
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  for (const k of keys) {
    const rows = S[k].rows.map((r, i) => i ? r.map(v => isDate(v) ? new Date(v + 'T12:00:00') : v) : r);
    const ws = X.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = S[k].rows[0].map((_, c) => ({ wch: Math.min(48, Math.max(8, ...S[k].rows.slice(0, 400).map(r => String(r[c] ?? '').length + 2))) }));
    if (S[k].rows.length > 1 && k !== 'summary') ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: S[k].rows[0].length - 1 } }) };
    ws['!views'] = [{ RTL: true }];
    X.utils.book_append_sheet(wb, ws, S[k].name.slice(0, 31));
  }
  wb.Workbook = { Views: [{ RTL: true }] };
  return new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true }));
}

function ExportTab({ book, data, ledger, flash, onLog, onSub, user }) {
  const [rk, setRk] = useState('year');
  const [cf, setCf] = useState(`${thisMonth().slice(0, 4)}-01-01`);
  const [ct, setCt] = useState(todayIso());
  const [withTest, setWithTest] = useState(false);
  const [busy, setBusy] = useState('');
  const [one, setOne] = useState('docs');
  const [from, to] = expRange(rk) || [cf, ct];
  const S = useMemo(() => exportSheets(book, data, ledger, from, to, withTest), [book, data, ledger, from, to, withTest]);
  /* File names in plain Latin letters: every browser and mail program keeps them as they are. */
  const safe = 'Tizon-' + ((digitsOf(book.taxId) || 'books') + '-' + String(book.id || '').slice(0, 6)).replace(/[^\w-]/g, '');
  const tag = rk === 'all' ? 'all' : `${from}_${to}`;
  const osek = digitsOf(book.taxId), osekOk = osek.length === 9;
  const liveDocs = (data.documents || []).filter(d => d.series === 'live' && d.date >= from && d.date <= to);
  const n = (k) => Math.max(0, S[k].rows.length - 1);
  const go = async (what, fn) => { setBusy(what); try { await fn(); } catch (e) { console.error(e); flash('הייצוא נכשל: ' + (e.message || e)); } setBusy(''); };

  const excel = () => go('xlsx', async () => {
    saveBytes(`${safe}-${tag}.xlsx`, await sheetsToXlsx(S, SHEET_ORDER), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    flash('קובץ Excel ירד');
  });
  const unified = () => go('of', async () => {
    const { zipSync } = await import('fflate');
    const u = buildUnified(book, liveDocs, lsGet(SOFT_KEY, book.software || {}), from, to, { ledger });
    saveBytes(`OPENFRMT-${osek}-${from}_${to}.zip`, zipSync({ [`${u.dir}/INI.TXT`]: u.ini, [`${u.dir}/BKMVDATA.TXT`]: u.data }), 'application/zip');
    await onLog?.({ action: 'export-unified', title: `${from} עד ${to} · ${liveDocs.length} מסמכים`, series: 'live' });
    flash(`מבנה אחיד ירד · ${u.counts.total} רשומות`);
  });
  const pack = () => go('pack', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const files = { [`${safe}-${tag}.xlsx`]: await sheetsToXlsx(S, SHEET_ORDER) };
    const csvU8 = (rows) => strToU8('﻿' + rows.map(r => r.map(c => { const s = String(c ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n'));
    for (const k of SHEET_ORDER) if (k !== 'summary' && n(k)) files[`csv/${k}-${S[k].name}.csv`] = csvU8(S[k].rows);
    let ofLine = 'מבנה אחיד: לא הופק (חסר מספר עוסק בן 9 ספרות)';
    if (osekOk) {
      const u = buildUnified(book, liveDocs, lsGet(SOFT_KEY, book.software || {}), from, to, { ledger });
      files[`${u.dir}/INI.TXT`] = u.ini; files[`${u.dir}/BKMVDATA.TXT`] = u.data;
      ofLine = `מבנה אחיד: ${u.dir} · ${u.counts.total} רשומות`;
    }
    const sm = S.summary.rows.filter(r => r[0]).map(r => `${r[0]}: ${typeof r[1] === 'number' && /מע״מ|לפני|רווח/.test(r[0]) ? fmt(r[1]) : r[1]}`);
    files['README.txt'] = strToU8([`חבילה לרואה החשבון · ${book.legalName || book.name}`, '', ...sm, '', ofLine, '',
      'בתוך החבילה: קובץ Excel עם גיליון לכל רשימה, אותן רשימות כ-CSV, וקבצי המבנה האחיד (INI.TXT + BKMVDATA.TXT).'].join('\r\n'));
    saveBytes(`accountant-${safe}-${tag}.zip`, zipSync(files), 'application/zip');
    await onLog?.({ action: 'export-pack', title: `${from} עד ${to}` });
    flash('החבילה ירדה');
  });
  const csvOne = () => downloadCSV(`${one}-${safe}-${tag}.csv`, S[one].rows);
  const backup = () => go('json', async () => {
    const all = await exportAll(user?.email);
    all.books = all.books.filter(b => b.id === book.id);
    saveBytes(`backup-${safe}-${todayIso()}.json`, new TextEncoder().encode(JSON.stringify(all)), 'application/json');
    flash('הגיבוי ירד');
  });

  return (<>
    <div data-tour="exp-range" className="mg-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>⬇ ייצוא נתונים</h3>
      <div className="exp-ranges">{EXP_RANGES.map(([k, l]) => <button key={k} className={'mg-chipbtn' + (rk === k ? ' on' : '')} onClick={() => setRk(k)}>{l}</button>)}</div>
      {rk === 'custom' && <div style={{ ...row, marginTop: 10 }}>
        <Field label="מתאריך"><input type="date" value={cf} onChange={e => setCf(e.target.value)} /></Field>
        <Field label="עד תאריך"><input type="date" value={ct} onChange={e => setCt(e.target.value)} /></Field></div>}
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
        {rk === 'all' ? 'כל התקופה' : `${heDate(from)} עד ${heDate(to)}`} · {n('docs')} מסמכים · {n('income')} הכנסות · {n('expenses')} הוצאות</div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 14 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={withTest} onChange={e => setWithTest(e.target.checked)} /> לכלול מסמכי ניסיון</label>
    </div>

    <div className="exp-grid">
      <div data-tour="exp-excel" className="mg-card exp-card">
        <div className="exp-ic">📊</div><h3>Excel מלא</h3>
        <p>קובץ אחד, גיליון לכל רשימה: סיכום, מסמכים ושורותיהם, תקבולים, הכנסות, הוצאות, מע״מ ורווח לפי חודש, פקודות יומן, מאזן בוחן, לקוחות, ספקים, פריטים ובנק. מימין לשמאל, עם סינון בכותרות.</p>
        <button className="mg-btn keep" disabled={!!busy} onClick={excel}>{busy === 'xlsx' ? 'מכין…' : '⬇ הורד Excel'}</button>
      </div>
      <div data-tour="exp-pack" className="mg-card exp-card">
        <div className="exp-ic">🗂</div><h3>חבילה לרואה החשבון</h3>
        <p>קובץ ZIP אחד לשליחה: ה-Excel, כל רשימה גם כ-CSV, וקבצי מבנה אחיד עם פקודות היומן. את זה שולחים לששון בסוף תקופה.</p>
        <button className="mg-btn keep" disabled={!!busy} onClick={pack}>{busy === 'pack' ? 'אורז…' : '⬇ הורד חבילה'}</button>
      </div>
      <div data-tour="exp-unified" className="mg-card exp-card">
        <div className="exp-ic">🏛</div><h3>מבנה אחיד</h3>
        <p>INI.TXT ו-BKMVDATA.TXT לפי הוראה 1.31, כולל פקודות יומן (B100/B110). הקובץ שמבקר מס מבקש, וגם תוכנות אחרות (iCount, חשבשבת, ריווחית) יודעות לקלוט אותו.</p>
        {!osekOk && <div className="mg-note bad" style={{ marginBottom: 8 }}>חסר מספר עוסק בן 9 ספרות בהגדרות העסק.</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="mg-btn keep" disabled={!!busy || !osekOk} onClick={unified}>{busy === 'of' ? 'מפיק…' : `⬇ הפק (${liveDocs.length} מסמכים)`}</button>
          <button className="mg-btn ghost sm" onClick={() => onSub('tax')}>פלט סיכום ורישום ←</button></div>
      </div>
      <div data-tour="exp-csv" className="mg-card exp-card">
        <div className="exp-ic">📄</div><h3>רשימה אחת כ-CSV</h3>
        <p>לכל תוכנה, לגוגל שיטס או לייבוא במקום אחר. נפתח בעברית תקינה גם ב-Excel.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={one} onChange={e => setOne(e.target.value)} style={{ flex: '1 1 160px', width: 'auto' }}>
            {SHEET_ORDER.filter(k => k !== 'summary').map(k => <option key={k} value={k}>{S[k].name} ({n(k)})</option>)}</select>
          <button className="mg-btn keep" disabled={!n(one)} onClick={csvOne}>⬇ CSV</button></div>
      </div>
      <div data-tour="exp-backup" className="mg-card exp-card">
        <div className="exp-ic">💾</div><h3>גיבוי מלא של העסק</h3>
        <p>כל הרשומות של העסק, בלי קשר לתקופה, בקובץ JSON שאפשר לשחזר ממנו (גיבוי וענן ← שחזור).</p>
        <button className="mg-btn ghost keep" disabled={!!busy} onClick={backup}>{busy === 'json' ? 'מכין…' : '⬇ הורד גיבוי'}</button>
      </div>
    </div>
  </>);
}

/* ------------------------------------------------------ the tax tab */
function TaxTab({ book, docs, log, ro, onLog, flash, ledger }) {
  const [withJournal, setWithJournal] = useState(false);
  const y = new Date().getFullYear();
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [withTest, setWithTest] = useState(false);
  const [soft, setSoft] = useState(() => {
    const mine = Object.fromEntries(Object.entries(lsGet(SOFT_KEY, {})).filter(([, v]) => v));
    return { regNo: '', makerId: '', makerName: 'Tizon Health', ...(book.software || {}), ...mine };
  });
  const [last, setLast] = useState(null);
  const osekOk = String(book.taxId || '').replace(/\D/g, '').length === 9;
  /* Only what this software issued: never history imported from iCount. */
  const pick = docs.filter(d => d.date >= from && d.date <= to && (d.series === 'live' || (withTest && d.series === 'test')));

  const run = async () => {
    const { zipSync } = await import('fflate');
    const u = buildUnified(book, pick, soft, from, to, withJournal && ledger ? { ledger } : {});
    const zip = zipSync({ [`${u.dir}/INI.TXT`]: u.ini, [`${u.dir}/BKMVDATA.TXT`]: u.data });
    saveBytes(`OPENFRMT-${String(book.taxId).replace(/\D/g, '')}-${from}_${to}.zip`, zip, 'application/zip');
    setLast(u);
    await onLog({ action: 'export-unified', title: `${from} עד ${to} · ${pick.length} מסמכים${withTest ? ' (כולל ניסיון)' : ''}`, series: withTest ? 'test' : 'live' });
    flash(`הקבצים ירדו · ${u.counts.total} רשומות`);
  };
  const printSummary = () => {
    if (!last) return;
    const rows = Object.entries(last.byType).map(([t, v]) => `<tr><td>${t}</td><td>${DOC_TYPES[t]?.label || ''}</td><td>${v.count}</td><td>${v.total.toFixed(2)}</td></tr>`).join('');
    const recRows = ['A100', 'B100', 'B110', 'C100', 'D110', 'D120', 'Z900'].filter(k => last.counts[k]).map(k => `<tr><td>${k}</td><td>${last.counts[k]}</td></tr>`).join('');
    printHTML(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>הפקת קבצים במבנה אחיד</title>
<style>body{font-family:Arial;margin:30px;font-size:13px}table{border-collapse:collapse;margin:10px 0 20px}td,th{border:1px solid #999;padding:6px 10px;text-align:right}h2{margin:0 0 6px}</style></head><body>
<h2>הפקת קבצים במבנה אחיד</h2>
<div>מספר עוסק: <b>${esc(book.taxId)}</b> · שם העסק: <b>${esc(book.legalName || book.name)}</b></div>
<div>טווח: ${heDate(from)} עד ${heDate(to)} · תאריך ושעת הפקה: ${new Date().toLocaleString('he-IL')}</div>
<div>נתיב: ${esc(last.dir.replace(/\//g, '\\'))} · תוכנה: Tizon Books ${VERSION} · מספר רישום: ${esc(soft.regNo || 'טרם נרשמה')}</div>
<h3>סיכום רשומות בקובץ BKMVDATA</h3><table><tr><th>סוג רשומה</th><th>כמות</th></tr>${recRows}<tr><td><b>סה״כ</b></td><td><b>${last.counts.total}</b></td></tr></table>
<h3>סיכום מסמכים לפי סוג</h3><table><tr><th>קוד</th><th>סוג מסמך</th><th>כמות</th><th>סה״כ (ש״ח)</th></tr>${rows}</table>
</body></html>`);
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const softT = useRef(null);
  const saveSoft = (k, v) => {
    const n = { ...soft, [k]: v }; setSoft(n); lsSet(SOFT_KEY, n);
    // A copy on the business too, so an accountant with read access exports the same files.
    if (!ro) { clearTimeout(softT.current); softT.current = setTimeout(() => DB.patch('books', book.id, { software: n }).catch(() => {}), 800); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(340px,100%),1fr))', gap: 16 }}>
      <div data-tour="tax-export" className="mg-card">
        <h3 style={{ marginTop: 0 }}>ייצוא קבצים במבנה אחיד</h3>
        <p style={{ marginTop: 0 }}>INI.TXT ו-BKMVDATA.TXT לפי הוראה 1.31, בתיקיית OPENFRMT. זה הקובץ שמבקר מס מבקש, והקובץ שנבדק בסימולטור לרישום התוכנה.</p>
        {!osekOk && <div className="mg-note bad" style={{ marginBottom: 10 }}>בהגדרות העסק חסר מספר עוסק תקין בן 9 ספרות.</div>}
        <div style={row}>
          <Field label="מתאריך"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="עד תאריך"><input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', fontSize: 14 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={withTest} onChange={e => setWithTest(e.target.checked)} />
          לכלול מסמכי ניסיון (לבדיקה בסימולטור בלבד)</label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 10px', fontSize: 14 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={withJournal} onChange={e => setWithJournal(e.target.checked)} />
          לכלול רשומות הנהלת חשבונות (B100 / B110): פקודות יומן כפולות וכרטסת חשבונות</label>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>{pick.length} מסמכים בטווח</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="mg-btn keep" disabled={!osekOk || !pick.length} onClick={run}>⬇ הפק קבצים</button>
          <button className="mg-btn ghost keep" disabled={!last} onClick={printSummary}>🖨 פלט סיכום</button>
        </div>
        {last && <div className="mg-note" style={{ marginTop: 10 }}>
          {Object.entries(last.counts).filter(([k]) => k !== 'total').map(([k, v]) => `${k}: ${v}`).join(' · ')} · סה״כ {last.counts.total}
          {last.journal && (() => { const dr = last.journal.accounts.reduce((a, x) => a + x.dr, 0), cr = last.journal.accounts.reduce((a, x) => a + x.cr, 0);
            return <div>מאזן בוחן: חובה {fmt(dr)} · זכות {fmt(cr)} {Math.abs(dr - cr) < 0.01 ? '✓ מאוזן' : '✗ לא מאוזן'}</div>; })()}</div>}
      </div>

      <div data-tour="tax-register" className="mg-card">
        <h3 style={{ marginTop: 0 }}>רישום התוכנה ברשות המסים</h3>
        <ol style={{ paddingInlineStart: 18, lineHeight: 1.9, marginTop: 0, fontSize: 14 }}>
          <li>מפיקים כאן קבצים (אפשר עם מסמכי ניסיון).</li>
          <li>מריצים אותם ב<b>סימולטור</b> של רשות המסים ושומרים את דוח התקינות.</li>
          <li>מדפיסים את <b>פלט הסיכום</b>.</li>
          <li>מגישים באזור האישי: "בקשה לרישום תוכנה המיועדת לניהול מערכת חשבונות ממוחשבת", עם שלושת הפלטים.</li>
          <li>מספר הרישום שמתקבל נרשם כאן, ומופיע מאז בכל קובץ.</li>
        </ol>
        <div style={grid}>
          <Field label="מספר רישום התוכנה"><input dir="ltr" value={soft.regNo} onChange={e => saveSoft('regNo', e.target.value.replace(/\D/g, ''))} placeholder="אחרי הרישום" /></Field>
          <Field label="ע.מ. של יצרן התוכנה"><input dir="ltr" value={soft.makerId} onChange={e => saveSoft('makerId', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="שם יצרן התוכנה"><input value={soft.makerName} onChange={e => saveSoft('makerName', e.target.value)} /></Field>
        </div>
        <div className="mg-note warn" style={{ marginTop: 10 }}>
          הקבצים נבנו לפי המפרט הרשמי, אבל רק הסימולטור של רשות המסים קובע אם הם תקינים. אם הוא מחזיר שגיאה, שלח לי את הדוח שלו.
        </div>
      </div>

      <div data-tour="tax-log" className="mg-card" style={{ gridColumn: '1 / -1' }}>
        <h3 style={{ marginTop: 0 }}>יומן פעולות</h3>
        <div className="mg-tblwrap"><table className="mg-tbl">
          <thead><tr><th>מתי</th><th>מי</th><th>פעולה</th><th>פרטים</th></tr></thead>
          <tbody>
            {[...log].sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 80).map(l => (
              <tr key={l.id}><td>{new Date(l.at).toLocaleString('he-IL')}</td><td dir="ltr" style={{ textAlign: 'right' }}>{l.user}</td>
                <td>{LOG_ACTIONS[l.action] || l.action}</td><td>{l.title}</td></tr>
            ))}
            {!log.length && <tr><td colSpan={4}><div className="mg-empty">עוד אין פעולות ביומן.</div></td></tr>}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}
const LOG_ACTIONS = { allocation: 'מספר הקצאה', archive: 'ארכיון חודשי', 'import-icount': 'ייבוא מ-iCount', issue: 'הפקה', print: 'הדפסה', pdf: 'הורדת PDF', send: 'שליחה חתומה', 'export-unified': 'ייצוא מבנה אחיד', 'export-pack': 'חבילה לרואה חשבון', sign: 'PDF חתום' };

/* ======================================================= reading a unified file */
/* The same format the tax tab writes, read the other way — so any registered
   Israeli software's export can come in: iCount first. Documents only; the
   journal (B100/B110) and stock (M100) records are passed over. */
const IMPORT_TYPES = ['305', '320', '330', '400', '300'];
const PURCHASE_TYPES = ['700', '710'];
function dec8859(bytes, dos) {
  let s = '';
  for (const b of bytes) {
    if (b < 128) s += String.fromCharCode(b);
    else if (!dos && b >= 0xE0 && b <= 0xFA) s += String.fromCharCode(0x5D0 + b - 0xE0);
    else if (dos && b >= 0x80 && b <= 0x9A) s += String.fromCharCode(0x5D0 + b - 0x80);
    else s += ' ';
  }
  return s;
}
/* A signed amount as written in the file: "+00000001234" with the last two
   (or four) digits after the point. Tolerant of spaces and a missing sign. */
function amt(s, dec = 2) {
  const t = String(s || '').replace(/\s/g, '');
  if (!t) return 0;
  const neg = t.startsWith('-'); const d = t.replace(/[^\d]/g, '');
  if (!d) return 0;
  return (neg ? -1 : 1) * Number(d) / 10 ** dec;
}
const fdate = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 8 && d !== '00000000' ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : ''; };

async function readUnifiedFiles(files) {
  let ini = null, data = null;
  for (const f of files) {
    const buf = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name) || (buf[0] === 0x50 && buf[1] === 0x4B)) {
      const { unzipSync } = await import('fflate');
      const all = unzipSync(buf);
      for (const [name, bytes] of Object.entries(all)) {
        const base = name.split('/').pop().toUpperCase();
        if (base === 'INI.TXT') ini = bytes;
        else if (base.startsWith('BKMVDATA')) data = bytes;
      }
    } else if (/^INI\.TXT$/i.test(f.name)) ini = buf;
    else if (/^BKMVDATA/i.test(f.name)) data = buf;
  }
  if (!data) throw new Error('לא נמצא BKMVDATA.TXT בקבצים שנבחרו');
  /* The character set is in the INI (1 = ISO-8859-8, 2 = CP-862, DOS). */
  const iniText = ini ? dec8859(ini, false) : '';
  const dos = iniText.startsWith('A000') && iniText.charAt(395) === '2';
  return { iniText, dataText: dec8859(data, dos), dos };
}

function parseUnified(text, reverse) {
  const fix = (s) => { const t = String(s || '').trim().replace(/\s+/g, ' '); return reverse ? [...t].reverse().join('') : t; };
  const lines = text.split(/\r?\n/).filter(l => l.length > 4);
  const heads = {}; const order = []; const counts = {}; let osek = '';
  const g = (l, a, b) => l.slice(a - 1, b);
  lines.forEach(l => {
    const code = l.slice(0, 4); counts[code] = (counts[code] || 0) + 1;
    if (code === 'A100') osek = g(l, 14, 22);
    if (code === 'C100') {
      const type = g(l, 23, 25), num = g(l, 26, 45).trim();
      const key = type + '|' + num;
      heads[key] = {
        type, num, date: fdate(g(l, 401, 408)) || fdate(g(l, 46, 53)), time: g(l, 54, 57),
        customer: { name: fix(g(l, 58, 107)), address: fix([g(l, 108, 157), g(l, 158, 167), g(l, 168, 197)].join(' ')),
                    phone: g(l, 238, 252).trim(), taxId: (g(l, 253, 261).replace(/\D/g, '').replace(/^0+$/, '')) },
        net: amt(g(l, 318, 332)), vat: amt(g(l, 333, 347)), total: amt(g(l, 348, 362)), withholding: amt(g(l, 363, 374)),
        cancelled: g(l, 400, 400) === '1', lines: [], payments: [], base: null,
      };
      order.push(key);
    }
    if (code === 'D110') {
      const h = heads[g(l, 23, 25) + '|' + g(l, 26, 45).trim()]; if (!h) return;
      const qty = amt(g(l, 224, 240), 4) || 1, unit = amt(g(l, 241, 255)), total = amt(g(l, 271, 285));
      h.lines.push({ desc: fix(g(l, 94, 123)) || 'שורה', qty: Math.abs(qty), price: Math.abs(unit || (qty ? total / qty : total)) });
      h.lineVat = Number(g(l, 286, 289).replace(/\D/g, '') || 0) / 100;
      const bt = g(l, 50, 52).replace(/\D/g, ''), bn = g(l, 53, 72).trim();
      if (bn && Number(bt)) h.base = { type: String(Number(bt)), num: bn };
    }
    if (code === 'D120') {
      const h = heads[g(l, 23, 25) + '|' + g(l, 26, 45).trim()]; if (!h) return;
      const m = { 1: 'מזומן', 2: 'צ׳ק', 3: 'כרטיס אשראי', 4: 'העברה בנקאית' }[g(l, 50, 50)] || 'אחר';
      const det = m === 'צ׳ק' ? [g(l, 51, 60), g(l, 61, 70), g(l, 71, 85), g(l, 86, 95)].map(x => String(Number(x.replace(/\D/g, '') || 0))).join(' ')
                : m === 'כרטיס אשראי' ? fix(g(l, 120, 139)) : '';
      h.payments.push({ kind: m, amount: Math.abs(amt(g(l, 104, 118))), date: fdate(g(l, 96, 103)) || h.date, details: det });
    }
  });
  return { osek, counts, docs: order.map(k => heads[k]) };
}

/* A parsed document as one of ours, marked as history from elsewhere. */
function importedDoc(h, source) {
  const n = /^\d+$/.test(h.num) ? Number(h.num) : h.num;
  const net = Math.abs(h.net), vat = Math.abs(h.vat), total = Math.abs(h.total);
  return clean({
    id: `ic_${h.type}_${String(h.num).replace(/[^\w-]/g, '_')}`, type: h.type, series: 'import', source, number: n,
    date: h.date, customer: h.customer, lines: h.lines, incl: false,
    vatRate: h.lineVat || (net ? Math.round(vat / net * 100) : 0),
    net: net || (total - vat), vat, total, withholding: Math.abs(h.withholding) || 0, payments: h.payments,
    cancelled: h.cancelled, baseRef: h.base ? `${h.base.type}|${h.base.num}` : '',
    refTitle: h.base ? `${DOC_TYPES[h.base.type]?.label || h.base.type} ${h.base.num}` : '',
    printCount: 1, createdAt: new Date().toISOString(), importedAt: new Date().toISOString(),
  });
}
function importedExpense(h, source) {
  const sign = h.type === '710' ? -1 : 1;
  return clean({
    id: `ic_exp_${h.type}_${String(h.num).replace(/[^\w-]/g, '_')}`, src: source, date: h.date,
    supplierName: h.customer.name, desc: `${h.type === '710' ? 'זיכוי רכש' : 'חשבונית רכש'} ${h.num}`, cat: 'אחר',
    gross: sign * Math.abs(h.total), vat: sign * Math.abs(h.vat), vatMode: 'manual', vatManual: Math.abs(h.vat),
    docNo: h.num, hasDoc: true, pay: '',
  });
}

function ICountImport({ book, data, cols, flash, onDone, onLog }) {
  const [raw, setRaw] = useState(null);
  const [reverse, setReverse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState('');
  const [err, setErr] = useState('');
  const parsed = useMemo(() => raw ? parseUnified(raw.dataText, reverse) : null, [raw, reverse]);

  const load = async (files) => {
    setErr(''); setRaw(null);
    try { setRaw(await readUnifiedFiles([...files])); } catch (e) { setErr(e.message || String(e)); }
  };

  const plan = useMemo(() => {
    if (!parsed) return null;
    const have = new Set([...(data.documents || []), ...(data.expenses || [])].map(x => x.id));
    const sales = parsed.docs.filter(h => IMPORT_TYPES.includes(h.type)).map(h => importedDoc(h, 'icount'));
    const buys = parsed.docs.filter(h => PURCHASE_TYPES.includes(h.type)).map(h => importedExpense(h, 'icount'));
    const other = parsed.docs.filter(h => !IMPORT_TYPES.includes(h.type) && !PURCHASE_TYPES.includes(h.type));
    const byType = {}; sales.forEach(d => { const t = byType[d.type] = byType[d.type] || { n: 0, total: 0 }; t.n++; t.total += d.total; });
    const byYear = {}; sales.filter(d => ['305', '320', '330'].includes(d.type)).forEach(d => {
      const y = (d.date || '').slice(0, 4); byYear[y] = (byYear[y] || 0) + (d.type === '330' ? -d.net : d.net); });
    const custs = new Set(sales.map(d => d.customer?.name).filter(Boolean));
    return { sales, buys, other, byType, byYear, custs,
             fresh: sales.filter(d => !have.has(d.id)), freshBuys: buys.filter(e => !have.has(e.id)) };
  }, [parsed, data]);

  const fileOsek = (parsed?.osek || '').replace(/^0+/, '');
  const mismatch = fileOsek && String(book.taxId || '').replace(/\D/g, '').replace(/^0+/, '') !== fileOsek;

  const run = async () => {
    setBusy(true);
    let n = 0;
    const put = (col, r) => withTimeout(col.put(r.id, r), 15000).then(() => { n++; }).catch(() => {});
    if (plan.fresh.length) { setProg('שומר מסמכים…'); n += await archiveAdd(book.id, data, plan.fresh).catch(() => 0); }
    const all = plan.freshBuys.map(e => [cols.expenses, e]);
    for (let i = 0; i < all.length; i += 20) {
      await Promise.all(all.slice(i, i + 20).map(([c, r]) => put(c, r)));
      setProg(`${Math.min(i + 20, all.length)} / ${all.length}`);
    }
    const cp = planCustomers(data.customers || [], plan.sales.map(d => d.customer || {}), 'icount');
    await saveCustomers(cols.customers, [...cp.add, ...cp.upd]);
    await onLog({ action: 'import-icount', title: `${plan.fresh.length} מסמכים, ${plan.freshBuys.length} הוצאות, ${cp.add.length} לקוחות חדשים`, series: 'test' });
    setBusy(false); setProg('');
    flash(`יובאו ${n} רשומות מ-iCount`);
    setRaw(null); onDone();
  };

  return (
    <div data-tour="imp-icount" className="mg-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>ייבוא מ-iCount</h3>
      <p style={{ marginTop: 0 }}>
        ב-iCount: <b>מערכת ← ייצוא במבנה אחיד ← יצירת קבצים במבנה אחיד</b>, מהיום הראשון ועד היום. את קובץ ה-ZIP מעלים כאן כמו שהוא.
        עובד גם עם קובץ מבנה אחיד מכל תוכנה רשומה אחרת.
      </p>
      <label className="mg-btn" style={{ cursor: 'pointer' }}>⬆ בחר קובץ ZIP (או INI.TXT + BKMVDATA.TXT)
        <input type="file" multiple accept=".zip,.txt,.TXT" hidden onChange={e => { load(e.target.files || []); e.target.value = ''; }} /></label>
      {err && <div className="mg-note bad" style={{ marginTop: 10 }}>{err}</div>}

      {plan && <>
        {mismatch && <div className="mg-note warn" style={{ marginTop: 12 }}>
          הקובץ שייך לעוסק <b dir="ltr">{parsed.osek}</b>, והעסק הזה רשום עם <b dir="ltr">{book.taxId || 'בלי מספר'}</b>. ודא שזה העסק הנכון.</div>}
        <div className="mg-stats" style={{ margin: '12px 0' }}>
          {Object.entries(plan.byType).map(([t, v]) => (
            <div key={t} className="mg-stat"><div className="lb">{DOC_TYPES[t]?.label}</div><div className="vl">{v.n}</div><div className="dl">{fmt(v.total)}</div></div>
          ))}
          {plan.buys.length > 0 && <div className="mg-stat"><div className="lb">חשבוניות רכש</div><div className="vl">{plan.buys.length}</div><div className="dl">ייכנסו כהוצאות</div></div>}
          <div className="mg-stat"><div className="lb">לקוחות</div><div className="vl">{plan.custs.size}</div></div>
        </div>
        <div style={{ fontSize: 14, marginBottom: 8 }}>
          הכנסות לפני מע״מ לפי שנה: {Object.entries(plan.byYear).sort().map(([y, v]) => <span key={y} style={{ marginInlineEnd: 14 }}><b>{y}</b> {fmt(v)}</span>)}
        </div>
        <div className="mg-tblwrap" style={{ marginBottom: 10 }}><table className="mg-tbl">
          <thead><tr><th>מסמך</th><th>תאריך</th><th>לקוח</th><th>סה״כ</th></tr></thead>
          <tbody>{plan.sales.slice(0, 6).map(d => (
            <tr key={d.id}><td>{DOC_TYPES[d.type]?.label} {d.number}</td><td>{heDate(d.date)}</td><td>{d.customer?.name}</td><td>{fmt(d.total)}</td></tr>))}
          </tbody></table></div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 10 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={reverse} onChange={e => setReverse(e.target.checked)} />
          השמות מופיעים הפוכים (סמן רק אם בטבלה למעלה העברית כתובה מהסוף להתחלה)</label>
        {plan.other.length > 0 && <div className="mg-note" style={{ marginBottom: 10 }}>
          {plan.other.length} מסמכים מסוגים אחרים (הזמנות, תעודות משלוח וכדומה) לא ייובאו.</div>}
        <div className="mg-note" style={{ marginBottom: 10 }}>
          ייכנסו <b>{plan.fresh.length}</b> מסמכים ו-<b>{plan.freshBuys.length}</b> הוצאות חדשים
          {plan.sales.length - plan.fresh.length > 0 && ` · ${plan.sales.length - plan.fresh.length} כבר קיימים ולא ייובאו שוב`}.
          המסמכים נשמרים כהיסטוריה לקריאה בלבד, עם המספרים של iCount, ונספרים בהכנסות ובמע״מ. הם לא משפיעים על המספור של Tizon Books.
          {data.orders?.length > 0 && ' הזמנות מהחנות שהחשבונית שלהן הופקה ב-iCount ייספרו פעם אחת בלבד.'}
        </div>
        <button className="mg-btn" disabled={busy || !(plan.fresh.length + plan.freshBuys.length)} onClick={run}>
          {busy ? `מייבא… ${prog}` : `ייבא ${plan.fresh.length + plan.freshBuys.length} רשומות`}</button>
      </>}
      {!plan && (data.documents || []).some(isImported) && (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          כבר יובאו {(data.documents || []).filter(isImported).length} מסמכים מ-iCount.{' '}
          <button className="mg-linkish" disabled={busy} onClick={async () => {
            if (!window.confirm('למחוק את כל מה שיובא מ-iCount (מסמכים והוצאות)? אפשר לייבא שוב אחר כך.')) return;
            setBusy(true);
            const docs = (data.documents || []).filter(d => isImported(d) && !d._arch), exps = (data.expenses || []).filter(e => e.src === 'icount');
            for (const c of (data.archive || []).filter(c => c.kind === 'documents')) await cols.archive.del(c.id).catch(() => {});
            for (const d of docs) await cols.documents.del(d.id).catch(() => {});
            for (const e of exps) await cols.expenses.del(e.id).catch(() => {});
            setBusy(false); flash('ההיסטוריה המיובאת נמחקה'); onDone();
          }}>מחק ייבוא</button></div>
      )}
    </div>
  );
}

/* ================================================================ customers */
/* One list per business, fed from four places: typed in here, every document
   issued, the iCount customer list (Excel/CSV) and its documents, and the
   store's customers. The same person arriving from two of them is one
   customer: matched by tax id, then email, then phone, and only by name
   when neither side has any of those. A merge fills what is missing and
   never overwrites what is already there. */
const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const normTax = (t) => { const d = String(t || '').replace(/\D/g, '').replace(/^0+/, ''); return d.length >= 5 ? d : ''; };
const normEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return s.includes('@') ? s : ''; };
const normName = (n) => String(n || '').replace(/[\s"״'׳.,-]+/g, ' ').trim().toLowerCase();
const CUST_FIELDS = ['name', 'taxId', 'phone', 'email', 'address', 'city', 'zip', 'contact', 'notes'];
const CUST_LABELS = { name: 'שם', taxId: 'ח.פ. / ת.ז.', phone: 'טלפון', email: 'אימייל', address: 'כתובת', city: 'עיר', zip: 'מיקוד', contact: 'איש קשר', notes: 'הערות' };
const SRC_LABEL = { manual: 'ידני', doc: 'מסמך', icount: 'iCount', store: 'חנות' };

function sameCustomer(a, b) {
  if (!a || !b) return false;
  const ta = normTax(a.taxId), tb = normTax(b.taxId);
  if (ta && tb) return ta === tb;
  /* A shared email or phone is the same customer only when the names agree:
     a couple, or a parent paying for a child, share them and are not one
     customer on a tax document. */
  const na = normName(a.name), nb = normName(b.name);
  const namesAgree = !na || !nb || na === nb || na.includes(nb) || nb.includes(na);
  const ea = normEmail(a.email), eb = normEmail(b.email);
  if (ea && eb && ea === eb && namesAgree) return true;
  const pa = normPhone(a.phone), pb = normPhone(b.phone);
  if (pa && pb && pa === pb && namesAgree) return true;
  /* By name alone only when nothing on the two sides contradicts it. */
  return !!na && na === nb && !(ea && eb && ea !== eb) && !(pa && pb && pa !== pb) && !(ta || tb);
}
function mergeCustomer(old, inc, source) {
  const out = { ...old };
  /* The store keeps street and city in one field; a record that went there
     with a city only comes back with the city as its "address". */
  if (inc.address && !inc.city && old.city && String(inc.address).trim() === String(old.city).trim()) inc = { ...inc, address: '' };
  CUST_FIELDS.forEach(k => { const v = String(inc[k] ?? '').trim(); if (v && !String(out[k] ?? '').trim()) out[k] = v; });
  out.sources = [...new Set([...(old.sources || []), source].filter(Boolean))];
  if (inc.storeId && !out.storeId) out.storeId = inc.storeId;
  return out;
}
/* Candidates by tax id, email, phone and name, so thousands of customers are
   matched without comparing each with every other. sameCustomer still has
   the last word; the index only saves the looking. Items may be anything:
   get() gives the customer-shaped part. */
/* A customer merged from several records keeps the others as aliases, so
   documents and orders under any of those names still count as theirs. */
const custIdents = (c) => [c, ...((c && Array.isArray(c.alias)) ? c.alias : [])];
const matchCust = (a, b) => custIdents(a).some(x => custIdents(b).some(y => sameCustomer(x, y)));
function custKeys(c) {
  const k = new Set();
  custIdents(c).forEach(x => { const t = normTax(x?.taxId), e = normEmail(x?.email), p = normPhone(x?.phone), n = normName(x?.name);
    if (t) k.add('t:' + t); if (e) k.add('e:' + e); if (p) k.add('p:' + p); if (n) k.add('n:' + n); });
  return [...k];
}
function custIndex(items, get = (x) => x) {
  const m = new Map();
  const add = (it) => custKeys(get(it)).forEach(k => { const l = m.get(k); if (!l) m.set(k, [it]); else if (!l.includes(it)) l.push(it); });
  items.forEach(add);
  const find = (c) => { const seen = new Set(), out = [];
    custKeys(c).forEach(k => (m.get(k) || []).forEach(it => { if (!seen.has(it)) { seen.add(it); if (matchCust(get(it), c)) out.push(it); } }));
    return out; };
  return { add, find };
}

/* ------------------------------------------- finding likely duplicates
   What exact matching cannot know: the same person written as "גילמן
   אלכסנדרה" and "אלכסנדרה גילמן", shortened ("אלכסנדרה גיל"), with a typo,
   or as a first name only. These are suggestions for the user to confirm;
   nothing is merged by itself. A first name alone joins a group only when
   every full name it could be belongs to that one group. */
const HEB_FINAL = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
const nameToks = (n) => normName(n).replace(/[םןץףך]/g, ch => HEB_FINAL[ch]).split(' ').filter(Boolean);
function lev1(a, b) {                      // edit distance of at most one
  if (a === b) return true; const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < la && j < lb) { if (a[i] === b[j]) { i++; j++; continue; } if (++d > 1) return false; if (la > lb) i++; else if (lb > la) j++; else { i++; j++; } }
  return d + (la - i) + (lb - j) <= 1;
}
function dupReason(a, b) {
  if ((a.notDup || []).includes(b.id) || (b.notDup || []).includes(a.id)) return null;
  const ta = normTax(a.taxId), tb = normTax(b.taxId);
  if (ta && tb) return ta === tb ? { lvl: 3, why: 'אותו ח.פ. / ת.ז.' } : null;
  const ea = normEmail(a.email), eb = normEmail(b.email), pa = normPhone(a.phone), pb = normPhone(b.phone);
  /* A shared email or phone with names that do not agree may be a couple, or a parent and child. */
  const na0 = normName(a.name), nb0 = normName(b.name);
  const agree = !na0 || !nb0 || na0 === nb0 || na0.includes(nb0) || nb0.includes(na0) || nameToks(a.name).some(t => t.length > 2 && nameToks(b.name).includes(t) && nameToks(a.name)[0] === nameToks(b.name)[0]);
  if (ea && ea === eb) return agree ? { lvl: 2, why: 'אותו אימייל' } : { lvl: 1, why: 'אותו אימייל, שם אחר', warn: 'שמות שונים' };
  if (pa && pa === pb) return agree ? { lvl: 2, why: 'אותו טלפון' } : { lvl: 1, why: 'אותו טלפון, שם אחר', warn: 'שמות שונים' };
  const contra = (ea && eb) || (pa && pb);             // both have contact details, and none is shared
  const A = nameToks(a.name), B = nameToks(b.name);
  let r = null;
  if (A.length && B.length) {
    if ([...A].sort().join(' ') === [...B].sort().join(' ')) r = { lvl: 3, why: A.join(' ') === B.join(' ') ? 'אותו שם' : 'אותו שם בסדר הפוך' };
    else {
      const [S, L] = A.length <= B.length ? [A, B] : [B, A];
      const used = new Set(); let ok = true, exact = 0;
      for (const t of S) {
        let j = L.findIndex((u, i) => !used.has(i) && u === t);
        if (j >= 0) exact++;
        else if (!/\d/.test(t)) j = L.findIndex((u, i) => !used.has(i) && !/\d/.test(u) && ((t.length >= 3 && u.startsWith(t)) || (u.length >= 3 && t.startsWith(u)) || (t.length >= 4 && u.length >= 4 && lev1(t, u))));
        if (j < 0) { ok = false; break; } used.add(j);
      }
      if (ok && exact >= 1 || ok && S.length >= 2) {
        if (S.length === L.length) r = { lvl: 2, why: 'שם כמעט זהה (קיצור או אות)' };
        else if (S.length >= 2) r = { lvl: 2, why: 'שם מלא יותר אצל אחד' };
        else r = { lvl: 1, why: 'שם פרטי בלבד', weak: true };
      }
    }
  }
  if (!r && ea && eb) { const la = ea.split('@')[0], lb = eb.split('@')[0]; if (la.length >= 5 && la === lb) r = { lvl: 2, why: 'אימייל דומה' }; }
  /* Different phones or emails on both sides: the same person only if the name is exactly the same. */
  if (r && contra) r = r.lvl >= 3 ? { ...r, lvl: 1, warn: 'פרטי קשר שונים' } : null;
  return r;
}
function findDupGroups(list) {
  const n = list.length, blocks = new Map();
  const put = (k, i) => { const l = blocks.get(k); if (!l) blocks.set(k, [i]); else l.push(i); };
  list.forEach((c, i) => {
    nameToks(c.name).forEach(t => put('n:' + t.slice(0, 3), i));
    const e = normEmail(c.email), p = normPhone(c.phone), t = normTax(c.taxId);
    if (e) { put('e:' + e, i); put('l:' + e.split('@')[0], i); } if (p) put('p:' + p, i); if (t) put('t:' + t, i);
  });
  const pairs = new Map();
  for (const l of blocks.values()) {
    if (l.length < 2 || l.length > 400) continue;
    for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) {
      const i = Math.min(l[x], l[y]), j = Math.max(l[x], l[y]), k = i * n + j;
      if (i === j || pairs.has(k)) continue;
      pairs.set(k, dupReason(list[i], list[j]));
    }
  }
  const par = list.map((_, i) => i), root = (i) => par[i] === i ? i : (par[i] = root(par[i]));
  const weak = new Map(), why = new Map();
  for (const [k, r] of pairs) {
    if (!r) continue; const i = Math.floor(k / n), j = k % n;
    if (r.weak) { [[i, j], [j, i]].forEach(([a, b]) => { if (!weak.has(a)) weak.set(a, []); weak.get(a).push(b); }); }
    else par[root(i)] = root(j);
    [i, j].forEach(z => { if (!why.has(z)) why.set(z, []); why.get(z).push({ with: z === i ? j : i, ...r }); });
  }
  /* A first name alone: joined only to the one group all its candidates are in. */
  for (const [a, bs] of weak) {
    if (nameToks(list[a].name).length !== 1) continue;
    const roots = new Set(bs.map(root));
    if (roots.size === 1) par[root(a)] = root([...roots][0]);
  }
  const groups = new Map();
  list.forEach((_, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    const inG = new Set(g); const rs = g.flatMap(i => (why.get(i) || []).filter(w => inG.has(w.with)));
    /* A group is only as sure as its weakest link. */
    return { members: g.map(i => list[i]), lvl: rs.length ? Math.max(...rs.map(r => r.lvl)) : 1, minLvl: rs.length ? Math.min(...rs.map(r => r.lvl)) : 1,
             whys: [...new Set(rs.map(r => r.why))], warn: rs.some(r => r.warn), warns: rs.filter(r => r.warn).map(r => r.warn) };
  }).sort((a, b) => b.lvl - a.lvl || b.members.length - a.members.length);
}
/* One customer from a group: the chosen one keeps its details, the others
   fill what is missing and stay on as aliases. */
function mergeGroup(primary, others) {
  let m = { ...primary };
  others.forEach(o => { m = mergeCustomer(m, o, null); });
  m.sources = [...new Set([primary, ...others].flatMap(x => x.sources || []))];
  const ali = [...(primary.alias || [])];
  others.forEach(o => custIdents(o).forEach(x => { const a = clean({ name: x.name || '', email: x.email || '', phone: x.phone || '', taxId: x.taxId || '', storeId: x.storeId || '' });
    if (!ali.some(y => JSON.stringify(y) === JSON.stringify(a))) ali.push(a); }));
  m.alias = ali;
  const gone = new Set(others.map(o => o.id));
  m.notDup = [...new Set([...(primary.notDup || []), ...others.flatMap(o => o.notDup || [])])].filter(id => !gone.has(id) && id !== m.id);
  if (!m.notDup.length) delete m.notDup;
  return m;
}
/* A batch of incoming customers against the list: what is new, what adds
   something to an existing one, and what is already known. A customer that
   came from the store before is found again by its store id first. */
function planCustomers(list, incoming, source) {
  const cur = [...list]; const add = [], upd = [], same = [], added = new Set(); let dupIn = 0;
  const idx = custIndex([], (i) => cur[i]); cur.forEach((_, i) => idx.add(i));
  const byStore = new Map(); cur.forEach((x, i) => custIdents(x).forEach(y => { if (y.storeId) byStore.set(y.storeId, i); }));
  incoming.filter(c => String(c.name || '').trim() || normEmail(c.email) || normPhone(c.phone)).forEach(c => {
    const hi = c.storeId && byStore.has(c.storeId) ? byStore.get(c.storeId) : idx.find(c).sort((x, y) => x - y)[0];
    if (hi === undefined) {
      const n = clean({ id: uid('cust'), ...Object.fromEntries(CUST_FIELDS.map(k => [k, String(c[k] ?? '').trim()])),
                        name: String(c.name || c.email || c.phone).trim(), sources: [source], storeId: c.storeId || '', createdAt: new Date().toISOString() });
      cur.push(n); add.push(n); added.add(n.id); idx.add(cur.length - 1); if (n.storeId) byStore.set(n.storeId, cur.length - 1);
    } else {
      const hit = cur[hi];
      if (added.has(hit.id)) dupIn++;
      const m = mergeCustomer(hit, c, source);
      const changed = CUST_FIELDS.some(k => (m[k] || '') !== (hit[k] || '')) || (m.sources || []).length !== (hit.sources || []).length || m.storeId !== hit.storeId;
      if (changed) { cur[hi] = m; idx.add(hi); if (m.storeId && !byStore.has(m.storeId)) byStore.set(m.storeId, hi);
        const i = add.findIndex(x => x.id === m.id); if (i >= 0) add[i] = m; else { const j = upd.findIndex(x => x.id === m.id); if (j >= 0) upd[j] = m; else upd.push(m); } }
      else if (!added.has(hit.id)) same.push(hit);
    }
  });
  return { add, upd, same, dupIn, all: cur };
}
async function saveCustomers(col, recs, onProgress) {
  let n = 0;
  for (let i = 0; i < recs.length; i += 25) {
    await Promise.all(recs.slice(i, i + 25).map(r => withTimeout(col.put(r.id, clean({ ...r, updatedAt: new Date().toISOString() })), 15000).then(() => n++).catch(() => {})));
    onProgress?.(Math.min(i + 25, recs.length), recs.length);
  }
  return n;
}

/* ------------------------------------------------ reading a customer file */
/* Column names as iCount and most Israeli systems write them, in Hebrew or
   English. The first column that fits wins; the user can change any of it. */
const COL_GUESS = [
  ['name', /^(שם\s*(ה)?לקוח|שם( מלא)?|לקוח|שם חברה|שם העסק|company|customer|name|full ?name)$/i],
  ['taxId', /(ח\.?\s?פ|ע\.?\s?מ|ת\.?\s?ז|עוסק|מספר זהות|ח"פ|ע"מ|ת"ז|vat|tax ?id|id ?number)/i],
  ['email', /(מייל|דוא"?ל|דואל|e-?mail)/i],
  ['phone', /(נייד|טלפון|סלולרי|phone|mobile|cell)/i],
  ['address', /(כתובת|רחוב|address|street)/i],
  ['city', /(^עיר|ישוב|יישוב|city)/i],
  ['zip', /(מיקוד|zip|postal)/i],
  ['contact', /(איש קשר|contact)/i],
  ['notes', /(הערות|notes|comments)/i],
];
function guessMap(headers) {
  const map = {};
  COL_GUESS.forEach(([k, re]) => {
    const i = headers.findIndex((h, j) => re.test(String(h || '').trim()) && !Object.values(map).includes(j));
    if (i >= 0) map[k] = i;
  });
  if (map.name === undefined) { const i = headers.findIndex((h, j) => /שם|name/i.test(String(h || '')) && !Object.values(map).includes(j)); if (i >= 0) map.name = i; }
  return map;
}
/* Every sheet of an Excel file, old (.xls, as iCount exports) or new (.xlsx). */
async function readWorkbook(file) {
  const X = await import('xlsx');
  const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
  return wb.SheetNames.map(name => ({ name, rows: X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' })
    .map(r => r.map(c => c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c))) }));
}
async function readTable(file) {
  if (/\.xls$/i.test(file.name)) return (await readWorkbook(file))[0]?.rows || [];
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import('read-excel-file/browser');
    const rows = await readSheet(file);
    return (rows || []).map(r => r.map(c => c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c)));
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  /* UTF-8 first; a Windows-1255 export (common from Israeli software) shows
     up as replacement characters, and is read again as such. */
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1255').decode(buf);
  const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const sep = [',', ';', '\t'].map(s => [s, lines[0].split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  return lines.map(l => splitLine(l, sep));
}

function CustomerImport({ list, col, flash, onDone, onClose }) {
  const [rows, setRows] = useState(null);
  const [head, setHead] = useState(0);
  const [map, setMap] = useState({});
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState('');
  const [err, setErr] = useState('');

  const load = async (file) => {
    setErr(''); setRows(null);
    try {
      const r = await readTable(file);
      if (!r.length) throw new Error('הקובץ ריק');
      /* The header is the first row with at least two recognisable names. */
      const h = Math.max(0, r.slice(0, 10).findIndex(x => Object.keys(guessMap(x)).length >= 2));
      setRows(r); setHead(h); setMap(guessMap(r[h]));
    } catch (e) { setErr(e.message || String(e)); }
  };
  const headers = rows ? rows[head] || [] : [];
  /* A list often has two phone columns (טלפון, נייד): an empty one falls
     back to the other. */
  const phoneCols = rows ? (rows[head] || []).map((h, i) => /(נייד|טלפון|סלולרי|phone|mobile|cell)/i.test(String(h || '')) ? i : -1).filter(i => i >= 0) : [];
  const incoming = useMemo(() => rows ? rows.slice(head + 1).map(r => {
    const c = {}; Object.entries(map).forEach(([k, i]) => { if (i !== '' && i != null) c[k] = String(r[i] ?? '').trim(); });
    if (map.phone !== undefined && !c.phone) c.phone = phoneCols.map(i => String(r[i] ?? '').trim()).find(Boolean) || '';
    return c;
  }).filter(c => Object.values(c).some(Boolean)) : [], [rows, head, map]);
  const plan = useMemo(() => rows ? planCustomers(list, incoming, 'icount') : null, [rows, incoming, list]);

  const run = async () => {
    setBusy(true);
    const n = await saveCustomers(col, [...plan.add, ...plan.upd], (a, b) => setProg(`${a} / ${b}`));
    setBusy(false); flash(`נשמרו ${n} לקוחות`); onDone(); onClose();
  };

  return (
    <Box title="ייבוא לקוחות מ-iCount (אקסל / CSV)" onClose={onClose} wide
         footer={<>{plan && <button className="mg-btn" disabled={busy || map.name === undefined || !(plan.add.length + plan.upd.length)} onClick={run}>
                   {busy ? `שומר… ${prog}` : `ייבא ${plan.add.length} חדשים${plan.upd.length ? ` ועדכן ${plan.upd.length}` : ''}`}</button>}
                   <button className="mg-btn ghost" onClick={onClose}>סגור</button></>}>
      <p style={{ marginTop: 0 }}>ב-iCount: <b>לקוחות ← ייצוא לאקסל</b>. אפשר גם CSV, מכל מערכת.</p>
      <label className="mg-btn" style={{ cursor: 'pointer' }}>⬆ בחר קובץ (XLSX / CSV)
        <input type="file" accept=".xlsx,.xls,.csv,.txt" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) load(f); }} /></label>
      {err && <div className="mg-note bad" style={{ marginTop: 10 }}>{err}</div>}
      {rows && <>
        <h4 style={{ margin: '16px 0 6px' }}>איזו עמודה היא מה</h4>
        <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit,minmax(min(150px,100%),1fr))' }}>
          {CUST_FIELDS.map(k => (
            <Field key={k} label={CUST_LABELS[k] + (k === 'name' ? ' *' : '')}>
              <select value={map[k] ?? ''} onChange={e => setMap(m => ({ ...m, [k]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                <option value="">— לא לייבא —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `עמודה ${i + 1}`}</option>)}</select></Field>
          ))}
        </div>
        <div className="mg-tblwrap" style={{ margin: '12px 0' }}><table className="mg-tbl">
          <thead><tr>{CUST_FIELDS.filter(k => map[k] !== undefined).map(k => <th key={k}>{CUST_LABELS[k]}</th>)}</tr></thead>
          <tbody>{incoming.slice(0, 5).map((c, i) => <tr key={i}>{CUST_FIELDS.filter(k => map[k] !== undefined).map(k => <td key={k}>{c[k]}</td>)}</tr>)}</tbody>
        </table></div>
        <div className="mg-note">
          {incoming.length} שורות בקובץ · <b>{plan.add.length}</b> לקוחות חדשים · <b>{plan.upd.length}</b> קיימים שיקבלו פרטים חסרים · {plan.same.length} כבר קיימים כמו שהם.
          פרטים קיימים לא נדרסים; רק שדות ריקים מתמלאים.
        </div>
      </>}
    </Box>
  );
}

/* What a merge from the store will do, before anything is written. */
function StoreMergeReview({ plan, list, total, busy, prog, onGo, onCancel }) {
  const byId = useMemo(() => new Map(list.map(c => [c.id, c])), [list]);
  const diffs = plan.upd.map(m => { const o = byId.get(m.id) || {};
    const f = CUST_FIELDS.filter(k => (m[k] || '') !== (o[k] || '')).map(k => CUST_LABELS[k]);
    if (m.storeId && !o.storeId) f.push('קישור ללקוח בחנות');
    return { m, f }; });
  return (
    <div data-tour="cust-merge" style={{ marginTop: 10, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, color: 'var(--ink)' }}>
      <b>מיזוג לקוחות מהחנות</b> · נקראו {total} לקוחות מהחנות
      <ul style={{ margin: '8px 0', paddingInlineStart: 20, lineHeight: 1.7 }}>
        <li><b>{plan.add.length}</b> לקוחות חדשים יתווספו לרשימה.</li>
        {plan.upd.length > 0 && <li><b>{plan.upd.length}</b> לקוחות שכבר קיימים כאן יקבלו רק פרטים שחסרים להם. שום פרט קיים לא מוחלף.</li>}
        <li><b>{plan.same.length}</b> כבר קיימים כאן בדיוק כמו בחנות ולא ישתנו.</li>
        {plan.dupIn > 0 && <li><b>{plan.dupIn}</b> רשומות כפולות בתוך החנות עצמה (אותו אדם פעמיים) אוחדו ללקוח אחד.</li>}
      </ul>
      <div className="mg-note" style={{ fontSize: '.9em', margin: '6px 0' }}>
        ההתאמה: לפי ח.פ./ת.ז., אחר כך אימייל או טלפון (רק כשהשם לא סותר), ולפי שם רק כשאין שום פרט אחר. בחנות עצמה לא משתנה דבר.</div>
      {diffs.length > 0 && <details style={{ margin: '6px 0' }}><summary>מה יושלם אצל הקיימים ({diffs.length})</summary>
        <div style={{ maxHeight: 220, overflow: 'auto', fontSize: '.92em' }}>
          {diffs.map(({ m, f }) => <div key={m.id} style={{ padding: '3px 0', borderBottom: '1px dashed var(--line)' }}><b>{m.name}</b> · יתווסף: {f.join(', ') || 'מקור: חנות'}</div>)}
        </div></details>}
      {plan.add.length > 0 && <details style={{ margin: '6px 0' }}><summary>דוגמה מהחדשים</summary>
        <div style={{ maxHeight: 220, overflow: 'auto', fontSize: '.92em' }}>
          {plan.add.slice(0, 50).map(c => <div key={c.id} style={{ padding: '3px 0', borderBottom: '1px dashed var(--line)' }}>{c.name} <span style={{ color: 'var(--muted)' }} dir="ltr">{[c.email, c.phone].filter(Boolean).join(' · ')}</span></div>)}
          {plan.add.length > 50 && <div style={{ color: 'var(--muted)' }}>ועוד {plan.add.length - 50}…</div>}
        </div></details>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="mg-btn sm" disabled={busy} onClick={onGo}>{busy ? `ממזג… ${prog}` : `מזג ${plan.add.length + plan.upd.length} לקוחות`}</button>
        <button className="mg-btn ghost sm" disabled={busy} onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}

/* Likely duplicates, a group at a time: pick who stays, untick who is not
   the same person, merge; or mark the group as different people. */
function DupFinder({ list, activity, cols, patch, flash, onClose }) {
  const groups = useMemo(() => findDupGroups(list), [list]);
  const [more, setMore] = useState(30);
  const [busy, setBusy] = useState('');
  const [pick, setPick] = useState({});          // group key → { keep, skip:Set }
  const gkey = (g) => g.members.map(m => m.id).sort().join('|');
  const score = (c) => CUST_FIELDS.filter(k => c[k]).length * 2 + (c.storeId ? 3 : 0) + (activity[c.id]?.ds.length || 0) + (activity[c.id]?.os.length || 0) + nameToks(c.name).length;
  const stateOf = (g) => pick[gkey(g)] || { keep: [...g.members].sort((a, b) => score(b) - score(a))[0].id, skip: [] };
  const setG = (g, f) => setPick(p => ({ ...p, [gkey(g)]: f(stateOf(g)) }));
  const doMerge = async (g) => {
    const st = stateOf(g); const keep = g.members.find(m => m.id === st.keep);
    const others = g.members.filter(m => m.id !== st.keep && !st.skip.includes(m.id));
    if (!others.length) return;
    const m = clean({ ...mergeGroup(keep, others), updatedAt: new Date().toISOString() });
    await withTimeout(cols.customers.put(m.id, m), 15000);
    for (const o of others) await cols.customers.del(o.id).catch(() => {});
    patch('customers', l => [...l.filter(x => x.id !== m.id && !others.some(o => o.id === x.id)), m]);
    return others.length;
  };
  const notDup = async (g) => {
    const ids = g.members.map(m => m.id);
    for (const c of g.members) { const r = clean({ ...c, notDup: [...new Set([...(c.notDup || []), ...ids.filter(i => i !== c.id)])] });
      await withTimeout(cols.customers.put(r.id, r), 15000).catch(() => {}); patch('customers', l => l.map(x => x.id === r.id ? r : x)); }
  };
  const run = async (key, f) => { setBusy(key); try { await f(); } catch { flash('השמירה נכשלה'); } setBusy(''); };
  const sure = groups.filter(g => g.minLvl >= 3 && !g.warn);
  const fmtC = (c) => [c.email, c.phone, c.taxId, c.city].filter(Boolean).join(' · ');
  return (
    <div data-tour="cust-dupfinder" className="mg-card" style={{ marginBottom: 14, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b>איתור כפילויות · {groups.length ? `${groups.length} קבוצות אפשריות` : 'לא נמצאו כפילויות'}</b>
        <div style={{ display: 'flex', gap: 8 }}>
          {sure.length > 0 && <button className="mg-btn sm" disabled={!!busy} onClick={() => run('all', async () => { let n = 0; for (const g of sure) n += (await doMerge(g)) || 0; flash(`מוזגו ${sure.length} קבוצות (${n} רשומות כפולות הוסרו)`); })}>
            {busy === 'all' ? 'ממזג…' : `מזג את ${sure.length} הוודאיות`}</button>}
          <button className="mg-btn ghost sm" onClick={onClose}>סגור</button>
        </div>
      </div>
      <div className="mg-note" style={{ fontSize: '.9em', margin: '8px 0' }}>
        בכל קבוצה: בחר מי נשאר (●), הורד סימון ממי שאינו אותו אדם, ולחץ "מזג". הנשאר שומר את הפרטים שלו ומקבל מהאחרים רק פרטים שחסרים לו.
        השמות האחרים נשמרים אצלו, כך שכל המסמכים וההזמנות שלהם נספרים אליו בכרטסת. "ודאיות" = אותו שם (גם בסדר הפוך) או אותו ח.פ., בלי פרטי קשר סותרים.</div>
      {groups.slice(0, more).map(g => { const st = stateOf(g), k = gkey(g); return (
        <div key={k} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10, marginTop: 10, background: g.lvl >= 3 ? 'transparent' : g.lvl === 2 ? 'transparent' : 'rgba(0,0,0,.015)' }}>
          <div style={{ fontSize: '.9em', color: 'var(--muted)', marginBottom: 6 }}>
            <b style={{ color: g.minLvl >= 3 && !g.warn ? 'var(--green)' : g.lvl >= 2 && !g.warn ? '#8a6d1a' : 'var(--muted)' }}>{g.minLvl >= 3 && !g.warn ? 'כמעט ודאי' : g.lvl >= 2 && !g.warn ? 'סביר' : 'אפשרי, כדאי לבדוק'}</b>
            {' · '}{g.whys.join(' · ')}{g.warn ? ' · ⚠ ' + [...new Set(g.warns || [])].join(', ') : ''}</div>
          {g.members.map(c => { const a = activity[c.id]; const off = st.skip.includes(c.id); return (
            <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', opacity: off ? .45 : 1, flexWrap: 'wrap' }}>
              <input type="radio" name={'keep-' + k} checked={st.keep === c.id} onChange={() => setG(g, s => ({ ...s, keep: c.id, skip: s.skip.filter(x => x !== c.id) }))} title="נשאר" />
              <input type="checkbox" checked={!off} disabled={st.keep === c.id} onChange={e => setG(g, s => ({ ...s, skip: e.target.checked ? s.skip.filter(x => x !== c.id) : [...s.skip, c.id] }))} title="באותו אדם" />
              <b>{c.name}</b>
              <span dir="ltr" style={{ color: 'var(--muted)', fontSize: '.9em' }}>{fmtC(c)}</span>
              <span style={{ color: 'var(--muted)', fontSize: '.85em' }}>{(c.sources || []).map(x => SRC_LABEL[x] || x).join(', ')}{a && (a.ds.length || a.os.length) ? ` · ${a.ds.length} מסמכים${a.os.length ? `, ${a.os.length} הזמנות` : ''}` : ''}</span>
            </label>); })}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="mg-btn sm" disabled={!!busy} onClick={() => run(k, async () => { const n = await doMerge(g); if (n) flash(`מוזג: ${g.members.find(m => m.id === st.keep).name} (${n + 1} רשומות לאחת)`); })}>{busy === k ? 'ממזג…' : 'מזג'}</button>
            <button className="mg-btn ghost sm" disabled={!!busy} onClick={() => run(k, () => notDup(g))}>אלה אנשים שונים</button>
          </div>
        </div>); })}
      {groups.length > more && <button className="mg-btn ghost sm" style={{ marginTop: 10 }} onClick={() => setMore(m => m + 30)}>הצג עוד ({groups.length - more})</button>}
    </div>
  );
}

/* ---------------------------------------------------------- the list */
function CustomersTab({ book, data, cols, patch, flash, ro, role = 'owner', onReload, onStoreLogin, onLedger }) {
  const list = data.customers || [];
  const [q, setQ] = useState('');
  const [src, setSrc] = useState('');
  const [edit, setEdit] = useState(null);
  const [card, setCard] = useState(null);
  const [imp, setImp] = useState(false);
  const [busy, setBusy] = useState('');
  const [storeCust, setStoreCust] = useState(null);
  const [dups, setDups] = useState(false);

  /* What each customer did: documents issued or imported, and store orders. */
  const activity = useMemo(() => {
    const docs = data.documents || [], orders = data.orders || [];
    const di = custIndex(docs, d => d.customer || {});
    const oi = custIndex(orders, o => ({ name: o.customerName, email: o.customerEmail || o.emailKey, phone: o.customerPhone }));
    return Object.fromEntries(list.map(c => {
      const ds = di.find(c), os = oi.find(c);
      const total = ds.filter(d => ['305', '320', '330'].includes(d.type) && !d.cancelled).reduce((a, d) => a + (d.type === '330' ? -d.total : d.total), 0)
                  + os.filter(isPaidOrder).reduce((a, o) => a + (Number(o.total) || 0), 0);
      const last = [...ds.map(d => d.date), ...os.map(o => d10(o.paidAt) || d10(o.createdIso) || d10(o.createdAt))].filter(Boolean).sort().pop() || '';
      return [c.id, { ds, os, total, last }];
    }));
  }, [list, data.documents, data.orders]);

  /* The store's customers, read when this tab opens on a linked business. */
  useEffect(() => {
    if (!book.tenant) return;
    (async () => {
      try {
        if (!(await storeViaServer())) {
          const u = await withTimeout(storeUser(), 10000);
          if (!u) { setStoreCust({ login: true }); return; }
        }
        const rows = await withTimeout(storeRead(book.tenant, 'customers'), 25000);
        setStoreCust({ rows: rows.map(r => {
          const [street, ...rest] = String(r.address || '').split(',');
          return { name: r.name, email: r.email, phone: r.phone, address: street?.trim() || '', city: rest.join(',').trim(), taxId: r.taxId || '', storeId: r.id, notes: '' };
        }) });
      } catch (e) { setStoreCust({ err: String(e?.code || e?.message || e) }); }
    })();
  }, [book.tenant, data.storeAt]);
  const storePlan = useMemo(() => storeCust?.rows ? planCustomers(list, storeCust.rows, 'store') : null, [storeCust, list]);
  /* The other way: customers here that the store does not have. Only ones
     that can be reached (email or phone), and never one already linked. */
  const toStore = useMemo(() => { if (!storeCust?.rows) return [];
    const si = custIndex(storeCust.rows);
    return list.filter(c => !c.storeId && (normEmail(c.email) || normPhone(c.phone)) && !si.find(c).length); }, [storeCust, list]);
  const [review, setReview] = useState(false);
  const [prog, setProg] = useState('');
  const [push, setPush] = useState(null);

  const syncStore = async () => {
    setBusy('store');
    const recs = [...storePlan.upd, ...storePlan.add];
    const n = await saveCustomers(cols.customers, recs, (i, t) => setProg(`${i} / ${t}`));
    setBusy(''); setProg(''); setReview(false);
    flash(n === recs.length ? `המיזוג הסתיים: ${storePlan.add.length} נוספו, ${storePlan.upd.length} הושלמו` : `נשמרו ${n} מתוך ${recs.length}. אפשר ללחוץ שוב כדי להשלים את השאר.`);
    onReload();
  };
  const saveOne = async (c) => {
    const r = clean({ ...c, sources: c.sources?.length ? c.sources : ['manual'], updatedAt: new Date().toISOString() });
    try { await withTimeout(cols.customers.put(r.id, r), 12000); } catch { flash('השמירה נכשלה'); return false; }
    patch('customers', l => [...l.filter(x => x.id !== r.id), r]); flash('הלקוח נשמר'); return true;
  };
  const del = async (c) => {
    if (!window.confirm(`למחוק את ${c.name} מרשימת הלקוחות? המסמכים שלו נשארים.`)) return;
    try { await cols.customers.del(c.id); patch('customers', l => l.filter(x => x.id !== c.id)); setCard(null); } catch { flash('המחיקה נכשלה'); }
  };

  const nq = q.trim().toLowerCase();
  const shown = list.filter(c => (!src || (c.sources || []).includes(src))
    && (!nq || [c.name, c.email, c.phone, c.taxId, c.city].some(v => String(v || '').toLowerCase().includes(nq))))
    .sort((a, b) => (activity[b.id]?.last || '').localeCompare(activity[a.id]?.last || '') || (a.name || '').localeCompare(b.name || '', 'he'));

  const [lim, more] = useLimit([q, src]);
  return (
    <>
      <div data-tour="cust-stats" className="mg-stats" style={{ marginBottom: 14 }}>
        <div className="mg-stat"><div className="lb">לקוחות</div><div className="vl">{list.length}</div></div>
        <div className="mg-stat"><div className="lb">עם אימייל</div><div className="vl">{list.filter(c => normEmail(c.email)).length}</div></div>
        <div className="mg-stat"><div className="lb">עם טלפון</div><div className="vl">{list.filter(c => normPhone(c.phone)).length}</div></div>
        <div className="mg-stat"><div className="lb">פעילים השנה</div><div className="vl">{list.filter(c => (activity[c.id]?.last || '').startsWith(String(new Date().getFullYear()))).length}</div></div>
      </div>

      {book.tenant && storeCust && (
        <div data-tour="cust-store" className={'mg-note' + (storeCust.err ? ' bad' : storePlan && storePlan.add.length + storePlan.upd.length ? ' warn' : '')} style={{ marginBottom: 12 }}>
          {storeCust.login ? <>כדי לסנכרן לקוחות מהחנות צריך להתחבר אליה. <button className="mg-linkish" onClick={onStoreLogin}>התחבר לחנות</button></>
            : storeCust.err ? <>לא הצלחתי לקרוא את לקוחות החנות ({storeCust.err}).</>
            : storePlan && storePlan.add.length + storePlan.upd.length
              ? <>בחנות יש <b>{storePlan.add.length}</b> לקוחות חדשים{storePlan.upd.length ? ` ו-${storePlan.upd.length} עם פרטים נוספים` : ''}. {' '}
                  {!review && <button className="mg-btn sm" disabled={!!busy || ro} onClick={() => setReview(true)}>↻ מזג מהחנות…</button>}
                  {review && <StoreMergeReview plan={storePlan} list={list} total={storeCust.rows.length} busy={busy === 'store'} prog={prog}
                                               onGo={syncStore} onCancel={() => setReview(false)} />}</>
              : <>כל {storeCust.rows.length} לקוחות החנות כבר ברשימה.</>}
          {!ro && toStore.length > 0 && <div style={{ marginTop: 6 }}>
            ב-Tizon Books יש <b>{toStore.length}</b> לקוחות שלא קיימים בחנות.{' '}
            <button className="mg-btn ghost sm" onClick={() => setPush(Object.fromEntries(toStore.map(c => [c.id, false])))}>שלח לחנות…</button></div>}
        </div>
      )}
      {push && (
        <PushToStore book={book} customers={toStore} picked={push} setPicked={setPush} flash={flash}
                     onDone={async (done) => {
                       /* Mark them linked here, so they are neither sent twice nor pulled back as new. */
                       const recs = done.map(({ c, id }) => ({ ...c, storeId: id, sources: [...new Set([...(c.sources || []), 'store'])] }));
                       await saveCustomers(cols.customers, recs);
                       patch('customers', l => l.map(x => recs.find(r => r.id === x.id) || x));
                       setPush(null); setStoreCust(null); onReload();
                     }} onClose={() => setPush(null)} />
      )}

      <div data-tour="cust-tools" style={{ ...row, marginBottom: 12 }}>
        <Field label="חיפוש"><input value={q} onChange={e => setQ(e.target.value)} placeholder="שם, טלפון, אימייל, ח.פ." /></Field>
        <Field label="מקור"><select value={src} onChange={e => setSrc(e.target.value)}>
          <option value="">הכול</option>{Object.entries(SRC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <button className="mg-btn" onClick={() => setEdit({})}>＋ לקוח</button>
        <button className="mg-btn ghost" onClick={() => setImp(true)}>⬆ ייבוא מ-iCount (אקסל / CSV)</button>
        {!ro && <button data-tour="cust-dups" className="mg-btn ghost" onClick={() => setDups(true)}>🔍 איתור כפילויות</button>}
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`customers-${book.name}.csv`, [
          [...CUST_FIELDS.map(k => CUST_LABELS[k]), 'מקור', 'מחזור', 'פעילות אחרונה'],
          ...shown.map(c => [...CUST_FIELDS.map(k => c[k] || ''), (c.sources || []).map(s => SRC_LABEL[s] || s).join(' '), r2(activity[c.id]?.total || 0), activity[c.id]?.last || ''])
        ])}>⬇ ייצוא</button>
      </div>

      {dups && <DupFinder list={list} activity={activity} cols={cols} patch={patch} flash={flash} onClose={() => setDups(false)} />}
      <div data-tour="cust-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>שם</th><th>ח.פ. / ת.ז.</th><th>טלפון</th><th>אימייל</th><th>עיר</th><th>מקור</th><th>מחזור</th><th>אחרון</th></tr></thead>
        <tbody>
          {shown.slice(0, lim).map(c => (
            <tr key={c.id} onClick={() => setCard(c)} style={{ cursor: 'pointer' }}>
              <td><b>{c.name}</b></td>
              <td dir="ltr" style={{ textAlign: 'right' }}>{c.taxId || '—'}</td>
              <td dir="ltr" style={{ textAlign: 'right' }}>{c.phone || '—'}</td>
              <td>{c.email || '—'}</td><td>{c.city || '—'}</td>
              <td>{(c.sources || []).map(s => <span key={s} className={'mg-chip' + (s === 'store' ? ' ok' : '')} style={{ marginInlineEnd: 3 }}>{SRC_LABEL[s] || s}</span>)}</td>
              <td>{activity[c.id]?.total ? fmt(activity[c.id].total) : '—'}</td>
              <td>{heDate(activity[c.id]?.last)}</td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={8}><div className="mg-empty">{list.length ? 'אין לקוחות בסינון הזה.' : 'עוד אין לקוחות. אפשר לייבא מ-iCount, לסנכרן מהחנות, או להוסיף ידנית.'}</div></td></tr>}
          <ShowMore n={lim} total={shown.length} onMore={more} cols={8} />
        </tbody>
      </table></div>
      {shown.length > 500 && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>מוצגים 500 הראשונים. חיפוש מצמצם.</div>}

      {imp && <CustomerImport list={list} col={cols.customers} flash={flash} onDone={onReload} onClose={() => setImp(false)} />}
      {edit && <CustomerForm rec={edit} onClose={() => setEdit(null)} onSave={async (c) => { if (await saveOne(c)) { setEdit(null); } }} />}
      {card && (
        <Box title={card.name} onClose={() => setCard(null)} wide
             footer={<><button className="mg-btn" onClick={() => { setEdit(card); setCard(null); }}>✎ עריכה</button>
                       {onLedger && <button className="mg-btn ghost keep" onClick={() => { onLedger(card); setCard(null); }}>📒 כרטסת</button>}
                       {role === 'owner' && <button className="mg-btn ghost" onClick={() => del(card)}>🗑 מחיקה</button>}
                       <button className="mg-btn ghost keep" onClick={() => setCard(null)}>סגור</button></>}>
          <div style={{ ...grid, fontSize: 14 }}>
            {CUST_FIELDS.filter(k => k !== 'name' && card[k]).map(k => <div key={k}><div style={{ color: 'var(--muted)', fontSize: 12 }}>{CUST_LABELS[k]}</div><b>{card[k]}</b></div>)}
          </div>
          <div className="mg-stats" style={{ margin: '14px 0' }}>
            <div className="mg-stat"><div className="lb">מחזור</div><div className="vl">{fmt(activity[card.id]?.total || 0)}</div></div>
            <div className="mg-stat"><div className="lb">מסמכים</div><div className="vl">{activity[card.id]?.ds.length || 0}</div></div>
            {book.tenant && <div className="mg-stat"><div className="lb">הזמנות בחנות</div><div className="vl">{activity[card.id]?.os.length || 0}</div></div>}
          </div>
          <div className="mg-tblwrap"><table className="mg-tbl">
            <thead><tr><th>תאריך</th><th>מה</th><th>סה״כ</th></tr></thead>
            <tbody>
              {[...(activity[card.id]?.ds || []).map(d => ({ date: d.date, what: docTitle(d), total: d.type === '330' ? -d.total : d.total })),
                ...(activity[card.id]?.os || []).map(o => ({ date: d10(o.paidAt) || d10(o.createdIso) || d10(o.createdAt), what: `הזמנה ${o.code || o.id} · ${isPaidOrder(o) ? 'שולמה' : 'לא שולמה'}`, total: Number(o.total) || 0 }))]
                .sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((x, i) => (
                  <tr key={i}><td>{heDate(x.date)}</td><td>{x.what}</td><td>{fmt(x.total)}</td></tr>))}
              {!(activity[card.id]?.ds.length || activity[card.id]?.os.length) && <tr><td colSpan={3}><div className="mg-empty">אין עדיין פעילות.</div></td></tr>}
            </tbody></table></div>
        </Box>
      )}
    </>
  );
}

/* Sending customers to the store: chosen one by one, with the reason spelled
   out — the store's customer list is also its mailing list. */
function PushToStore({ book, customers, picked, setPicked, flash, onDone, onClose }) {
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState('');
  const [ok, setOk] = useState(false);
  const chosen = customers.filter(c => picked[c.id]);
  const all = chosen.length === customers.length;
  const run = async () => {
    setBusy(true);
    const done = []; let failed = 0;
    for (let i = 0; i < chosen.length; i++) {
      try { done.push({ c: chosen[i], id: await withTimeout(storeAddCustomer(book.tenant, chosen[i]), 15000) }); }
      catch { failed++; }
      setProg(`${i + 1} / ${chosen.length}`);
    }
    setBusy(false);
    flash(`נוספו לחנות ${done.length} לקוחות${failed ? ` · ${failed} נכשלו` : ''}`);
    await onDone(done);
  };
  return (
    <Box title={`שליחת לקוחות לחנות ${book.tenant}`} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={busy || !chosen.length || !ok} onClick={run}>{busy ? `שולח… ${prog}` : `שלח ${chosen.length} לחנות`}</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div className="mg-note warn" style={{ marginBottom: 12 }}>
        <b>רשימת הלקוחות של החנות היא גם רשימת הדיוור שלה.</b> לקוח שנשלח לשם יכול לקבל קמפיינים בוואטסאפ או במייל.
        שלח רק לקוחות שהסכימו לקבל דיוור. מי שביקש להסיר את עצמו נשאר מחוץ לקמפיינים גם אחרי השליחה.
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
        <button className="mg-btn ghost sm" onClick={() => setPicked(Object.fromEntries(customers.map(c => [c.id, !all])))}>{all ? 'נקה הכול' : 'סמן הכול'}</button>
        <span style={{ fontSize: 14, alignSelf: 'center' }}>{chosen.length} מתוך {customers.length} מסומנים</span>
      </div>
      <div className="mg-tblwrap" style={{ maxHeight: 320, overflowY: 'auto' }}><table className="mg-tbl">
        <thead><tr><th></th><th>שם</th><th>טלפון</th><th>אימייל</th><th>מקור</th></tr></thead>
        <tbody>{customers.map(c => (
          <tr key={c.id}><td><input type="checkbox" style={{ width: 'auto' }} checked={!!picked[c.id]} onChange={e => setPicked(p => ({ ...p, [c.id]: e.target.checked }))} /></td>
            <td>{c.name}</td><td dir="ltr" style={{ textAlign: 'right' }}>{c.phone || '—'}</td><td>{c.email || '—'}</td>
            <td>{(c.sources || []).map(s => SRC_LABEL[s] || s).join(', ')}</td></tr>))}
        </tbody></table></div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, fontSize: 14 }}>
        <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={ok} onChange={e => setOk(e.target.checked)} />
        <span>הלקוחות שסימנתי הסכימו לקבל ממני דיוור.</span></label>
      <div className="mg-note" style={{ marginTop: 10 }}>נוצרים בחנות רק לקוחות חדשים. לקוח שכבר קיים שם לא משתנה. בחנות הם מסומנים "נוסף מ-Tizon Books".</div>
    </Box>
  );
}

function CustomerForm({ rec, onSave, onClose }) {
  const [f, setF] = useState(() => ({ id: uid('cust'), ...Object.fromEntries(CUST_FIELDS.map(k => [k, ''])), sources: ['manual'], ...rec }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <Box title={rec.id ? 'עריכת לקוח' : 'לקוח חדש'} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={!String(f.name).trim()} onClick={() => onSave({ ...f, name: String(f.name).trim() })}>שמור</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div style={grid}>
        {CUST_FIELDS.map(k => (
          <Field key={k} label={CUST_LABELS[k]}>
            <input dir={['taxId', 'phone', 'email', 'zip'].includes(k) ? 'ltr' : undefined} value={f[k] || ''} onChange={e => set(k, e.target.value)} /></Field>
        ))}
      </div>
    </Box>
  );
}



/* ============================================================ iCount, live */
/* iCount's documents read directly (API v3, through the server, which keeps
   the token). They are stored exactly like the unified-format import — the
   same ids — so the two never double each other. Month by month, so a busy
   year stays within what one request may return. */
function monthsBetween(from, to) {
  const out = []; let d = new Date(from.slice(0, 7) + '-01T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    const a = d.toISOString().slice(0, 10); const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const b = new Date(n - 864e5).toISOString().slice(0, 10);
    out.push([a < from ? from : a, b > to ? to : b]); d = n;
  }
  return out;
}
async function icountPull(book, from, to, onStep) {
  const all = []; let raw = null, skipped = 0;
  for (const [a, b] of monthsBetween(from, to)) {
    const r = await fnCall({ action: 'icount-docs', book: book.id, from: a, to: b });
    (r.docs || []).forEach(h => all.push(clean({ ...importedDoc(h, 'icount-api'), icountPdf: h.pdf || '' })));
    raw = raw || r.raw; skipped += r.skipped || 0; onStep?.(a.slice(0, 7));
  }
  return { docs: all, raw, skipped };
}
async function icountSave(cols, data, docs, bookId) {
  const have = new Set((data.documents || []).map(d => d.id));
  const fresh = docs.filter(d => !have.has(d.id));
  const n = fresh.length ? await archiveAdd(bookId, data, fresh) : 0;
  const cp = planCustomers(data.customers || [], fresh.map(d => d.customer || {}), 'icount');
  if (cp.add.length + cp.upd.length) await saveCustomers(cols.customers, [...cp.add, ...cp.upd]);
  return { n, customers: cp.add.length };
}
function ICountLive({ book, data, cols, flash, onDone, onLog, server }) {
  const [st, setSt] = useState(null);
  const [token, setToken] = useState('');
  const y = new Date().getFullYear();
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState(null);
  const [auto, setAuto] = useState(!!book.icountAuto);
  const [err, setErr] = useState('');
  const load = () => fnCall({ action: 'icount-status', book: book.id }).then(setSt).catch(() => setSt({ linked: false }));
  useEffect(() => { if (cloud && server) load(); }, [book.id, !!server]);
  if (!cloud || !server) return null;
  const link = async (unlink) => {
    setBusy('link');
    try { const r = await fnCall({ action: 'icount-link', book: book.id, token, unlink }); setToken(''); load(); setErr('');
          flash(unlink ? 'החיבור ל-iCount נותק' : r.warning ? 'המפתח נשמר, אבל iCount החזיר הודעה: ' + r.warning : `מחובר ל-iCount · ${r.recent} מסמכים בחודש האחרון`);
          if (r.warning) setErr('iCount: ' + r.warning); }
    catch (e) {
      const m = e.message || '';
      setErr(m === 'setup-role' ? 'השרת עוד לא יודע מי בעלי העסק: צריך להגדיר ב-Netlify את ALLOWED_EMAILS עם האימייל שלך, או להעלות מפתח שירות (גיבוי וענן ← דפי סליקה).'
        : m === 'owners only' ? 'השרת לא זיהה אותך כבעל העסק הזה. פרטים לבדיקה: ' + JSON.stringify(e.body?.detail || {})
        : /BOOKS_PROJECT_ID/.test(m) ? 'השרת עדיין בגרסה ישנה. חכה לסיום הבנייה ב-Netlify ונסה שוב.'
        : /^HTTP 404/.test(m) ? 'השרת עדיין לא עודכן לגרסה הזו. חכה לסיום הבנייה ב-Netlify ונסה שוב.'
        : /auth|token|401|403|login|unauthori|invalid/i.test(m) ? 'iCount לא קיבל את המפתח (' + m + '). בדוק שהעתקת את כל ה-API Token, ושהוא פעיל ב-iCount.'
        : 'החיבור נכשל: ' + m);
    }
    setBusy('');
  };
  const pull = async () => {
    setBusy('pull'); setRes(null);
    try {
      const r = await icountPull(book, from, to, (m) => setBusy('pull:' + m));
      const have = new Set((data.documents || []).map(d => d.id));
      const byType = {}; r.docs.forEach(d => { const t = byType[d.type] = byType[d.type] || { n: 0, total: 0 }; t.n++; t.total += d.total; });
      setRes({ ...r, byType, fresh: r.docs.filter(d => !have.has(d.id)) });
    } catch (e) { setErr('המשיכה מ-iCount נכשלה: ' + e.message + (e.body?.detail ? ' · פרטים לבדיקה: ' + JSON.stringify(e.body.detail) : '')); }
    setBusy('');
  };
  const save = async () => {
    setBusy('save');
    const r = await icountSave(cols, data, res.fresh, book.id);
    await onLog({ action: 'import-icount', title: `iCount (חיבור ישיר): ${r.n} מסמכים, ${r.customers} לקוחות חדשים`, series: 'test' });
    setBusy(''); setRes(null); flash(`נשמרו ${r.n} מסמכים מ-iCount`); onDone();
  };
  const setAutoSync = async (v) => {
    setAuto(v);
    try { await DB.patch('books', book.id, { icountAuto: v }); flash(v ? 'מסמכים חדשים מ-iCount ייכנסו לבד, פעם ביום' : 'הסנכרון האוטומטי כובה'); } catch { flash('השמירה נכשלה'); }
  };
  return (
    <div data-tour="imp-icount-live" className="mg-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>חיבור ישיר ל-iCount {st?.linked && <span className="mg-chip ok">מחובר</span>}</h3>
      {!st ? <div className="mg-empty">בודק…</div> : !st.linked ? <>
        <p style={{ marginTop: 0, fontSize: 14 }}>המסמכים של iCount נכנסים לכאן בלי לייצא קבצים: מה שכבר הופק, ומעכשיו גם כל מסמך חדש. קריאה בלבד; ב-iCount לא משתנה דבר.</p>
        <ol style={{ fontSize: 14, lineHeight: 1.8, paddingInlineStart: 18, marginTop: 0 }}>
          <li>ב-iCount: אזור אישי ← הגדרות ← <b>API</b> ← יצירת API Token חדש.</li>
          <li>מעתיקים את המפתח (מתחיל ב-<span dir="ltr">API3</span>) ומדביקים כאן. הוא נשמר רק בשרת.</li>
        </ol>
        <div style={row}>
          <Field label="API Token של iCount"><input dir="ltr" type="text" name="icount-api-token" autoComplete="off" spellCheck={false} style={{ WebkitTextSecurity: 'disc' }} value={token} onChange={e => setToken(e.target.value)} placeholder="API3E8-…" /></Field>
          <button className="mg-btn" disabled={busy === 'link' || token.trim().length < 10} onClick={() => link(false)}>{busy === 'link' ? 'בודק…' : 'חבר'}</button>
        </div>
        {err && <div className="mg-note bad" style={{ marginTop: 10 }}>{err}</div>}
      </> : <>
        <div style={row}>
          <Field label="מתאריך"><input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="עד תאריך"><input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} /></Field>
          <button className="mg-btn" disabled={!!busy} onClick={pull}>{busy.startsWith('pull') ? `מושך… ${busy.slice(5)}` : '⬇ משוך מסמכים'}</button>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginTop: 10 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={e => setAutoSync(e.target.checked)} />מסמכים חדשים נכנסים לבד, פעם ביום (כשפותחים את העסק)</label>
        {err && <div className="mg-note bad" style={{ marginTop: 10 }}>{err}</div>}
        {res && <div style={{ marginTop: 12 }}>
          <div className="mg-note">
            נמצאו <b>{res.docs.length}</b> מסמכים · <b>{res.fresh.length}</b> חדשים (השאר כבר כאן){res.skipped ? ` · ${res.skipped} שאינם מסמכי מס (הצעות, הזמנות) דולגו` : ''}.
            <div style={{ marginTop: 4 }}>{Object.entries(res.byType).map(([t, v]) => <span key={t} className="mg-chip" style={{ marginInlineEnd: 6 }}>{DOC_TYPES[t]?.label}: {v.n} · {fmt(v.total)}</span>)}</div>
          </div>
          {res.docs[0] && <details style={{ marginTop: 8, fontSize: 13 }}><summary>בדיקה: המסמך הראשון כפי שנקלט, מול מה ש-iCount שלח</summary>
            <div style={{ ...grid, marginTop: 8 }}>
              <pre dir="ltr" style={{ whiteSpace: 'pre-wrap', background: 'var(--soft)', padding: 8, borderRadius: 8, maxHeight: 240, overflow: 'auto' }}>{JSON.stringify({ type: res.docs[0].type, number: res.docs[0].number, date: res.docs[0].date, customer: res.docs[0].customer?.name, net: res.docs[0].net, vat: res.docs[0].vat, total: res.docs[0].total, lines: res.docs[0].lines, payments: res.docs[0].payments }, null, 1)}</pre>
              <pre dir="ltr" style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 8, borderRadius: 8, maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(res.raw, null, 1)}</pre>
            </div></details>}
          <div style={{ ...row, marginTop: 10 }}>
            <button className="mg-btn" disabled={busy === 'save' || !res.fresh.length} onClick={save}>{busy === 'save' ? 'שומר…' : `שמור ${res.fresh.length} מסמכים חדשים`}</button>
          </div>
        </div>}
        <div style={{ marginTop: 12 }}><button className="mg-btn ghost sm" onClick={() => { if (window.confirm('לנתק את החיבור ל-iCount? המסמכים שכבר נקלטו נשארים.')) link(true); }}>נתק</button></div>
      </>}
    </div>
  );
}

/* ============================================================ duplicates */
/* The same business twice (typically: made on a device before the cloud, and
   again in the cloud, then moved up). Merging keeps one: everything of the
   other is copied into it — incomes, expenses, suppliers, bank lines,
   customers and items (without doubling), documents imported from iCount —
   and the other is removed. Real documents are never moved or deleted: the
   business that has them is the one that stays; two with real documents are
   left for the user to decide. */
const bookKey = (b) => normName(b.name);
function dupGroups(books, email) {
  const mine = books.filter(b => roleOf(b, email) === 'owner');
  const g = {};
  mine.forEach(b => { (g[bookKey(b)] = g[bookKey(b)] || []).push(b); });
  return Object.values(g).filter(x => x.length > 1);
}
async function mergeBooks(keep, drop, onStep) {
  const dataK = await loadBook(keep), dataD = await loadBook(drop);
  /* Nothing is deleted unless both were read in full and every copy was written. */
  const bad = [...(dataK.errors || []), ...(dataD.errors || [])];
  if (bad.length) throw new Error('לא הצלחתי לקרוא את כל הנתונים (' + [...new Set(bad)].join(', ') + '). לא נמחק דבר; נסה שוב.');
  let n = 0, failed = 0;
  const put = async (c, r) => { const { id, ...rest } = r; try { await withTimeout(bookCol(keep.id, c).put(id, clean(rest)), 15000); n++; } catch { failed++; } };
  for (const c of ['incomes', 'expenses', 'suppliers', 'banktx']) {
    const have = new Set((dataK[c] || []).map(x => x.id));
    for (const r of dataD[c] || []) if (!have.has(r.id)) await put(c, r);
    onStep?.(c);
  }
  const cp = planCustomers(dataK.customers || [], dataD.customers || [], 'manual');
  for (const r of [...cp.add, ...cp.upd]) await put('customers', r);
  const ip = planItems(dataK.items || [], dataD.items || [], false);
  for (const r of [...ip.add, ...ip.upd]) await put('items', r);
  const haveImp = new Set((dataK.documents || []).filter(d => d.series === 'import').map(d => d.type + ':' + d.number));
  const moreImp = (dataD.documents || []).filter(d => d.series === 'import' && !haveImp.has(d.type + ':' + d.number));
  if (moreImp.length) n += await archiveAdd(keep.id, dataK, moreImp);
  if (failed) throw new Error(`${failed} רשומות לא הועתקו. העסק הכפול לא נמחק; נסה שוב.`);
  /* The duplicate goes: whatever the rules let go (test and imported documents, test counters and log), then the business itself. */
  for (const c of COLS) for (const r of dataD[c] || []) await bookCol(drop.id, c).del(r.id).catch(() => {});
  await delBook(drop.id);
  return n;
}
function DupCard({ books, user, flash, onDone }) {
  const groups = dupGroups(books, user.email);
  const [info, setInfo] = useState({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    groups.flat().forEach(b => loadBook(b).then(d => setInfo(x => ({ ...x, [b.id]: { err: (d.errors || []).length > 0,
      live: (d.documents || []).filter(z => z.series === 'live').length, docs: (d.documents || []).length,
      recs: ['incomes', 'expenses', 'suppliers', 'banktx', 'customers', 'items'].reduce((a, c) => a + (d[c] || []).length, 0) } }))).catch(() => {}));
  }, [groups.flat().map(b => b.id).join()]);
  if (!groups.length) return null;
  const merge = async (g) => {
    const st = g.map(b => ({ b, i: info[b.id] || { live: 0, docs: 0, recs: 0 } }));
    const taxes = [...new Set(g.map(b => digitsOf(b.taxId)).filter(Boolean))];
    if (taxes.length > 1) { flash('לעסקים האלה מספרי עוסק שונים, ולכן הם לא כפולים. אם אחד מיותר, מוחקים אותו בכפתור "מחק" לידו.'); return; }
    const withLive = st.filter(x => x.i.live > 0);
    if (withLive.length > 1) { flash('בשני העסקים יש מסמכים אמיתיים. אי אפשר למזג אותם אוטומטית; כדאי לשנות לאחד מהם את השם.'); return; }
    const keep = (withLive[0] || [...st].sort((a, z) => (z.i.docs + z.i.recs) - (a.i.docs + a.i.recs))[0]).b;
    const drops = g.filter(b => b.id !== keep.id);
    if (!window.confirm(`למזג ${g.length} עסקים בשם "${keep.name}" לעסק אחד? הנתונים של ${drops.length === 1 ? 'הכפול' : 'הכפולים'} יועתקו אליו, ${drops.length === 1 ? 'והכפול יימחק' : 'והכפולים יימחקו'}.`)) return;
    setBusy(keep.id);
    try { let n = 0; for (const d of drops) n += await mergeBooks(keep, d); flash(`המיזוג הושלם: ${n} רשומות הועתקו ל"${keep.name}"`); onDone(keep.id); }
    catch (e) { flash('המיזוג נכשל · ' + (e?.code || e?.message || '')); }
    setBusy('');
  };
  /* An empty copy simply goes. */
  const del = async (b) => {
    if (!window.confirm(`למחוק את העותק הריק של "${b.name}"? אין בו מסמכים או רשומות.`)) return;
    setBusy(b.id);
    try { const d = await loadBook(b);
          if ((d.errors || []).length || (d.documents || []).length || ['incomes', 'expenses', 'suppliers', 'banktx', 'customers', 'items'].some(c => (d[c] || []).length)) throw new Error('העותק לא ריק או לא נקרא במלואו; לא נמחק');
          for (const c of COLS) for (const r of d[c] || []) await bookCol(b.id, c).del(r.id).catch(() => {});
          await delBook(b.id); flash('העותק הריק נמחק'); onDone(); }
    catch (e) { flash('המחיקה נכשלה · ' + (e?.code || e?.message || '')); }
    setBusy('');
  };
  return (
    <div className="mg-note warn" style={{ marginBottom: 14 }}>
      <b>נמצאו עסקים כפולים.</b> כנראה נוצרו פעם במכשיר ופעם בענן. מיזוג משאיר עסק אחד עם כל הנתונים.
      {groups.map(g => (
        <div key={g[0].id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <b>{g[0].name}</b> ×{g.length}
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>{g.map(b => info[b.id] ? `${info[b.id].docs} מסמכים · ${info[b.id].recs} רשומות` : '…').join(' | ')}</span>
          <button className="mg-btn sm" disabled={!!busy || g.some(b => !info[b.id])} onClick={() => merge(g)}>{busy ? 'ממזג…' : 'מזג לעסק אחד'}</button>
          {g.filter(b => info[b.id] && !info[b.id].err && !info[b.id].docs && !info[b.id].recs).slice(0, g.length - 1).map((b, k) => (
            <button key={b.id} className="mg-btn ghost sm" disabled={!!busy} onClick={() => del(b)}>🗑 מחק את הריק{g.filter(x => info[x.id] && !info[x.id].docs && !info[x.id].recs).length > 1 ? ` (${k + 1})` : ''}</button>))}
        </div>))}
    </div>
  );
}

/* =================================================================== ledgers */
/* כרטסת: every movement of one customer, supplier or bookkeeping account,
   with a running balance and an opening balance for the period; and the
   trial balance of all accounts. Customers are read from the documents
   themselves (issued here and imported from iCount), accounts from the same
   double-entry journal that goes into the unified file. */
const LEDGER_KINDS = [['cust', 'כרטסת לקוח'], ['supp', 'כרטסת ספק'], ['acc', 'כרטסת חשבון'], ['tb', 'מאזן בוחן']];

/* One customer's movements: debit what was invoiced, credit what was paid or credited. */
function customerMoves(book, docs, who, withTest, idx) {
  const out = [];
  (idx ? idx.find(who) : docs.filter(d => matchCust(who, d.customer || {}))).filter(d => (withTest || d.series !== 'test') && !d.cancelled).forEach(d => {
    const t = docTitle(d), wh = Number(d.withholding) || 0;
    const paid = r2((d.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0) + wh);
    if (d.type === '305') out.push({ date: d.date, ref: t, desc: 'חשבונית', dr: r2(d.total), cr: 0, docId: d.id });
    if (d.type === '320') { out.push({ date: d.date, ref: t, desc: 'חשבונית', dr: r2(d.total), cr: 0, docId: d.id });
                            if (paid) out.push({ date: d.date, ref: t, desc: 'תקבול' + (wh ? ` (כולל ניכוי במקור ${fmt(wh)})` : ''), dr: 0, cr: paid, docId: d.id }); }
    if (d.type === '400') {
      if (book.dealerType === 'exempt' && !d.refId) out.push({ date: d.date, ref: t, desc: 'מכירה', dr: r2(d.total), cr: 0, docId: d.id });
      out.push({ date: d.date, ref: t, desc: 'תקבול' + (d.refTitle ? ` · ${d.refTitle}` : '') + (wh ? ` (כולל ניכוי במקור ${fmt(wh)})` : ''), dr: 0, cr: r2((Number(d.total) || 0) + wh), docId: d.id });
    }
    if (d.type === '330') out.push({ date: d.date, ref: t, desc: 'זיכוי' + (d.refTitle ? ` · ${d.refTitle}` : ''), dr: 0, cr: r2(d.total), docId: d.id });
  });
  return out.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (b.dr - a.dr));
}
/* Expenses are recorded when paid: each one is a bill and its payment. */
function supplierMoves(ledger, s) {
  const out = [];
  ledger.outgo.filter(e => (s.id && e.supplierId === s.id) || (!e.supplierId && s.name && normName(e.supplierName) === normName(s.name))).forEach(e => {
    out.push({ date: e.date, ref: e.docNo || '', desc: e.desc || e.cat || 'הוצאה', dr: 0, cr: r2(e.gross) });
    out.push({ date: e.date, ref: e.docNo || '', desc: 'תשלום' + (e.pay ? ` · ${e.pay}` : ''), dr: r2(e.gross), cr: 0 });
  });
  return out.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.dr - b.dr));
}
/* Opening balance before the period, and the period's lines with a running balance. */
function withBalance(moves, from, to) {
  const before = moves.filter(m => m.date < from);
  let bal = r2(before.reduce((a, m) => a + m.dr - m.cr, 0));
  const open = bal;
  const rows = moves.filter(m => m.date >= from && m.date <= to).map(m => { bal = r2(bal + m.dr - m.cr); return { ...m, bal }; });
  return { open, rows, dr: r2(rows.reduce((a, m) => a + m.dr, 0)), cr: r2(rows.reduce((a, m) => a + m.cr, 0)), close: bal };
}
const balText = (n) => Math.abs(n) < 0.005 ? '0' : `${fmt(Math.abs(n))} ${n > 0 ? 'חובה' : 'זכות'}`;

function ledgerHTML(book, title, sub, head, rows, foot) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:A4;margin:14mm}body{font-family:Arial,sans-serif;font-size:12px;color:#222;margin:0}
h1{font-size:20px;margin:0 0 2px;color:#6e4d22}.s{color:#666;margin-bottom:12px}table{width:100%;border-collapse:collapse}
th{background:#f1e8d6;text-align:right;padding:6px;font-size:11px}td{padding:6px;border-bottom:1px solid #eee}.n{text-align:left;white-space:nowrap}
tfoot td{font-weight:800;background:#faf6ee}.top{display:flex;justify-content:space-between;border-bottom:3px solid #a8783f;padding-bottom:8px;margin-bottom:12px}</style></head><body>
<div class="top"><div><b style="font-size:16px">${esc(book.legalName || book.name)}</b><div>${esc(DEALERS[book.dealerType] || '')} ${esc(book.taxId || '')}</div></div><div>${esc(new Date().toLocaleDateString('he-IL'))}</div></div>
<h1>${esc(title)}</h1><div class="s">${esc(sub)}</div>
<table><thead><tr>${head.map(h => `<th${h.n ? ' class="n"' : ''}>${esc(h.t)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${head[i].n ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
${foot ? `<tfoot><tr>${foot.map((c, i) => `<td${head[i].n ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr></tfoot>` : ''}</table>
<div class="s" style="margin-top:14px">הופק ב-Tizon Books ${VERSION}</div></body></html>`;
}

function LedgerTab({ book, data, ledger, pick }) {
  const y = new Date().getFullYear();
  const [kind, setKind] = useState(pick?.kind || 'cust');
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [sel, setSel] = useState(pick?.id || '');
  const [q, setQ] = useState('');
  /* While the business issues test documents, they can be looked at here too. */
  const [withTest, setWithTest] = useState(() => docSeries(book) === 'test');
  useEffect(() => { if (pick) { setKind(pick.kind); setSel(pick.id); } }, [pick]);
  const docs = data.documents || [];

  /* Customers: the list, and anyone on a document who is not on it. */
  const custs = useMemo(() => {
    const list = (data.customers || []).map(c => ({ ...c, key: c.id }));
    const ci = custIndex(list);
    docs.filter(d => (withTest || d.series !== 'test') && d.customer?.name).forEach(d => {
      if (!ci.find(d.customer).length) { const c = { ...d.customer, key: 'doc:' + normName(d.customer.name) }; list.push(c); ci.add(c); }
    });
    const di = custIndex(docs, d => d.customer || {});
    return list.map(c => { const m = withBalance(customerMoves(book, docs, c, withTest, di), '0000-00-00', '9999-12-31'); return { ...c, bal: m.close, n: m.rows.length }; })
      .filter(c => c.n).sort((a, b) => Math.abs(b.bal) - Math.abs(a.bal) || String(a.name).localeCompare(String(b.name), 'he'));
  }, [data.customers, docs, book, withTest]);
  const supps = useMemo(() => (data.suppliers || []).map(s => ({ ...s, key: s.id, n: supplierMoves(ledger, s).length })).filter(s => s.n)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'he')), [data.suppliers, ledger]);
  /* The journal from the beginning, for opening balances; accounts as in the unified file. */
  const journal = useMemo(() => kind === 'acc' || kind === 'tb' ? buildJournal(book, docs, ledger, '0000-00-00', to) : null, [kind, book, docs, ledger, to]);

  let view = null;
  if (kind === 'cust' || kind === 'supp') {
    const list = kind === 'cust' ? custs : supps;
    const who = list.find(x => x.key === sel);
    if (who) {
      const m = withBalance(kind === 'cust' ? customerMoves(book, docs, who, withTest) : supplierMoves(ledger, who), from, to);
      view = { title: `${kind === 'cust' ? 'כרטסת לקוח' : 'כרטסת ספק'} · ${who.name}`, who, ...m };
    }
  } else if (kind === 'acc' && journal) {
    const a = journal.accounts.find(x => x.key === sel);
    if (a) {
      const moves = journal.tx.filter(t => t.acc === a.key).map(t => ({ date: t.date, ref: t.ref, desc: t.desc, dr: t.side === 1 ? t.amt : 0, cr: t.side === 2 ? t.amt : 0 }))
        .sort((x, z) => (x.date || '').localeCompare(z.date || ''));
      view = { title: `כרטסת חשבון · ${a.key} ${a.name}`, ...withBalance(moves, from, to) };
    }
  }
  const tb = kind === 'tb' && journal ? (() => {
    const rows = journal.accounts.map(a => {
      const t = journal.tx.filter(x => x.acc === a.key && x.date >= from && x.date <= to);
      const dr = r2(t.filter(x => x.side === 1).reduce((s, x) => s + x.amt, 0)), cr = r2(t.filter(x => x.side === 2).reduce((s, x) => s + x.amt, 0));
      return { key: a.key, name: a.name, group: a.tbName, dr, cr, bal: r2(dr - cr) };
    }).filter(r => r.dr || r.cr).sort((a, b) => String(a.key).localeCompare(String(b.key)));
    return { rows, dr: r2(rows.reduce((s, r) => s + r.dr, 0)), cr: r2(rows.reduce((s, r) => s + r.cr, 0)) };
  })() : null;

  const sub = `${heDate(from)} עד ${heDate(to)}`;
  const HEAD = [{ t: 'תאריך' }, { t: 'אסמכתא' }, { t: 'פרטים' }, { t: 'חובה', n: 1 }, { t: 'זכות', n: 1 }, { t: 'יתרה', n: 1 }];
  const lines = view ? [['', '', 'יתרת פתיחה', '', '', balText(view.open)], ...view.rows.map(r => [heDate(r.date), r.ref, r.desc, r.dr ? fmt(r.dr) : '', r.cr ? fmt(r.cr) : '', balText(r.bal)])] : [];
  const foot = view ? ['', '', 'סה״כ לתקופה', fmt(view.dr), fmt(view.cr), balText(view.close)] : null;
  const print = () => {
    if (view) printHTML(ledgerHTML(book, view.title, sub, HEAD, lines, foot));
    else if (tb) printHTML(ledgerHTML(book, 'מאזן בוחן', sub, [{ t: 'חשבון' }, { t: 'שם' }, { t: 'קבוצה' }, { t: 'חובה', n: 1 }, { t: 'זכות', n: 1 }, { t: 'יתרה', n: 1 }],
      tb.rows.map(r => [r.key, r.name, r.group, fmt(r.dr), fmt(r.cr), balText(r.bal)]), ['', 'סה״כ', '', fmt(tb.dr), fmt(tb.cr), balText(r2(tb.dr - tb.cr))]));
  };
  const csv = () => {
    if (view) downloadCSV(`ledger-${book.name}-${from}_${to}.csv`, [[view.title], [sub], [], HEAD.map(h => h.t),
      ['', '', 'יתרת פתיחה', '', '', view.open], ...view.rows.map(r => [r.date, r.ref, r.desc, r.dr || '', r.cr || '', r.bal]), ['', '', 'סה״כ', view.dr, view.cr, view.close]]);
    else if (tb) downloadCSV(`trial-balance-${book.name}-${from}_${to}.csv`, [['מאזן בוחן', sub], [], ['חשבון', 'שם', 'קבוצה', 'חובה', 'זכות', 'יתרה'],
      ...tb.rows.map(r => [r.key, r.name, r.group, r.dr, r.cr, r.bal]), ['', 'סה״כ', '', tb.dr, tb.cr, r2(tb.dr - tb.cr)]]);
  };
  const mail = () => {
    const c = view?.who; if (!c) return;
    const body = `שלום ${c.name},\n\nמצב החשבון שלך אצלנו ל-${heDate(to)}: ${Math.abs(view.close) < 0.005 ? 'אין יתרה פתוחה' : view.close > 0 ? `יתרה לתשלום ${fmt(view.close)}` : `יתרת זכות ${fmt(-view.close)}`}.\n\n`
      + view.rows.map(r => `${heDate(r.date)} · ${r.ref} · ${r.desc} · ${r.dr ? fmt(r.dr) : '-' + fmt(r.cr)}`).join('\n') + `\n\nתודה,\n${book.legalName || book.name}`;
    window.location.href = `mailto:${c.email || ''}?subject=${encodeURIComponent('כרטסת · ' + (book.legalName || book.name))}&body=${encodeURIComponent(body)}`;
  };

  const list = kind === 'cust' ? custs : kind === 'supp' ? supps : kind === 'acc' && journal ? journal.accounts.map(a => ({ key: a.key, name: `${a.key} · ${a.name}` })) : [];
  const shown = list.filter(x => !q || String(x.name || '').toLowerCase().includes(q.toLowerCase()) || String(x.taxId || '').includes(q));
  return (
    <>
      <div data-tour="ledger-kind" className="mg-tabs" style={{ marginBottom: 12 }}>
        {LEDGER_KINDS.map(([k, l]) => <button key={k} className={'mg-tab' + (kind === k ? ' on' : '')} onClick={() => { setKind(k); setSel(''); setQ(''); }}>{l}</button>)}
      </div>
      <div data-tour="ledger-range" style={{ ...row, marginBottom: 12 }}>
        <Field label="מתאריך"><input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)} /></Field>
        <Field label="עד תאריך"><input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)} /></Field>
        {kind === 'cust' && docs.some(d => d.series === 'test') && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, alignSelf: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={withTest} onChange={e => setWithTest(e.target.checked)} />כולל מסמכי ניסיון</label>}
        {(view || tb) && <>
          <button className="mg-btn ghost sm keep" onClick={print}>🖨 הדפסה / PDF</button>
          <button className="mg-btn ghost sm keep" onClick={csv}>⬇ אקסל</button>
          {kind === 'cust' && view && <button className="mg-btn ghost sm keep" onClick={mail}>✉ שלח ללקוח</button>}
        </>}
      </div>
      {kind !== 'tb' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,300px) 1fr', gap: 14, alignItems: 'start' }} className="ledger-grid">
          <div data-tour="ledger-list" className="mg-card" style={{ padding: 10, maxHeight: 560, overflow: 'auto' }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'acc' ? 'חיפוש חשבון' : 'חיפוש שם או ח.פ.'} style={{ marginBottom: 8 }} />
            {shown.map(x => (
              <button key={x.key} className={'ledger-item' + (sel === x.key ? ' on' : '')} onClick={() => setSel(x.key)}>
                <span>{x.name}</span>{x.bal != null && Math.abs(x.bal) >= 0.005 && <b className={x.bal > 0 ? 'owe' : ''}>{fmt(x.bal)}</b>}
              </button>))}
            {!shown.length && <div className="mg-empty" style={{ fontSize: 14 }}>{kind === 'cust' ? 'אין עדיין מסמכים ללקוחות.' : kind === 'supp' ? 'אין הוצאות משויכות לספקים.' : 'אין תנועות.'}</div>}
          </div>
          <div data-tour="ledger-table">
            {!view ? <div className="mg-empty">בחר {kind === 'cust' ? 'לקוח' : kind === 'supp' ? 'ספק' : 'חשבון'} מהרשימה.</div> : <>
              <div className="mg-stats" style={{ marginBottom: 12 }}>
                <div className="mg-stat"><div className="lb">יתרת פתיחה</div><div className="vl" style={{ fontSize: 20 }}>{balText(view.open)}</div></div>
                <div className="mg-stat"><div className="lb">חובה בתקופה</div><div className="vl" style={{ fontSize: 20 }}>{fmt(view.dr)}</div></div>
                <div className="mg-stat"><div className="lb">זכות בתקופה</div><div className="vl" style={{ fontSize: 20 }}>{fmt(view.cr)}</div></div>
                <div className="mg-stat"><div className="lb">{kind === 'cust' ? (view.close > 0.005 ? 'הלקוח חייב' : 'יתרת סגירה') : 'יתרת סגירה'}</div><div className="vl" style={{ fontSize: 20 }}>{balText(view.close)}</div></div>
              </div>
              <div className="mg-tblwrap"><table className="mg-tbl">
                <thead><tr>{HEAD.map(h => <th key={h.t}>{h.t}</th>)}</tr></thead>
                <tbody>{lines.map((r, i) => <tr key={i} style={i === 0 ? { background: '#faf6ee' } : null}>{r.map((c, j) => <td key={j} style={j >= 3 ? { whiteSpace: 'nowrap' } : null}>{c}</td>)}</tr>)}</tbody>
                <tfoot><tr>{foot.map((c, j) => <td key={j}>{c}</td>)}</tr></tfoot>
              </table></div>
              {kind === 'supp' && <div className="mg-note" style={{ marginTop: 10 }}>הוצאות נרשמות כשהן משולמות, ולכן כל הוצאה מופיעה גם כחשבון וגם כתשלום.</div>}
              {kind === 'acc' && <div className="mg-note" style={{ marginTop: 10 }}>מתוך פקודות היומן של המסמכים האמיתיים, ההכנסות וההוצאות: אותן פקודות שנכנסות לקובץ המבנה האחיד.</div>}
            </>}
          </div>
        </div>
      )}
      {tb && (
        <div data-tour="ledger-tb">
          <div className="mg-tblwrap"><table className="mg-tbl">
            <thead><tr><th>חשבון</th><th>שם</th><th>קבוצה</th><th>חובה</th><th>זכות</th><th>יתרה</th></tr></thead>
            <tbody>{tb.rows.map(r => (
              <tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => { setKind('acc'); setSel(r.key); }}>
                <td dir="ltr" style={{ textAlign: 'right' }}>{r.key}</td><td>{r.name}</td><td>{r.group}</td><td>{fmt(r.dr)}</td><td>{fmt(r.cr)}</td><td>{balText(r.bal)}</td></tr>))}
              {!tb.rows.length && <tr><td colSpan={6}><div className="mg-empty">אין תנועות בתקופה.</div></td></tr>}</tbody>
            <tfoot><tr><td></td><td>סה״כ</td><td></td><td>{fmt(tb.dr)}</td><td>{fmt(tb.cr)}</td><td>{Math.abs(tb.dr - tb.cr) < 0.02 ? '✓ מאוזן' : balText(r2(tb.dr - tb.cr))}</td></tr></tfoot>
          </table></div>
          <div className="mg-note" style={{ marginTop: 10 }}>תנועות התקופה בכל חשבון. לחיצה על שורה פותחת את הכרטסת שלו.</div>
        </div>
      )}
    </>
  );
}

/* ============================================================ payment pages */
/* A link the customer pays by card (Z-Credit). The server makes the page,
   and when the charge is confirmed it issues the tax invoice-receipt (or a
   receipt, for an exempt dealer), signs it and e-mails it — see
   netlify/lib/pay.mjs. Here: making the link, sending it, following it. */
const PAY_STATUS = { open: ['ממתין לתשלום', 'warn'], paid: ['שולם', 'ok'], cancelled: ['בוטל', ''], mismatch: ['סכום שונה · לבדוק', 'bad'] };
const payText = (book, p) => `שלום ${p.customer?.name || ''},\nקישור לתשלום ל-${book.legalName || book.name} על סך ${fmt(p.total)}:\n${p.link}\nהחשבונית תישלח אליך מיד אחרי התשלום.`;

function PayForm({ book, docs, customers = [], items = [], onCreated, onClose, flash, payOk = null, preset = null }) {
  /* Which company clears this page: the one set up, or the business's choice
     when both are. */
  const provs = [payOk?.zcredit && ['zcredit', 'זד קרדיט'], payOk?.upay && ['upay', 'יופיי']].filter(Boolean);
  /* Editing an open page: the same details, as a new page that replaces it. */
  const [provider, setProvider] = useState(preset?.provider && provs.some(x => x[0] === preset.provider) ? preset.provider : provs[0]?.[0] || 'zcredit');
  const rate = rateOf(book);
  const [cust, setCust] = useState(() => preset?.customer ? { name: '', taxId: '', phone: '', email: '', address: '', ...preset.customer } : { name: '', taxId: '', phone: '', email: '', address: '' });
  const [incl, setIncl] = useState(preset ? preset.incl !== false : true);
  const [lines, setLines] = useState(() => preset?.lines?.length ? preset.lines.map(l => ({ ...l })) : [{ desc: '', qty: 1, price: '' }]);
  const [maxPayments, setMax] = useState(preset?.maxPayments || 1);
  const [note, setNote] = useState(preset?.note || '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const known = useMemo(() => {
    const m = {}; docs.forEach(d => { if (d.customer?.name) m[d.customer.name] = d.customer; });
    customers.forEach(c => { if (c.name) m[c.name] = { name: c.name, taxId: c.taxId || '', address: [c.address, c.city].filter(Boolean).join(', '), phone: c.phone || '', email: c.email || '' }; });
    return m;
  }, [docs, customers]);
  const pickName = (name) => setCust(c => known[name] ? { ...known[name] } : known[c.name] ? { name, taxId: '', address: '', phone: '', email: '' } : { ...c, name });
  const active = items.filter(x => x.active !== false);
  const pickItem = (i, v) => {
    const it = active.find(x => x.name === v);
    setLines(ls => ls.map((l, j) => j !== i ? l : it ? { ...l, desc: it.name, price: itemPrice(it, incl, rate), itemId: it.id, sku: it.sku || '' } : { ...l, desc: v, itemId: l.desc === v ? l.itemId : '' }));
  };
  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const tot = docTotals(lines, incl, rate);
  const ok = String(cust.name).trim() && lines.some(l => String(l.desc).trim() && Number(l.qty) > 0 && Number(l.price) > 0) && tot.total > 0;
  const create = async () => {
    setBusy(true);
    try {
      const r = await fnCall({ action: 'pay-create', book: book.id, provider, customer: cust, incl, maxPayments, note,
        lines: lines.filter(l => String(l.desc).trim() && Number(l.qty) > 0 && Number(l.price) > 0).map(l => ({ desc: String(l.desc).trim(), qty: Number(l.qty), price: r2(l.price), itemId: l.itemId || '', sku: l.sku || '' })) });
      onCreated(r.payreq, cust); setDone(r.payreq);
    } catch (e) { flash(e.message === 'no-zcredit' ? 'לעסק הזה עוד לא הוגדר מפתח זד קרדיט (גיבוי וענן ← דפי סליקה)'
      : e.message === 'no-upay' ? 'לעסק הזה עוד לא הוגדרו פרטי יופיי (גיבוי וענן ← דפי סליקה)' : 'יצירת הקישור נכשלה · ' + e.message); }
    setBusy(false);
  };
  if (done) return (
    <Box title="הקישור לתשלום מוכן" onClose={onClose}
         footer={<button className="mg-btn ghost" onClick={onClose}>סגור</button>}>
      <p style={{ marginTop: 0 }}><b>{done.customer.name}</b> · {fmt(done.total)}{done.maxPayments > 1 ? ` · עד ${done.maxPayments} תשלומים` : ''}</p>
      <input dir="ltr" readOnly value={done.link} onFocus={e => e.target.select()} />
      <div style={{ ...row, marginTop: 12 }}>
        <button className="mg-btn" onClick={() => { navigator.clipboard?.writeText(done.link); flash('הקישור הועתק'); }}>העתק קישור</button>
        <a className="mg-btn ghost" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone(done.customer.phone)}?text=${encodeURIComponent(payText(book, done))}`}>וואטסאפ</a>
        <a className="mg-btn ghost" href={`mailto:${done.customer.email || ''}?subject=${encodeURIComponent('תשלום · ' + (book.legalName || book.name))}&body=${encodeURIComponent(payText(book, done))}`}>מייל</a>
        <a className="mg-btn ghost" target="_blank" rel="noreferrer" href={done.link}>פתח</a>
      </div>
      <div className="mg-note" style={{ marginTop: 12 }}>
        כשהלקוח משלם, תופק לבד {DOC_TYPES[done.docType]?.label || 'חשבונית'}{docSeries(book) === 'test' ? ' (מצב ניסיון: מספר T-)' : ''}, חתומה, ותישלח {done.customer.email ? `ל-${done.customer.email}` : 'ללקוח אם הזין אימייל בדף התשלום'}. תקבל על כך מייל.</div>
    </Box>
  );
  return (
    <Box title={preset ? 'עריכת דף סליקה' : 'דף סליקה חדש'} onClose={onClose} wide
         footer={<><button className="mg-btn" disabled={busy || !ok} onClick={create}>{busy ? 'יוצר…' : `צור קישור לתשלום · ${fmt(tot.total)}`}</button>
      {preset && <div className="mg-note warn" style={{ marginBottom: 12, fontSize: 14 }}>בשמירה נוצר קישור חדש עם הפרטים המעודכנים, והקישור הקודם מבוטל. שלח ללקוח את הקישור החדש.</div>}
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      {provs.length > 1 && (
        <div style={{ ...row, marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>סליקה דרך:</b>
          {provs.map(([id, n]) => <button key={id} type="button" className={'mg-btn sm' + (provider === id ? '' : ' ghost')} onClick={() => setProvider(id)}>{n}</button>)}
        </div>)}
      <div style={grid}>
        <Field label="שם הלקוח *"><input list="tz-pay-known" value={cust.name} onChange={e => pickName(e.target.value)} />
          <datalist id="tz-pay-known">{Object.keys(known).map(n => <option key={n} value={n} />)}</datalist></Field>
        <Field label="אימייל (לשם תישלח החשבונית)"><input dir="ltr" value={cust.email} onChange={e => setCust(c => ({ ...c, email: e.target.value }))} /></Field>
        <Field label="טלפון (לוואטסאפ)"><input dir="ltr" value={cust.phone} onChange={e => setCust(c => ({ ...c, phone: e.target.value }))} /></Field>
        <Field label="ח.פ. / ת.ז."><input dir="ltr" value={cust.taxId} onChange={e => setCust(c => ({ ...c, taxId: e.target.value }))} /></Field>
      </div>
      <h4 style={{ margin: '16px 0 6px' }}>על מה משלמים</h4>
      <div className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>פריט</th><th style={{ width: 80 }}>כמות</th><th style={{ width: 120 }}>מחיר ליחידה</th><th style={{ width: 100 }}>סה״כ</th><th style={{ width: 40 }}></th></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td><input list={active.length ? 'tz-pay-items' : undefined} value={l.desc} onChange={e => pickItem(i, e.target.value)} placeholder={active.length ? 'בחר פריט או הקלד' : 'טיפול'} /></td>
            <td><input inputMode="decimal" value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} /></td>
            <td><input inputMode="decimal" value={l.price} onChange={e => setLine(i, 'price', e.target.value)} /></td>
            <td>{fmt((Number(l.qty) || 0) * (Number(l.price) || 0))}</td>
            <td>{lines.length > 1 && <button className="mg-btn ghost sm" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>×</button>}</td>
          </tr>))}</tbody></table></div>
      {active.length > 0 && <datalist id="tz-pay-items">{active.map(x => <option key={x.id} value={x.name}>{fmt(itemPrice(x, incl, rate))}</option>)}</datalist>}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button className="mg-btn ghost sm" onClick={() => setLines(ls => [...ls, { desc: '', qty: 1, price: '' }])}>＋ שורה</button>
        {rate > 0 && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={incl} onChange={e => setIncl(e.target.checked)} />המחירים כוללים מע״מ</label>}
      </div>
      <div style={{ ...grid, marginTop: 12 }}>
        <Field label="תשלומים בכרטיס"><select value={maxPayments} onChange={e => setMax(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n === 1 ? 'תשלום אחד' : `עד ${n} תשלומים`}</option>)}</select></Field>
        <Field label="הערה (תופיע בחשבונית)"><input value={note} onChange={e => setNote(e.target.value)} /></Field>
      </div>
      <div className="mg-note" style={{ marginTop: 12 }}>
        {rate > 0 && <>לפני מע״מ <b>{fmt(tot.net)}</b> · מע״מ {rate}% <b>{fmt(tot.vat)}</b> · </>}לתשלום <b>{fmt(tot.total)}</b>.
        {' '}אחרי התשלום תופק {rate > 0 ? 'חשבונית מס קבלה' : 'קבלה'} ותישלח ללקוח חתומה.</div>
    </Box>
  );
}

function PayList({ book, list, onCancel, onRefresh, flash, ro, onEdit }) {
  const [all, setAll] = useState(false);
  const sorted = [...list].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const shown = all ? sorted : sorted.filter(p => p.status === 'open' || p.status === 'mismatch' || Date.now() - Date.parse(p.paidAt || p.createdAt) < 3 * 86400000).slice(0, 20);
  const open = list.filter(p => p.status === 'open').length;
  const [busy, setBusy] = useState('');
  /* uPay without a key: its report waits here for the business's word. */
  const confirm = async (p) => {
    if (!window.confirm(`לאשר שהתשלום של ${p.customer?.name || ''} (${fmt(p.total)}) נראה במסוף של יופיי, ולהפיק ולשלוח את החשבונית?`)) return;
    setBusy(p.id);
    try { const r = await fnCall({ action: 'pay-confirm', book: book.id, pay: p.id });
          flash(r.ok === false ? 'לא הופקה · ' + (r.error === 'amount' ? 'הסכום לא תואם' : r.error) : 'החשבונית הופקה ונשלחה'); onRefresh(); }
    catch (e) { flash('האישור נכשל · ' + e.message); }
    setBusy('');
  };
  /* While something is waiting to be paid, look again now and then. */
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') onRefresh(); }, 20000);
    return () => clearInterval(t);
  }, [open]);
  if (!list.length) return null;
  return (
    <div data-tour="docs-pay" className="mg-card" style={{ marginBottom: 14, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, flex: 1 }}>דפי סליקה {open ? <span className="mg-chip warn">{open} ממתינים</span> : null}</h3>
        <button className="mg-btn ghost sm keep" onClick={onRefresh}>↻ רענון</button>
        {sorted.length > shown.length || all ? <button className="mg-btn ghost sm keep" onClick={() => setAll(!all)}>{all ? 'רק אחרונים' : `הכול (${list.length})`}</button> : null}
      </div>
      <div className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr><th>נוצר</th><th>לקוח</th><th>סכום</th><th>מצב</th><th></th></tr></thead>
        <tbody>{shown.map(p => { const [lb, tone] = PAY_STATUS[p.status] || [p.status, '']; return (
          <tr key={p.id}>
            <td>{heDate((p.createdAt || '').slice(0, 10))}</td>
            <td><b>{p.customer?.name}</b>{p.opens ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>נפתח {p.opens} פעמים</div> : null}</td>
            <td>{fmt(p.total)}{p.maxPayments > 1 ? <span style={{ fontSize: 12, color: 'var(--muted)' }}> · עד {p.maxPayments} תש׳</span> : ''}</td>
            <td><span className={'mg-chip ' + tone}>{lb}{p.status === 'paid' && p.docNo ? ` · ${DOC_TYPES[p.docType]?.short || ''} ${p.docNo}` : ''}</span>
              {p.status === 'open' && p.upReport && <div className="mg-chip warn" style={{ marginTop: 4 }}>יופיי דיווח: שולם{p.upReport.amount != null && Math.abs(p.upReport.amount - p.total) > 0.011 ? ` (${fmt(p.upReport.amount)})` : ''}</div>}
              {(p.extraPayments || []).length > 0 && <div className="mg-chip bad" style={{ marginTop: 4 }}>שולם פעמיים · לזכות</div>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{p.status === 'open' && p.upReport && !ro && <><button className="mg-btn sm" disabled={busy === p.id} onClick={() => confirm(p)}>אישור והפקת חשבונית</button>{' '}</>}
              {p.status === 'open' && <>
              <button className="mg-btn ghost sm keep" onClick={() => { navigator.clipboard?.writeText(p.link); flash('הקישור הועתק'); }}>קישור</button>{' '}
              <a className="mg-btn ghost sm keep" target="_blank" rel="noreferrer" href={`https://wa.me/${waPhone(p.customer?.phone)}?text=${encodeURIComponent(payText(book, p))}`}>וואטסאפ</a>{' '}
              {!ro && onEdit && <button className="mg-btn ghost sm" onClick={() => onEdit(p)}>✎ ערוך</button>}{' '}
              {!ro && <button className="mg-btn ghost sm" onClick={() => onCancel(p)}>בטל</button>}</>}</td>
          </tr>); })}</tbody></table></div>
    </div>
  );
}

/* Settings: the server's key to the database, and each business's Z-Credit key. */
function PayCard({ server, books, user, flash, onServer }) {
  const mine = books.filter(b => (b.owners || []).includes(String(user.email || '').toLowerCase()));
  const [st, setSt] = useState({});
  const [keys, setKeys] = useState({});
  const [ups, setUps] = useState({});          // uPay: { [book]: { email, key } }
  const [busy, setBusy] = useState('');
  const admin = !!server?.pay?.admin;
  const saveUp = async (b, clear) => {
    setBusy('up:' + b.id);
    const u = ups[b.id] || {};
    try { await fnCall({ action: 'up-key', book: b.id, email: clear ? '' : (u.email || st[b.id]?.upayEmail || ''), key: clear ? '' : u.key || '' });
          setUps(x => ({ ...x, [b.id]: {} })); flash(clear ? 'פרטי יופיי הוסרו' : 'פרטי יופיי נשמרו'); load(); }
    catch (e) { flash('השמירה נכשלה · ' + (e.message === 'key' ? 'צריך אימייל תקין (ומפתח, אם יש, של 6 תווים לפחות)' : e.message)); }
    setBusy('');
  };
  const load = () => mine.forEach(b => fnCall({ action: 'pay-status', book: b.id }).then(r => setSt(x => ({ ...x, [b.id]: r }))).catch(() => {}));
  useEffect(() => { if (cloud && admin) load(); }, [admin, books.length]);
  const uploadSA = async (file) => {
    setBusy('sa');
    try { const r = await fnCall({ action: 'sa', json: await file.text() }); flash(`מפתח השירות נשמר בשרת (${r.project})`); onServer?.(); }
    catch (e) { flash('ההעלאה נכשלה · ' + e.message); }
    setBusy('');
  };
  const saveKey = async (b, clear) => {
    setBusy(b.id);
    try { await fnCall({ action: 'zc-key', book: b.id, key: clear ? '' : keys[b.id] || '' }); setKeys(k => ({ ...k, [b.id]: '' })); flash(clear ? 'המפתח הוסר' : 'מפתח זד קרדיט נשמר'); load(); }
    catch (e) { flash('השמירה נכשלה · ' + e.message); }
    setBusy('');
  };
  return (
    <div data-tour="set-pay" className="mg-card">
      <h3 style={{ marginTop: 0 }}>דפי סליקה · זד קרדיט ויופיי</h3>
      {!server ? <p style={{ marginTop: 0 }}>זמין רק בהתקנה מ-GitHub, עם שרת.</p> : !cloud ? <p style={{ marginTop: 0 }}>צריך להיות מחובר לענן.</p> : <>
        <p style={{ marginTop: 0, fontSize: 14 }}>שולחים ללקוח קישור, הוא משלם בכרטיס, ומיד מופקת חשבונית מס קבלה חתומה ונשלחת אליו. שני דברים מגדירים פעם אחת:</p>
        <div style={{ padding: '8px 0', borderBottom: '1px solid #f0ebe0' }}>
          <b>1. מפתח שירות של Firebase</b> {admin ? <span className="mg-chip ok">מוגדר</span> : <span className="mg-chip warn">חסר</span>}
          <div style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 8px', lineHeight: 1.7 }}>
            כדי שהשרת יוכל להפיק את המסמך גם כשהמערכת סגורה. ב-Firebase: גלגל השיניים ← Project settings ← <span dir="ltr">Service accounts</span> ← <span dir="ltr">Generate new private key</span>, ומעלים כאן את הקובץ שירד. הוא נשמר רק בשרת שלך. אחרי ההעלאה כדאי למחוק אותו מהמחשב.</div>
          <label className="mg-btn ghost sm" style={{ cursor: 'pointer' }}>{busy === 'sa' ? 'מעלה…' : admin ? 'החלף קובץ' : '⬆ העלה קובץ JSON'}
            <input type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadSA(f); }} /></label>
        </div>
        <div style={{ padding: '8px 0' }}>
          <b>2. מפתח זד קרדיט לכל עסק</b>
          <div style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 8px', lineHeight: 1.7 }}>המפתח של המסוף לעמוד סליקה (WebCheckout). אם לא מוצאים אותו בממשק של זד קרדיט, מבקשים מהתמיכה שלהם "מפתח WebCheckout" למסוף.</div>
          {!admin ? <div className="mg-empty">קודם מעלים את מפתח השירות.</div> : mine.map(b => (
            <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', flexWrap: 'wrap' }}>
              <b style={{ minWidth: 110 }}>{b.name}</b>
              {st[b.id]?.zcredit ? <span className="mg-chip ok">מוגדר</span> : <span className="mg-chip">לא מוגדר</span>}
              <input dir="ltr" type="text" autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 160, WebkitTextSecurity: 'disc' }} placeholder={st[b.id]?.zcredit ? 'מפתח חדש להחלפה' : 'מפתח WebCheckout'} value={keys[b.id] || ''} onChange={e => setKeys(k => ({ ...k, [b.id]: e.target.value }))} />
              <button className="mg-btn sm" disabled={busy === b.id || (keys[b.id] || '').trim().length < 8} onClick={() => saveKey(b)}>שמור</button>
              {st[b.id]?.zcredit && <button className="mg-btn ghost sm" disabled={busy === b.id} onClick={() => saveKey(b, true)}>הסר</button>}
            </div>))}
          <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid #f0ebe0' }}>
            <b>3. יופיי (uPay) לכל עסק · רשות</b>
            <div style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 8px', lineHeight: 1.7 }}>מספיק האימייל של חשבון יופיי. הלקוח משלם בטופס של יופיי עם הסכום של הדף; כשיופיי מדווח שהתשלום עבר, מקבלים מייל, ובלחיצה על "אישור והפקת חשבונית" ליד דף הסליקה היא מופקת ונשלחת. מי שיש לו גם מפתח API מיופיי (לא חובה) יכול להוסיף אותו, ואז החשבונית מופקת לבד אחרי בדיקה מול יופיי. כשמוגדרים גם זד קרדיט וגם יופיי, בוחרים בכל דף סליקה דרך מי.</div>
            {!admin ? <div className="mg-empty">קודם מעלים את מפתח השירות.</div> : mine.map(b => (
              <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', flexWrap: 'wrap' }}>
                <b style={{ minWidth: 110 }}>{b.name}</b>
                {st[b.id]?.upay ? <span className="mg-chip ok">מוגדר · {st[b.id].upayEmail}{st[b.id].upayKey ? ' · עם מפתח' : ''}</span> : <span className="mg-chip">לא מוגדר</span>}
                <input dir="ltr" type="email" autoComplete="off" style={{ flex: 1, minWidth: 150 }} placeholder="אימייל חשבון יופיי"
                       value={ups[b.id]?.email ?? ''} onChange={e => setUps(x => ({ ...x, [b.id]: { ...(x[b.id] || {}), email: e.target.value } }))} />
                <input dir="ltr" type="text" autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 150, WebkitTextSecurity: 'disc' }} placeholder={st[b.id]?.upayKey ? 'מפתח חדש להחלפה' : 'מפתח API (לא חובה)'}
                       value={ups[b.id]?.key || ''} onChange={e => setUps(x => ({ ...x, [b.id]: { ...(x[b.id] || {}), key: e.target.value } }))} />
                <button className="mg-btn sm" disabled={busy === 'up:' + b.id || !(ups[b.id]?.email || (ups[b.id]?.key || '').trim()) || !/@/.test(ups[b.id]?.email || st[b.id]?.upayEmail || '')} onClick={() => saveUp(b)}>שמור</button>
                {st[b.id]?.upay && <button className="mg-btn ghost sm" disabled={busy === 'up:' + b.id} onClick={() => saveUp(b, true)}>הסר</button>}
              </div>))}
          </div>
          {admin && Object.values(st).some(x => x && (!x.mail || !x.sign)) && <div className="mg-note warn" style={{ marginTop: 8 }}>
            כדי שהחשבונית תישלח ללקוח לבד צריך בשרת גם תעודת חתימה וגם הגדרות מייל (SMTP). בלעדיהן המסמך מופק, אבל שולחים אותו ידנית.</div>}
        </div>
      </>}
    </div>
  );
}

/* ==================================================================== items */
/* Products and services of a business, to pick in a document or a payment
   page instead of typing. A price is kept as typed, with a flag saying
   whether it includes VAT; a document with the other setting converts it. */
const ITEM_FIELDS = ['name', 'sku', 'price', 'unit', 'category', 'desc'];
const ITEM_LABELS = { name: 'שם הפריט', sku: 'מק״ט', price: 'מחיר', unit: 'יחידה', category: 'קטגוריה', desc: 'תיאור נוסף' };
const ITEM_GUESS = [
  ['name', /^(שם\s*(ה)?(פריט|מוצר|שירות)|תיאור\s*(ה)?(פריט|מוצר)|פריט|מוצר|שירות|שם|תיאור|item( name)?|product( name)?|name|description)$/i],
  ['sku', /(מק"?״?ט|מקט|קוד( ה)?פריט|ברקוד|sku|catalog|item ?code|code)/i],
  ['price', /(מחיר|price|תעריף|סכום)/i],
  ['unit', /^(?!.*\bid\b)(.*(יחידה|יח['׳]? ?מידה|unit).*)$/i],
  ['category', /(קטגוריה|סיווג|קבוצה|category|group)/i],
  ['desc', /(הערות|פירוט|תיאור מורחב|notes|details)/i],
];
function guessItemMap(headers) {
  const map = {};
  ITEM_GUESS.forEach(([k, re]) => {
    const i = headers.findIndex((h, j) => re.test(String(h || '').trim()) && !Object.values(map).includes(j));
    if (i >= 0) map[k] = i;
  });
  if (map.name === undefined) { const i = headers.findIndex((h, j) => /שם|פריט|name|item/i.test(String(h || '')) && !Object.values(map).includes(j)); if (i >= 0) map.name = i; }
  return map;
}
const normItem = (s) => String(s || '').replace(/[\s"״'׳.,·–—-]+/g, ' ').trim().toLowerCase();
const numOf = (v) => { const n = Number(String(v ?? "").replace(/[₪,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
/* The price of an item in a document whose prices are (or are not) with VAT. */
const itemPrice = (it, incl, rate) => {
  const p = Number(it?.price) || 0;
  if (!rate || !!it.incl === !!incl) return r2(p);
  return r2(incl ? p * (1 + rate / 100) : p / (1 + rate / 100));
};
function planItems(list, incoming, updatePrices) {
  const cur = [...list]; const add = [], upd = [], same = [];
  incoming.filter(x => String(x.name || '').trim()).forEach(x => {
    const hit = cur.find(y => (x.sku && y.sku && String(x.sku).trim() === String(y.sku).trim()) || (!(x.sku && y.sku) && normItem(x.name) === normItem(y.name)));
    if (!hit) {
      const n = clean({ id: uid('item'), name: String(x.name).trim(), sku: String(x.sku || '').trim(), price: r2(numOf(x.price)), incl: !!x.incl,
                        unit: String(x.unit || '').trim(), category: String(x.category || '').trim(), desc: String(x.desc || '').trim(),
                        active: true, sources: ['icount'], createdAt: new Date().toISOString() });
      cur.push(n); add.push(n);
    } else {
      const m = { ...hit };
      ['sku', 'unit', 'category', 'desc'].forEach(k => { const v = String(x[k] ?? '').trim(); if (v && !String(m[k] ?? '').trim()) m[k] = v; });
      if ((updatePrices || !Number(m.price)) && numOf(x.price) && (r2(numOf(x.price)) !== r2(m.price) || !!m.incl !== !!x.incl)) { m.price = r2(numOf(x.price)); m.incl = !!x.incl; }
      const changed = JSON.stringify(m) !== JSON.stringify(hit);
      if (changed) { cur[cur.indexOf(hit)] = m; upd.push(m); } else same.push(hit);
    }
  });
  return { add, upd, same, all: cur };
}

function ItemImport({ list, col, rate, flash, onDone, onClose }) {
  const [rows, setRows] = useState(null);
  const [head, setHead] = useState(0);
  const [map, setMap] = useState({});
  const [incl, setIncl] = useState(true);
  const [updPrices, setUpdPrices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [extra, setExtra] = useState({});
  const load = async (file) => {
    setErr(''); setRows(null);
    try {
      /* An Excel file may have several sheets (iCount: Inventory, Types, Measurement Units…):
         the items are on the biggest; the small ones name the ids it refers to. */
      const sheets = /\.xlsx?$/i.test(file.name) ? await readWorkbook(file) : [{ name: '', rows: await readTable(file) }];
      const main = [...sheets].sort((a, b) => b.rows.length - a.rows.length)[0];
      const r = main?.rows || [];
      if (!r.length) throw new Error('הקובץ ריק');
      const h = Math.max(0, r.slice(0, 10).findIndex(x => Object.keys(guessItemMap(x)).length >= 2));
      const m = guessItemMap(r[h]);
      const hd = r[h].map(x => String(x || '').trim());
      const col = (re) => { const i = hd.findIndex(x => re.test(x)); return i >= 0 ? i : undefined; };
      const lookup = (re) => { const sh = sheets.find(x => re.test(x.name)); return sh ? Object.fromEntries(sh.rows.slice(1).filter(x => x[0] !== '' && x[1]).map(x => [String(Number(x[0]) || x[0]), String(x[1]).trim()])) : {}; };
      setExtra({ inclCol: col(/^(includes vat|כולל מע.?מ)$/i), exemptCol: col(/^(vat exempt|פטור ממע.?מ)$/i), delCol: col(/^(is_deleted|נמחק)$/i),
                 barcodeCol: col(/^(ברקוד|barcode)$/i), typeCol: col(/^type id$/i), unitIdCol: col(/^measurement unit id$/i),
                 types: lookup(/^types$/i), units: lookup(/^measurement units$/i) });
      setRows(r); setHead(h); setMap(m);
      const ph = m.price !== undefined ? String(r[h][m.price] || '') : '';
      setIncl(/(לפני|ללא|בלי|without|excl|net)/i.test(ph) ? false : /(כולל|incl|gross)/i.test(ph) ? true : rate > 0 ? false : true);
    } catch (e) { setErr(e.message || String(e)); }
  };
  const headers = rows ? rows[head] || [] : [];
  const incoming = useMemo(() => rows ? rows.slice(head + 1).filter(r => extra.delCol === undefined || !['1', 'true', 'TRUE'].includes(String(r[extra.delCol]).trim())).map(r => {
    const x = { incl }; Object.entries(map).forEach(([k, i]) => { if (i !== '' && i != null) x[k] = String(r[i] ?? '').trim(); });
    /* Per row, when the file says it: price with VAT or without. */
    if (extra.inclCol !== undefined) x.incl = String(r[extra.inclCol]).trim() === '1' || /^(true|כן|yes)$/i.test(String(r[extra.inclCol]).trim());
    if (!x.sku && extra.barcodeCol !== undefined) x.sku = String(r[extra.barcodeCol] || '').trim();
    if (!x.category && extra.typeCol !== undefined) x.category = extra.types?.[String(Number(r[extra.typeCol]) || r[extra.typeCol])] || '';
    if (!x.unit && extra.unitIdCol !== undefined) x.unit = extra.units?.[String(Number(r[extra.unitIdCol]) || r[extra.unitIdCol])] || '';
    return x;
  }).filter(x => x.name) : [], [rows, head, map, incl, extra]);
  const plan = useMemo(() => rows ? planItems(list, incoming, updPrices) : null, [rows, incoming, list, updPrices]);
  const run = async () => {
    setBusy(true);
    const n = await saveCustomers(col, [...plan.add, ...plan.upd]);
    setBusy(false); flash(`נשמרו ${n} פריטים`); onDone(); onClose();
  };
  return (
    <Box title="ייבוא פריטים מ-iCount (אקסל / CSV)" onClose={onClose} wide
         footer={<>{plan && <button className="mg-btn" disabled={busy || map.name === undefined || !(plan.add.length + plan.upd.length)} onClick={run}>
                   {busy ? 'שומר…' : `ייבא ${plan.add.length} חדשים${plan.upd.length ? ` ועדכן ${plan.upd.length}` : ''}`}</button>}
                   <button className="mg-btn ghost" onClick={onClose}>סגור</button></>}>
      <p style={{ marginTop: 0 }}>ב-iCount: <b>פריטים ← ייצוא לאקסל</b>. אפשר גם CSV מכל מערכת.</p>
      <label className="mg-btn" style={{ cursor: 'pointer' }}>⬆ בחר קובץ (XLS / XLSX / CSV)
        <input type="file" accept=".xlsx,.xls,.csv,.txt" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) load(f); }} /></label>
      {err && <div className="mg-note bad" style={{ marginTop: 10 }}>{err}</div>}
      {rows && <>
        <h4 style={{ margin: '16px 0 6px' }}>איזו עמודה היא מה</h4>
        <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit,minmax(min(150px,100%),1fr))' }}>
          {ITEM_FIELDS.map(k => (
            <Field key={k} label={ITEM_LABELS[k] + (k === 'name' ? ' *' : '')}>
              <select value={map[k] ?? ''} onChange={e => setMap(m => ({ ...m, [k]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                <option value="">— לא לייבא —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `עמודה ${i + 1}`}</option>)}</select></Field>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '12px 0' }}>
          {rate > 0 && (extra.inclCol !== undefined
            ? <span style={{ fontSize: 14 }}>מע״מ: לפי העמודה "{headers[extra.inclCol]}" בקובץ, שורה שורה.</span>
            : <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={incl} onChange={e => setIncl(e.target.checked)} />המחירים בקובץ כוללים מע״מ</label>)}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={updPrices} onChange={e => setUpdPrices(e.target.checked)} />לעדכן מחיר של פריטים שכבר קיימים</label>
        </div>
        <div className="mg-tblwrap" style={{ margin: '12px 0' }}><table className="mg-tbl">
          <thead><tr>{ITEM_FIELDS.filter(k => map[k] !== undefined).map(k => <th key={k}>{ITEM_LABELS[k]}</th>)}</tr></thead>
          <tbody>{incoming.slice(0, 5).map((x, i) => <tr key={i}>{ITEM_FIELDS.filter(k => map[k] !== undefined).map(k => <td key={k}>{k === 'price' ? fmt(numOf(x[k])) : x[k]}</td>)}</tr>)}</tbody>
        </table></div>
        <div className="mg-note">{incoming.length} שורות · <b>{plan.add.length}</b> פריטים חדשים · <b>{plan.upd.length}</b> קיימים שיתעדכנו · {plan.same.length} בלי שינוי. פריט מזוהה לפי מק״ט, ובלעדיו לפי השם.</div>
      </>}
    </Box>
  );
}

function ItemForm({ rec, rate, onSave, onClose }) {
  const [f, setF] = useState(() => ({ id: uid('item'), name: '', sku: '', price: '', incl: rate > 0, unit: '', category: '', desc: '', active: true, sources: ['manual'], ...rec }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const ok = String(f.name).trim() && numOf(f.price) >= 0;
  return (
    <Box title={rec.id ? 'עריכת פריט' : 'פריט חדש'} onClose={onClose}
         footer={<><button className="mg-btn" disabled={!ok} onClick={() => onSave({ ...f, name: String(f.name).trim(), price: r2(numOf(f.price)) })}>שמור</button>
                   <button className="mg-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div style={grid}>
        <Field label="שם הפריט *"><input value={f.name} onChange={e => set('name', e.target.value)} placeholder="טיפול דיקור · 60 דקות" /></Field>
        <Field label="מחיר"><input inputMode="decimal" value={f.price} onChange={e => set('price', e.target.value)} /></Field>
        {rate > 0 && <Field label="המחיר"><select value={f.incl ? '1' : ''} onChange={e => set('incl', !!e.target.value)}>
          <option value="1">כולל מע״מ</option><option value="">לפני מע״מ</option></select></Field>}
        <Field label="מק״ט"><input dir="ltr" value={f.sku} onChange={e => set('sku', e.target.value)} /></Field>
        <Field label="יחידה"><input value={f.unit} onChange={e => set('unit', e.target.value)} placeholder="טיפול / יח׳ / שעה" /></Field>
        <Field label="קטגוריה"><input value={f.category} onChange={e => set('category', e.target.value)} /></Field>
      </div>
      <div style={{ marginTop: 12 }}><Field label="תיאור נוסף"><input value={f.desc} onChange={e => set('desc', e.target.value)} /></Field></div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginTop: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={f.active !== false} onChange={e => set('active', e.target.checked)} />פעיל (מופיע בבחירה במסמכים)</label>
    </Box>
  );
}

/* The store's catalogue into the items: public in the store (a shop's
   products are its advertising), so it is read without any login. Prices in
   the store include VAT. The ones to bring are picked from a list. */
async function storeProducts(tenant) {
  const s = await getDoc(doc(store().db, 'tenants', tenantId(tenant), 'store', 'ms:products'));
  const raw = s.exists() ? s.data().value : null;
  const list = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  return list.filter(p => p && String(p.name || '').trim()).map(p => ({
    name: String(p.name).trim(), sku: String(p.sku || p.id || '').trim(), price: r2(Number(p.salePrice || p.price) || 0), incl: true,
    category: String(p.category || '').trim(), desc: '', unit: '', hidden: p.visible === false || p.active === false }));
}
function StoreItemsImport({ book, list, col, flash, onDone, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState(() => new Set());
  const [upd, setUpd] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    storeProducts(book.tenant).then(r => { setRows(r); setPick(new Set(r.filter(x => !x.hidden).map(x => x.sku || x.name))); })
      .catch(e => setErr(String(e?.code || e?.message || e)));
  }, []);
  const keyOf = (x) => x.sku || x.name;
  const chosen = (rows || []).filter(x => pick.has(keyOf(x)));
  const plan = useMemo(() => planItems(list, chosen.map(x => ({ ...x })), upd), [list, rows, pick, upd]);
  const run = async () => {
    setBusy(true);
    const recs = [...plan.add.map(x => ({ ...x, sources: ['store'] })), ...plan.upd];
    const n = await saveCustomers(col, recs);
    setBusy(false); flash(`נשמרו ${n} פריטים מהחנות`); onDone(); onClose();
  };
  return (
    <Box title="ייבוא מוצרים מהחנות" onClose={onClose} wide
         footer={<>{rows && <button className="mg-btn" disabled={busy || !(plan.add.length + plan.upd.length)} onClick={run}>
                   {busy ? 'שומר…' : `ייבא ${plan.add.length} חדשים${plan.upd.length ? ` ועדכן ${plan.upd.length}` : ''}`}</button>}
                   <button className="mg-btn ghost" onClick={onClose}>סגור</button></>}>
      {err ? <div className="mg-note bad">לא הצלחתי לקרוא את המוצרים של החנות ({err}).</div>
      : !rows ? <div className="mg-empty">קורא את המוצרים מהחנות…</div>
      : <>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <b>{rows.length} מוצרים בחנות</b>
          <button className="mg-btn ghost sm" onClick={() => setPick(new Set(rows.map(keyOf)))}>בחר הכול</button>
          <button className="mg-btn ghost sm" onClick={() => setPick(new Set())}>נקה</button>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={upd} onChange={e => setUpd(e.target.checked)} />לעדכן מחיר של פריטים שכבר קיימים</label>
        </div>
        <div className="mg-tblwrap" style={{ maxHeight: '52vh', overflow: 'auto' }}><table className="mg-tbl">
          <thead><tr><th style={{ width: 36 }}></th><th>מוצר</th><th>מק״ט</th><th>מחיר (כולל מע״מ)</th><th>קטגוריה</th></tr></thead>
          <tbody>{rows.map(x => (
            <tr key={keyOf(x)} style={{ cursor: 'pointer', opacity: x.hidden ? .6 : 1 }} onClick={() => setPick(s0 => { const n = new Set(s0); n.has(keyOf(x)) ? n.delete(keyOf(x)) : n.add(keyOf(x)); return n; })}>
              <td data-select="1"><input type="checkbox" readOnly checked={pick.has(keyOf(x))} style={{ width: 20, height: 20 }} /></td>
              <td><b>{x.name}</b>{x.hidden ? <span className="mg-chip" style={{ marginInlineStart: 6 }}>מוסתר בחנות</span> : ''}</td>
              <td dir="ltr" style={{ textAlign: 'right' }}>{x.sku}</td><td>{fmt(x.price)}</td><td>{x.category}</td>
            </tr>))}</tbody></table></div>
        <div className="mg-note" style={{ marginTop: 10 }}>נבחרו {chosen.length} · <b>{plan.add.length}</b> חדשים · <b>{plan.upd.length}</b> קיימים שיתעדכנו · {plan.same.length} בלי שינוי. פריט מזוהה לפי מק״ט. בחנות לא משתנה דבר.</div>
      </>}
    </Box>
  );
}

function ItemsTab({ book, data, cols, patch, flash, ro, role = 'owner' }) {
  const list = data.items || [];
  const rate = rateOf(book);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [imp, setImp] = useState(false);
  const [fromStore, setFromStore] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setSel(s0 => { const n = new Set(s0); n.has(id) ? n.delete(id) : n.add(id); return n; });
  /* How often each item was sold, by its name on documents. */
  const used = useMemo(() => {
    const m = {};
    (data.documents || []).filter(d => d.series !== 'test').forEach(d => (d.lines || []).forEach(l => {
      const k = normItem(l.desc); m[k] = m[k] || { n: 0, sum: 0 }; m[k].n += Number(l.qty) || 0; m[k].sum += (Number(l.qty) || 0) * (Number(l.price) || 0);
    }));
    return m;
  }, [data.documents]);
  const shown = list.filter(x => !q || [x.name, x.sku, x.category].some(v => String(v || '').toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));
  const save = async (rec) => {
    const r = clean({ ...rec, updatedAt: new Date().toISOString() });
    try { await withTimeout(cols.items.put(r.id, r), 12000); } catch { flash('השמירה נכשלה'); return; }
    patch('items', l => [...l.filter(x => x.id !== r.id), r]); setEdit(null); flash('הפריט נשמר');
  };
  const del = async (x) => {
    if (!window.confirm(`למחוק את "${x.name}"? מסמכים שכבר הופקו לא משתנים.`)) return;
    try { await cols.items.del(x.id); patch('items', l => l.filter(y => y.id !== x.id)); flash('נמחק'); } catch { flash('המחיקה נכשלה'); }
  };
  /* Several at once: the ticked ones, or everything shown. */
  const delMany = async () => {
    const ids = [...sel].filter(id => list.some(x => x.id === id));
    if (!ids.length || !window.confirm(`למחוק ${ids.length} פריטים? מסמכים שכבר הופקו לא משתנים.`)) return;
    setBusy(true); let ok = 0;
    for (let k = 0; k < ids.length; k += 20) await Promise.all(ids.slice(k, k + 20).map(id => cols.items.del(id).then(() => ok++).catch(() => {})));
    setSel(new Set()); setBusy(false);
    const left = await cols.items.list().catch(() => null); if (left) patch('items', () => left);
    flash(`נמחקו ${ok} פריטים`);
  };
  const reload = async () => { const l = await cols.items.list().catch(() => null); if (l) patch('items', () => l); };
  return (
    <>
      <div data-tour="items-tools" style={{ ...row, marginBottom: 12 }}>
        <Field label="חיפוש"><input value={q} onChange={e => setQ(e.target.value)} placeholder="שם, מק״ט, קטגוריה" /></Field>
        <button className="mg-btn" onClick={() => setEdit({})}>＋ פריט</button>
        {role === 'owner' && shown.length > 0 && <button className="mg-btn ghost sm" onClick={() => setSel(shown.every(x => sel.has(x.id)) ? new Set() : new Set(shown.map(x => x.id)))}>
          {shown.every(x => sel.has(x.id)) ? '☐ בטל בחירה' : `☑ בחר הכול (${shown.length})`}</button>}
        {book.tenant && <button className="mg-btn ghost" onClick={() => setFromStore(true)}>🛒 ייבוא מהחנות</button>}
        <button className="mg-btn ghost" onClick={() => setImp(true)}>⬆ ייבוא מ-iCount (אקסל / CSV)</button>
        <button className="mg-btn ghost sm keep" onClick={() => downloadCSV(`items-${book.name}.csv`, [
          ['שם הפריט', 'מק״ט', 'מחיר', 'כולל מע״מ', 'יחידה', 'קטגוריה', 'תיאור נוסף', 'פעיל'],
          ...shown.map(x => [x.name, x.sku || '', x.price, x.incl ? 'כן' : 'לא', x.unit || '', x.category || '', x.desc || '', x.active === false ? 'לא' : 'כן'])])}>⬇ ייצוא</button>
      </div>
      {role === 'owner' && sel.size > 0 && (
        <div className="mg-note warn" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <b>נבחרו {sel.size} פריטים</b>
          <button className="mg-btn danger sm" disabled={busy} onClick={delMany}>{busy ? 'מוחק…' : '🗑 מחק נבחרים'}</button>
          <button className="mg-btn ghost sm" onClick={() => setSel(new Set())}>נקה בחירה</button>
        </div>)}
      <div data-tour="items-table" className="mg-tblwrap"><table className="mg-tbl">
        <thead><tr>{role === 'owner' && <th style={{ width: 36 }}><input type="checkbox" aria-label="בחר הכול" style={{ width: 20, height: 20 }}
              checked={shown.length > 0 && shown.every(x => sel.has(x.id))}
              onChange={e => setSel(e.target.checked ? new Set([...sel, ...shown.map(x => x.id)]) : new Set([...sel].filter(id => !shown.some(x => x.id === id))))} /></th>}<th>פריט</th><th>מק״ט</th><th>מחיר</th><th>קטגוריה</th><th>נמכר</th><th></th></tr></thead>
        <tbody>
          {shown.map(x => { const u = used[normItem(x.name)]; return (
            <tr key={x.id} style={x.active === false ? { opacity: .5 } : null}>
              {role === 'owner' && <td data-select="1"><input type="checkbox" aria-label={'בחר ' + x.name} style={{ width: 20, height: 20 }} checked={sel.has(x.id)} onChange={() => toggle(x.id)} /></td>}
              <td><b>{x.name}</b>{x.unit ? <span style={{ color: 'var(--muted)', fontSize: 13 }}> · {x.unit}</span> : ''}{x.desc ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>{x.desc}</div> : ''}</td>
              <td dir="ltr" style={{ textAlign: 'right' }}>{x.sku}</td>
              <td>{fmt(x.price)}{rate > 0 && <span style={{ color: 'var(--muted)', fontSize: 12 }}> {x.incl ? 'כולל מע״מ' : '+ מע״מ'}</span>}</td>
              <td>{x.category}</td>
              <td>{u ? `${r2(u.n)} · ${fmt(u.sum)}` : '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="mg-btn ghost sm" onClick={() => setEdit(x)}>עריכה</button>{' '}
                {role === 'owner' && <button className="mg-btn ghost sm" onClick={() => del(x)}>מחק</button>}</td>
            </tr>); })}
          {!shown.length && <tr><td colSpan={7}><div className="mg-empty">{list.length ? 'אין פריטים שמתאימים לחיפוש.' : `עוד אין פריטים. מוסיפים כאן, או מייבאים${book.tenant ? ' מהחנות או' : ''} מ-iCount.`}</div></td></tr>}
        </tbody></table></div>
      {edit && <ItemForm rec={edit} rate={rate} onSave={save} onClose={() => setEdit(null)} />}
      {fromStore && <StoreItemsImport book={book} list={list} col={cols.items} flash={flash} onDone={reload} onClose={() => setFromStore(false)} />}
      {imp && <ItemImport list={list} col={cols.items} rate={rate} flash={flash} onDone={reload} onClose={() => setImp(false)} />}
    </>
  );
}

/* ============================================================ small screens */
/* On a phone a wide table becomes a stack of cards: each cell shows its
   column's name beside it. The names come from the table's own header, for
   every table, as it is drawn — nothing to maintain screen by screen. */
function labelTables() {
  document.querySelectorAll('table.mg-tbl').forEach(t => {
    const hs = [...t.querySelectorAll(':scope > thead th')].map(th => th.textContent.trim());
    if (!hs.length) return;
    t.classList.add('has-labels');
    t.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr').forEach(tr => {
      let i = 0;
      [...tr.children].forEach(td => {
        const span = td.colSpan || 1;
        const lb = span === 1 ? (hs[i] || '') : '';
        if (td.getAttribute('data-label') !== lb) { if (lb) td.setAttribute('data-label', lb); else td.removeAttribute('data-label'); }
        i += span;
      });
    });
  });
}
let labelQueued = false;
new MutationObserver(() => { if (labelQueued) return; labelQueued = true; requestAnimationFrame(() => { labelQueued = false; labelTables(); }); })
  .observe(document.body, { childList: true, subtree: true, characterData: true });

/* ================================================================== mount */
const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href = 'https://fonts.googleapis.com/css2?family=Assistant:wght@400;500;600;700;800&family=Frank+Ruhl+Libre:wght@500;700&display=swap';
document.head.appendChild(fonts);
createRoot(document.getElementById('root')).render(<App />);
