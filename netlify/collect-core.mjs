/* ============================================================================
   Tizon Finance · collection: who owes what and since when (aging), payment
   reminders, and standing orders (a monthly payment link).
   The same rules run in the app (App.jsx keeps a copy of agingOf) and on the
   server, every hour (netlify/functions/books-collect.mjs). Everything
   outside (the database, the mail, payment pages) comes in as deps, so the
   rules can be tested without a server.
   ==========================================================================*/
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const digits = (v) => String(v || '').replace(/\D/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/["'״׳`.,()\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
export const money = (n) => '₪' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const heDate = (d) => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
const LABEL = { 305: 'חשבונית מס', 320: 'חשבונית מס קבלה', 400: 'קבלה', 330: 'חשבונית זיכוי', CR: 'החזרת שיק', WO: 'ביטול יתרה' };
const title = (d) => `${LABEL[d.type] || 'מסמך'} ${(d.series === 'test' ? 'T-' : '') + (d.number ?? '')}`;
export const dayMs = 86400000;
export const daysBetween = (a, b) => Math.round((Date.parse(String(b).slice(0, 10) + 'T12:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T12:00:00Z')) / dayMs);
export const ilNow = (now = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, day: Number(p.day), hour: Number(p.hour), weekday: p.weekday };
};

/* Who a document is for, as one stable key. Documents that share a tax id,
   an email, a phone or a name belong to the same customer. */
const idsOf = (c = {}) => {
  const out = [], t = digits(c.taxId), e = String(c.email || '').trim().toLowerCase(), ph = digits(c.phone).slice(-9), n = norm(c.name);
  if (t.length >= 8) out.push('t:' + t);
  if (/@/.test(e)) out.push('e:' + e);
  if (ph.length === 9) out.push('p:' + ph);
  if (n) out.push('n:' + n);
  return out;
};
const RANK = { t: 0, e: 1, p: 2, n: 3 };
export function groupCustomers(docs) {
  const parent = {}, find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const A = find(a), B = find(b); if (A !== B) parent[A] = B; };
  docs.forEach(d => { const ids = idsOf(d.customer); ids.forEach(i => { if (!(i in parent)) parent[i] = i; }); for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]); });
  const members = {};
  Object.keys(parent).forEach(i => { (members[find(i)] = members[find(i)] || []).push(i); });
  const keyOf = {};
  Object.values(members).forEach(list => {
    const k = list.slice().sort((a, b) => RANK[a[0]] - RANK[b[0]] || a.localeCompare(b))[0];
    list.forEach(i => { keyOf[i] = k; });
  });
  return (c) => { const ids = idsOf(c); return ids.length ? keyOf[ids[0]] || ids[0] : ''; };
}

/* The customer's moves, as in the ledger (App.jsx customerMoves): what they
   were charged (debit) and what they paid or were credited (credit). */
function movesOf(d, exempt) {
  const wh = Number(d.withholding) || 0, out = [];
  const paid = r2((d.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0) + wh);
  if (d.type === '305' || d.type === 'CR') out.push({ dr: r2(d.total), cr: 0 });
  if (d.type === '320') { out.push({ dr: r2(d.total), cr: 0 }); if (paid) out.push({ dr: 0, cr: paid }); }
  if (d.type === '400') { if (exempt && !d.refId && !(d.allocs || []).length) out.push({ dr: r2(d.total), cr: 0 }); out.push({ dr: 0, cr: r2((Number(d.total) || 0) + wh) }); }
  if (d.type === '330' || d.type === 'WO') out.push({ dr: 0, cr: r2(d.total) });
  return out;
}

/* Aging: each customer's open balance, the oldest charges paid first, and
   what is left of each charge by its age. */
