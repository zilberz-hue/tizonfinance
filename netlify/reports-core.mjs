/* ============================================================================
   Tizon Finance · business reports by email
   Three reports, each a picture of where the business stands:
     daily    every evening (20:00 Israel time by default): today's income and
              expenses, and the month so far
     weekly   Friday morning: the last seven days (Friday to Thursday), against
              the week before, and the month so far
     monthly  the 1st of the month: last month, against the month before, and
              the year so far
   One email per person, with every business they get reports for. Nothing
   here touches the database or the mail: those come in as deps, so the same
   code runs on the server and in the tests.
   ==========================================================================*/
export const IL_TZ = 'Asia/Jerusalem';
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* The date, hour and weekday (0 = Sunday) in Israel. */
export function ilNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: IL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: Number(p.hour) % 24, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
export const addDays = (iso, k) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; };
export const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const heDate = (d) => d ? d.split('-').reverse().join('/') : '';
const monthName = (ym) => `${HE_MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export const REPORT_DEFAULTS = { daily: true, weekly: true, monthly: true, hour: 20 };
export const reportCfg = (book) => ({ ...REPORT_DEFAULTS, ...(book?.reports || {}), to: String(book?.reports?.to || book?.owners?.[0] || '').toLowerCase() });

/* The report of each kind for a given day, with what it is compared to. */
export function periodsFor(kind, today) {
  const ym = today.slice(0, 7);
  if (kind === 'daily') return { kind, key: 'd:' + today, from: today, to: today, title: `דוח יומי · ${heDate(today)}`,
    ctx: [{ label: `${monthName(ym)} עד היום`, from: ym + '-01', to: today }] };
  if (kind === 'weekly') {
    /* The seven days that end on the Thursday before (or on) today. */
    const back = (new Date(today + 'T12:00:00Z').getUTCDay() + 7 - 4) % 7;
    const to = addDays(today, back === 0 ? -7 : -back), from = addDays(to, -6);
    return { kind, key: 'w:' + to, from, to, title: `דוח שבועי · ${heDate(from)} – ${heDate(to)}`,
      cmp: { label: 'שבוע קודם', from: addDays(from, -7), to: addDays(to, -7) },
      ctx: [{ label: `${monthName(to.slice(0, 7))} עד ${heDate(to)}`, from: to.slice(0, 7) + '-01', to }] };
  }
  const m = prevMonth(ym), pm = prevMonth(m);
  return { kind: 'monthly', key: 'm:' + m, from: m + '-01', to: monthEnd(m), title: `דוח חודשי · ${monthName(m)}`,
    cmp: { label: monthName(pm), from: pm + '-01', to: monthEnd(pm) },
    ctx: [{ label: `שנת ${m.slice(0, 4)} עד סוף ${HE_MONTHS[Number(m.slice(5, 7)) - 1]}`, from: m.slice(0, 4) + '-01-01', to: monthEnd(m) }] };
}

/* Which reports are due at this hour. A missed hour is caught up later the
   same day (daily) or the next day (weekly on Saturday, monthly on the 2nd). */
export function dueKinds(now, cfg) {
  const { date, hour, dow } = ilNow(now);
  const out = [];
  if (cfg.daily && hour >= (Number(cfg.hour) || 20)) out.push(periodsFor('daily', date));
  if (cfg.weekly && ((dow === 5 && hour >= 8) || dow === 6)) out.push(periodsFor('weekly', date));
  const day = Number(date.slice(8, 10));
  if (cfg.monthly && ((day === 1 && hour >= 8) || day === 2)) out.push(periodsFor('monthly', date));
  return out;
}

/* What counts as income, as in the books: invoices and invoice-receipts
   (credit notes take back), a receipt only for an exempt dealer; manual
   income records; never test documents or cancelled ones. Expenses as
   recorded, estimates marked. */
export function summarize(rows, from, to, exempt) {
  const inR = (d) => { const x = String(d || '').slice(0, 10); return x >= from && x <= to; };
  const income = [], expense = [];
  for (const d of rows.docs || []) {
    if (!inR(d.date) || d.cancelled || d.series === 'test') continue;
    const counts = ['305', '320', '330'].includes(String(d.type)) || (String(d.type) === '400' && exempt && !d.refId);
    if (!counts) continue;
    const s = String(d.type) === '330' ? -1 : 1;
    const gross = s * (Number(d.total) || 0), vat = exempt ? 0 : s * (Number(d.vat) || 0);
    income.push({ who: d.customer?.name || '', gross, vat, what: 'doc' });
  }
  for (const i of rows.incomes || []) {
    if (!inR(i.date)) continue;
    const gross = Number(i.gross) || 0, vat = exempt || i.noVat ? 0 : (i.vat != null ? Number(i.vat) || 0 : 0);
    income.push({ who: i.customer || i.desc || '', gross, vat, what: 'manual' });
  }
  for (const e of rows.expenses || []) {
    if (!inR(e.date)) continue;
    expense.push({ cat: e.cat || 'אחר', who: e.supplierName || e.desc || '', gross: Number(e.gross) || 0, vat: exempt ? 0 : Number(e.vat) || 0, estimate: !!e.estimate });
  }
  const sum = (l, k) => r2(l.reduce((a, x) => a + x[k], 0));
  const inc = { gross: sum(income, 'gross'), vat: sum(income, 'vat'), count: income.length };
  inc.net = r2(inc.gross - inc.vat);
  const exp = { gross: sum(expense, 'gross'), vat: sum(expense, 'vat'), count: expense.length, est: expense.filter(e => e.estimate).length };
  exp.net = r2(exp.gross - exp.vat);
  const top = (l, key, val, n) => { const m = {}; l.forEach(x => { const k = x[key] || '—'; m[k] = (m[k] || 0) + x[val]; });
    return Object.entries(m).map(([k, v]) => [k, r2(v)]).filter(([, v]) => Math.abs(v) > 0.004).sort((a, b) => b[1] - a[1]).slice(0, n); };
  return { inc, exp, profit: r2(inc.net - exp.net), vatDue: r2(inc.vat - exp.vat),
           topCust: top(income, 'who', 'gross', 5), byCat: top(expense, 'cat', 'gross', 6) };
}

/* ------------------------------------------------------------- the email */
const mh = (n) => `<span dir="ltr" style="unicode-bidi:isolate;white-space:nowrap">${money(n)}</span>`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const money = (n) => (r2(n) < 0 ? '-' : '') + '₪' + Math.abs(r2(n)).toLocaleString('en-US', { maximumFractionDigits: 0 });
const delta = (a, b) => { if (!b) return ''; const p = Math.round((a - b) / Math.abs(b) * 100); return p ? ` <span style="color:${p > 0 ? '#2f7d5b' : '#b3412f'};font-size:12px">${p > 0 ? '▲' : '▼'}${Math.abs(p)}%</span>` : ''; };

function tile(label, value, color, sub) {
  return `<td style="padding:6px;width:33%"><div style="background:#fffdf8;border:1px solid #eadfca;border-radius:12px;padding:12px 10px;text-align:center">