export function agingOf(docs, { today, withTest = false, exempt = false, from = '' } = {}) {
  const live = (docs || []).filter(d => d && !d.cancelled && d.customer?.name && (withTest || d.series !== 'test')
    && ['305', '320', '400', '330', 'CR', 'WO'].includes(String(d.type)));
  const key = groupCustomers(live);
  const by = {};
  live.forEach(d => {
    const k = key(d.customer); if (!k) return;
    const g = by[k] = by[k] || { key: k, customer: { ...d.customer }, debits: [], credit: 0, last: '' };
    if (String(d.date || '') >= String(g.last)) { g.last = d.date || ''; g.customer = { ...g.customer, ...Object.fromEntries(Object.entries(d.customer).filter(([, v]) => v)) }; g.customer.name = String(g.customer.name).replace(/\s+/g, ' ').trim(); }
    movesOf({ ...d, type: String(d.type) }, exempt).forEach(m => {
      if (m.dr) g.debits.push({ id: d.id, title: title(d), date: String(d.date || '').slice(0, 10), amount: m.dr });
      if (m.cr) g.credit = r2(g.credit + m.cr);
    });
  });
  const out = [];
  Object.values(by).forEach(g => {
    g.debits.sort((a, b) => a.date.localeCompare(b.date));
    let c = g.credit;
    const open = [];
    g.debits.forEach(x => { const use = Math.min(c, x.amount); c = r2(c - use); const left = r2(x.amount - use); if (left > 0.009) open.push({ ...x, left, age: Math.max(0, daysBetween(x.date, today)) }); });
    const bal = r2(open.reduce((a, x) => a + x.left, 0));
    if (bal <= 0.009) return;
    const items = from ? open.filter(x => x.date >= from) : open;
    const b = { b0: 0, b30: 0, b60: 0, b90: 0 };
    open.forEach(x => { const k = x.age <= 30 ? 'b0' : x.age <= 60 ? 'b30' : x.age <= 90 ? 'b60' : 'b90'; b[k] = r2(b[k] + x.left); });
    out.push({ key: g.key, customer: g.customer, bal, ...b, open, items, oldest: open[0]?.date || '', age: open[0]?.age || 0, credit: r2(c) });
  });
  return out.sort((a, b) => b.bal - a.bal);
}
export const agingTotals = (rows) => rows.reduce((t, r) => ({ bal: r2(t.bal + r.bal), b0: r2(t.b0 + r.b0), b30: r2(t.b30 + r.b30), b60: r2(t.b60 + r.b60), b90: r2(t.b90 + r.b90) }), { bal: 0, b0: 0, b30: 0, b60: 0, b90: 0 });

/* ---------------------------------------------------------------- reminders */
export const REMIND_DEF = { on: false, mode: 'auto', after: 7, every: 7, max: 3, min: 50, hour: 10, from: '', maxAge: 365, payLink: true, email: true, skip: [] };
export const remindCfg = (book) => ({ ...REMIND_DEF, ...(book?.remind || {}) });

/* Who should get a reminder today, and why the others will not. */
export function remindPlan(rows, cfg, log, today) {
  const skip = new Set(cfg.skip || []);
  return rows.map(r => {
    const items = r.open.filter(x => (!cfg.from || x.date >= cfg.from) && x.age <= (Number(cfg.maxAge) || 365));
    const due = r2(items.reduce((a, x) => a + x.left, 0));
    const L = log[r.key] || {};
    const oldest = items[0]?.age ?? -1;
    let why = '';
    if (skip.has(r.key)) why = 'מסומן: בלי תזכורות';
    else if (!items.length) why = cfg.from ? 'החוב מלפני תאריך ההתחלה' : 'אין חוב בטווח';
    else if (due < (Number(cfg.min) || 0)) why = `מתחת ל-${money(cfg.min)}`;
    else if (oldest < (Number(cfg.after) || 0)) why = `עוד ${(Number(cfg.after) || 0) - oldest} ימים לתזכורת הראשונה`;
    else if ((L.n || 0) >= (Number(cfg.max) || 0)) why = `נשלחו כבר ${L.n} תזכורות`;
    else if (L.pending && L.at && daysBetween(String(L.at).slice(0, 10), today) < (Number(cfg.every) || 7)) why = 'הוכנה, ממתינה לשליחה ממך';
    else if (L.last && daysBetween(L.last, today) < (Number(cfg.every) || 7)) why = `התזכורת הבאה ב-${heDate(addDays(L.last, Number(cfg.every) || 7))}`;
    else if (!r.customer.email && !r.customer.phone) why = 'אין אימייל או טלפון';
    return { ...r, items, due, n: L.n || 0, last: L.last || '', why, send: !why };
  });
}
const addDays = (iso, k) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

export function reminderText(book, r, link, n) {
  const name = book.name || 'העסק';
  const lines = r.items.map(x => `• ${x.title} מיום ${heDate(x.date)}: ${money(x.left)}`);
  const contact = [book.phone, book.email].filter(Boolean).join(' · ');
  const text = [`שלום ${r.customer.name},`, '',
    n > 0 ? `תזכורת נוספת מ${name}: עדיין פתוח חוב לתשלום.` : `זו תזכורת ידידותית מ${name}: יש חוב פתוח לתשלום.`, '',
    ...lines, '', `סה״כ לתשלום: ${money(r.due)}`, '',
    link ? `לתשלום מאובטח בכרטיס אשראי: ${link}` : 'אפשר לשלם בהעברה בנקאית, בביט או בכרטיס אשראי.',
    'אם כבר שילמת, תודה רבה, ואפשר להתעלם מההודעה.', contact ? `לשאלות: ${contact}` : '', '', 'בברכה,', name].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return { subject: `תזכורת לתשלום · ${name} · ${money(r.due)}`, text };
}
export const waLink = (phone, text) => { let d = digits(phone); if (d.startsWith('0')) d = '972' + d.slice(1); return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : ''; };

/* ---------------------------------------------------------- standing orders */
/* A monthly charge: on its day, a payment page is made and sent to the
   customer; when they pay, the receipt is issued by the payment callback. */
export function standingDue(rules, now) {
  const { month, day } = ilNow(now);
  return (rules || []).filter(r => r.active !== false && (r.startMonth || '0000-00') <= month && (!r.endMonth || r.endMonth >= month)
    && (r.lastMonth || '') < month && day >= Math.min(28, Math.max(1, Number(r.day) || 1)) && Number(r.amount) > 0 && r.customer?.name);
}
export function standingText(book, r, link, month) {
  const name = book.name || 'העסק';
  return { subject: `${r.desc || 'תשלום חודשי'} · ${name} · ${money(r.amount)}`,
    text: [`שלום ${r.customer.name},`, '', `החיוב החודשי (${monthHe(month)}) מוכן: ${r.desc || 'תשלום חודשי'}, ${money(r.amount)}.`, '',
      `לתשלום מאובטח בכרטיס אשראי: ${link}`, 'הקבלה תישלח אליך מיד אחרי התשלום.', '', 'בברכה,', name].join('\n') };
}
const HE_M = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const monthHe = (ym) => { const [y, m] = String(ym).split('-').map(Number); return `${HE_M[(m || 1) - 1]} ${y}`; };

/* ------------------------------------------------------------- the run */
/* Once an hour. Reminders go out once a day, at the business's hour, Sunday
   to Thursday; standing orders go out on their day, from 8 in the morning. */