<div style="font-size:12px;color:#7a6c55">${label}</div><div style="font-size:22px;font-weight:800;color:${color}">${value}</div>${sub ? `<div style="font-size:12px;color:#7a6c55;margin-top:2px">${sub}</div>` : ''}</div></td>`;
}
function bookSection(sec, kind) {
  const s = sec.main, c = sec.cmp;
  const rows = (l, empty) => l.length ? l.map(([k, v]) => `<tr><td style="padding:5px 0;border-bottom:1px solid #f1e9da">${esc(k)}</td><td style="padding:5px 0;border-bottom:1px solid #f1e9da;text-align:left;direction:ltr;white-space:nowrap">${mh(v)}</td></tr>`).join('')
    : `<tr><td style="color:#9a8c75;padding:5px 0">${empty}</td></tr>`;
  const quiet = !s.inc.count && !s.exp.count;
  return `<div style="margin:18px 0 6px;font-size:17px;font-weight:800;color:#4a3a20">${esc(sec.name)}</div>
${quiet ? `<div style="color:#7a6c55;font-size:14px;margin-bottom:6px">לא נרשמו הכנסות או הוצאות ${kind === 'daily' ? 'היום' : 'בתקופה'}.</div>` : ''}
<table role="presentation" style="width:100%;border-collapse:collapse"><tr>
${tile('הכנסות', mh(s.inc.gross) + (c ? delta(s.inc.gross, c.inc.gross) : ''), '#2f7d5b', `${s.inc.count} תנועות`)}
${tile('הוצאות', mh(s.exp.gross) + (c ? delta(s.exp.gross, c.exp.gross) : ''), '#b3412f', `${s.exp.count} תנועות${s.exp.est ? ` · ${s.exp.est} בהערכה` : ''}`)}
${tile('רווח (לפני מע״מ)', mh(s.profit), s.profit >= 0 ? '#2f7d5b' : '#b3412f', sec.exempt ? 'עוסק פטור' : `מע״מ נטו ${mh(s.vatDue)}`)}
</tr></table>
${c ? `<div style="font-size:13px;color:#7a6c55;margin:4px 6px">${esc(c.label)}: הכנסות ${mh(c.inc.gross)} · הוצאות ${mh(c.exp.gross)} · רווח ${mh(c.profit)}</div>` : ''}
${(sec.ctx || []).map(x => `<div style="background:#f6efe2;border-radius:10px;padding:10px 12px;margin:8px 6px;font-size:14px"><b>${esc(x.label)}:</b> הכנסות ${mh(x.s.inc.gross)} · הוצאות ${mh(x.s.exp.gross)} · <b>רווח ${mh(x.s.profit)}</b>${sec.exempt ? '' : ` · מע״מ לתשלום ${mh(x.s.vatDue)}`}</div>`).join('')}
${quiet ? '' : `<table role="presentation" style="width:100%;border-collapse:collapse;margin-top:6px"><tr>
<td style="vertical-align:top;padding:6px;width:50%"><div style="font-weight:700;margin-bottom:4px">מאיפה הגיעו ההכנסות</div><table style="width:100%;border-collapse:collapse;font-size:14px">${rows(s.topCust, 'אין הכנסות')}</table></td>
<td style="vertical-align:top;padding:6px;width:50%"><div style="font-weight:700;margin-bottom:4px">על מה הלך הכסף</div><table style="width:100%;border-collapse:collapse;font-size:14px">${rows(s.byCat, 'אין הוצאות')}</table></td>
</tr></table>`}`;
}
export function reportEmail(p, sections, appUrl) {
  const all = sections.length > 1 ? (() => {
    const t = { inc: 0, exp: 0, profit: 0 }; sections.forEach(s => { t.inc += s.main.inc.gross; t.exp += s.main.exp.gross; t.profit += s.main.profit; });
    return `<div style="background:#2f5d46;color:#fff;border-radius:12px;padding:12px 14px;margin:6px 0 4px;font-size:15px">כל העסקים יחד: הכנסות <b>${mh(t.inc)}</b> · הוצאות <b>${mh(t.exp)}</b> · רווח <b>${mh(t.profit)}</b></div>`; })() : '';
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4efe6;font-family:Arial,'Segoe UI',sans-serif;color:#2c2821">
<div style="max-width:640px;margin:0 auto;padding:18px 12px" dir="rtl">
<div style="background:linear-gradient(135deg,#8a6331,#c4a36e);color:#fff;border-radius:16px;padding:18px 20px">
<div style="font-size:13px;opacity:.9">Tizon Finance</div><div style="font-size:22px;font-weight:800;margin-top:2px">${esc(p.title)}</div></div>
${all}
${sections.map(s => bookSection(s, p.kind)).join('<hr style="border:0;border-top:1px solid #eadfca;margin:16px 0">')}
<div style="margin-top:20px;text-align:center"><a href="${esc(appUrl)}" style="display:inline-block;background:#2f5d46;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700">פתח את Tizon Finance</a></div>
<div style="color:#9a8c75;font-size:12px;margin-top:16px;text-align:center;line-height:1.6">הסכומים כוללים מע״מ, והרווח לפני מע״מ. הוצאות קבועות שעוד לא הגיעה עליהן חשבונית מסומנות "בהערכה".<br>את הדוחות מפעילים ומכבים בהגדרות העסק ← דוחות במייל.</div>
</div></body></html>`;
  const lead = sections.map(s => `${s.name}: ${money(s.main.inc.gross)} הכנסות`).join(' · ');
  return { subject: `${p.title} · ${lead}`, html };
}