export async function runCollect(now, deps) {
  const t = ilNow(now), sent = [];
  const books = (await deps.books()).filter(b => !b.deleted && !b.mergedInto);
  for (const book of books) {
    const cfg = remindCfg(book), standing = book.standingOn ? await deps.standing(book).catch(() => []) : [];
    const doRemind = cfg.on && t.hour === (Number(cfg.hour) || 10) && !['Fri', 'Sat'].includes(t.weekday) && !(await deps.wasDone(`remind-day:${book.id}:${t.date}`));
    const dueSt = t.hour >= 8 ? standingDue(standing, now) : [];
    if (!doRemind && !dueSt.length) continue;
    const owner = (book.reports?.to || book.owners?.[0] || '').trim();
    const report = [];

    if (doRemind) {
      await deps.markDone(`remind-day:${book.id}:${t.date}`);
      const docs = await deps.allDocs(book);
      const rows = agingOf(docs, { today: t.date, withTest: !!deps.withTest, exempt: book.dealerType === 'exempt' });
      const log = await deps.remindLog(book);
      /* A customer who paid everything starts again from zero next time. */
      for (const k of Object.keys(log)) if (!rows.some(r => r.key === k) && log[k].n) { await deps.saveRemind(book, k, null); delete log[k]; }
      const plan = remindPlan(rows, cfg, log, t.date).filter(r => r.send);
      for (const r of plan) {
        let link = '', payId = '';
        if (cfg.payLink && deps.payCreate) {
          try {
            const L = log[r.key] || {};
            if (L.payId) await deps.payCancel(book, L.payId).catch(() => {});
            const p = await deps.payCreate(book, { customer: r.customer, debt: true, debtRefs: r.items.map(x => ({ id: x.id, title: x.title, amount: x.left })),
              lines: [{ desc: 'תשלום חוב: ' + r.items.map(x => x.title).join(', ').slice(0, 150), qty: 1, price: r.due }], title: `תשלום חוב · ${r.customer.name}`, origin: 'remind' });
            link = p.link; payId = p.id;
          } catch (e) { console.warn('remind pay link', book.id, e.message); }
        }
        const msg = reminderText(book, r, link, r.n);
        let mailed = false;
        if (cfg.mode === 'auto' && cfg.email !== false && r.customer.email) {
          try { await deps.send({ to: r.customer.email, subject: msg.subject, text: msg.text, replyTo: owner || undefined }); mailed = true; } catch (e) { console.warn('remind mail', e.message); }
        }
        await deps.saveRemind(book, r.key, { n: (r.n || 0) + (mailed ? 1 : 0), last: mailed ? t.date : (r.last || ''), payId, link, due: r.due,
          name: r.customer.name, phone: r.customer.phone || '', email: r.customer.email || '', pending: !mailed, at: now.toISOString(),
          hist: [...((log[r.key] || {}).hist || []).slice(-9), { at: now.toISOString(), due: r.due, mailed, link: !!link }] });
        report.push(`${mailed ? '✉ נשלחה' : '⏳ ממתינה לשליחה ממך (וואטסאפ או מייל)'} · ${r.customer.name} · ${money(r.due)}`);
        sent.push({ book: book.id, kind: 'remind', key: r.key, mailed });
      }
    }

    for (const r of dueSt) {
      try {
        const p = await deps.payCreate(book, { customer: r.customer, lines: [{ desc: r.desc || 'תשלום חודשי', qty: 1, price: r.amount }], title: `${r.desc || 'תשלום חודשי'} · ${monthHe(t.month)}`,
          provider: r.provider, maxPayments: 1, origin: 'standing:' + r.id, note: `הוראת קבע · ${monthHe(t.month)}` });
        const msg = standingText(book, r, p.link, t.month);
        let mailed = false;
        if (r.customer.email && r.mail !== false) { try { await deps.send({ to: r.customer.email, subject: msg.subject, text: msg.text, replyTo: owner || undefined }); mailed = true; } catch (e) { console.warn('standing mail', e.message); } }
        await deps.saveStanding(book, { ...r, lastMonth: t.month, hist: [...(r.hist || []).slice(-23), { month: t.month, payId: p.id, link: p.link, mailed, at: now.toISOString() }] });
        report.push(`🔁 ${r.customer.name} · ${money(r.amount)} · ${mailed ? 'הקישור נשלח במייל' : 'אין מייל: שלח את הקישור בוואטסאפ מהאפליקציה'}`);
        sent.push({ book: book.id, kind: 'standing', id: r.id, mailed });
      } catch (e) { report.push(`⚠ ${r.customer.name}: לא נוצר קישור (${e.message})`); console.warn('standing', book.id, r.id, e.message); }
    }

    if (report.length && owner) {
      await deps.send({ to: owner, subject: `Tizon Finance · גבייה · ${book.name}`,
        text: [`גבייה ב${book.name}, ${heDate(t.date)}:`, '', ...report, '', 'הפירוט המלא באפליקציה, בלשונית גבייה.'].join('\n') }).catch(() => {});
    }
  }
  return sent;
}