/* ---------------------------------------------------------------- the run */
/* deps: books() → every book; rows(book, from, to) → { docs, incomes, expenses };
   wasSent(key) / markSent(key); send({ to, subject, html }); appUrl.
   only: { email, kind } sends one report now to one person (a test), sent or not. */
export async function runReports(now, deps, only = null) {
  const books = (await deps.books()).filter(b => !b.deleted && !b.mergedInto);
  const people = {};
  for (const b of books) {
    const cfg = reportCfg(b);
    if (!cfg.to || cfg.off) continue;
    if (only && cfg.to !== only.email.toLowerCase() && !(b.owners || []).map(x => String(x).toLowerCase()).includes(only.email.toLowerCase())) continue;
    const to = only ? only.email.toLowerCase() : cfg.to;
    (people[to] = people[to] || []).push({ b, cfg });
  }
  const sent = [];
  for (const [to, list] of Object.entries(people)) {
    const kinds = {};
    for (const { b, cfg } of list) {
      const due = only ? [periodsFor(only.kind, ilNow(now).date)] : dueKinds(now, cfg);
      for (const p of due) (kinds[p.key] = kinds[p.key] || { p, books: [] }).books.push(b);
    }
    for (const { p, books: bs } of Object.values(kinds)) {
      const mark = `report:${p.key}:${to}`;
      if (!only && await deps.wasSent(mark)) continue;
      const ranges = [p, p.cmp, ...(p.ctx || [])].filter(Boolean);
      const lo = ranges.map(r => r.from).sort()[0], hi = ranges.map(r => r.to).sort().slice(-1)[0];
      const sections = [];
      for (const b of bs) {
        const rows = await deps.rows(b, lo, hi);
        const ex = b.dealerType === 'exempt';
        sections.push({ name: b.name || b.legalName || 'עסק', exempt: ex, main: summarize(rows, p.from, p.to, ex),
          cmp: p.cmp ? { label: p.cmp.label, ...summarize(rows, p.cmp.from, p.cmp.to, ex) } : null,
          ctx: (p.ctx || []).map(c => ({ label: c.label, s: summarize(rows, c.from, c.to, ex) })) });
      }
      /* A day with nothing in any business is not worth an email. */
      if (!only && p.kind === 'daily' && sections.every(s => !s.main.inc.count && !s.main.exp.count)) { await deps.markSent(mark); continue; }
      const m = reportEmail(p, sections, deps.appUrl || '');
      await deps.send({ to, subject: m.subject, html: m.html });
      if (!only) await deps.markSent(mark);
      sent.push({ to, key: p.key, books: bs.map(b => b.id) });
    }
  }
  return sent;
}
