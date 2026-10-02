/* ============================================================================
   Tizon Finance · the smart coach
   A conversation with Claude about the person's own numbers, and written
   plans by area (the clinic, the store, courses, marketing, the way out of
   the overdraft). The Anthropic key is kept only here, on the server; the
   page sends a summary of the numbers, never the records themselves.
   A model call can take longer than a plain function may run, so the page
   starts it in a background function and collects the answer when it is in.
   Everything outside (who is asking, storage, the model) comes in as deps.
   ==========================================================================*/
export const MODEL = (process.env.COACH_MODEL || 'claude-sonnet-5-5').trim();
const KEY = 'coach-key';                                    // one key for the whole installation
const fileKey = (id) => 'coach-file:' + id;
const chatKey = (e) => 'coach-chat:' + e, planKey = (e) => 'coach-plans:' + e, jobKey = (id) => 'coach-job:' + id;
const MAX_TURNS = 30;

export const SYSTEM = `אתה המאמן הפיננסי של בעל עסק קטן בישראל, בתוך מערכת הנהלת החשבונות שלו (Tizon Finance).
אתה מלווה אותו לאורך זמן: יעדים, הכנסות, הוצאות, תזרים, יציאה מאוברדרפט, הפרשות למס, שיווק ותוכניות עבודה לפי תחומים.
כללים:
- כתוב בעברית, ישיר וחם, בלי חנופה. אם יעד לא ריאלי בקצב הנוכחי, תגיד את זה עם מספרים, ותציע את הדרך הכי קרובה אליו.
- הישען על המספרים שבסיכום. אל תמציא נתונים; אם חסר משהו, שאל או אמור מה צריך להזין.
- תן צעדים קונקרטיים: מה עושים, עד מתי, וכמה זה אמור להביא או לחסוך. עדיף 3 פעולות חזקות מ-10 חלשות.
- אתה מאמן לניהול העסק. אתה לא יועץ השקעות מורשה ולא רואה חשבון: בשאלות על השקעות, הלוואות או דיווח למס, תן כיוון כללי והפנה לבנק או לרואה החשבון.
- תשובות בשיחה: קצרות (עד כ-200 מילים) אלא אם התבקשה תוכנית. תוכניות: כותרות קצרות ורשימות, עם יעד, פעולות לפי שבועות, תקציב אם רלוונטי, ואיך מודדים.`;

export const ASK_SYSTEM = `אתה העוזר שבתוך Tizon Finance, מערכת הנהלת חשבונות וחשבוניות לעסק קטן בישראל (מטפלים, קליניקה, חנות).
עונים על כל שאלה: מונחים של מס והנהלת חשבונות בישראל, איך עושים משהו במערכת ואיפה הוא נמצא, ושאלות על המספרים של העסק.
כללים:
- עברית, קצר וברור: 2 עד 6 משפטים או רשימה קצרה. בלי הקדמות.
- אם יש במערכת מסך שקשור לשאלה, סיים בשורה "איפה במערכת: …" לפי רשימת המסכים שקיבלת. אל תמציא מסכים.
- סכומים, מדרגות ותקרות של מס משתנים כל שנה: אם אתה לא בטוח בערך העדכני, אמור זאת והפנה לבדיקה מול רואה החשבון או אתר רשות המסים.
- אתה לא רואה חשבון ולא יועץ מס מורשה; בהחלטות משמעותיות המלץ לאשר מול רואה החשבון.`;

export const PLAN_AREAS = {
  clinic: 'הקליניקה (טיפולים)', store: 'החנות (מוצרים)', courses: 'קורסים והדרכות', tizon: 'Tizon Health (הפלטפורמה)',
  marketing: 'שיווק כללי לכל העסקים', debt: 'יציאה מהאוברדרפט ותזרים', costs: 'קיצוץ הוצאות',
};
const planPrompt = (area, label) => `בנה תוכנית עבודה ל-90 יום לנושא: ${label}.
היה ספציפי לעסק הזה ולמספרים שלו. ${area === 'marketing' || area === 'clinic' || area === 'store' || area === 'courses' || area === 'tizon' ? 'כלול ערוצי שיווק, מסרים ומבצע אחד לשבועיים הקרובים.' : area === 'debt' || area === 'costs' ? 'כלול מה מקצצים או דוחים, ובאיזה סדר.' : ''}
החזר JSON בלבד, בלי טקסט לפניו או אחריו ובלי גדרות קוד, במבנה הזה:
{"title":"כותרת קצרה","summary":"2-3 משפטים: איפה אנחנו עומדים עם מספרים מהסיכום, ומה הרעיון המרכזי",
 "goals":[{"when":"30 יום","goal":"יעד מדיד"},{"when":"60 יום","goal":"..."},{"when":"90 יום","goal":"..."}],
 "stages":[{"title":"שבוע 1 · ...","tasks":[{"t":"פעולה קונקרטית אחת","day":2,"detail":"איך בדיוק, כמה זה אמור להביא או לחסוך","owner":"אני"}]}],
 "measure":["מה מודדים כל שבוע, עם מספר יעד"],
 "budget":"תקציב אם רלוונטי, או מחרוזת ריקה"}
כללים: בתוך הטקסט אל תשתמש במירכאות רגילות ("); בקיצורים כתוב ״ (מע״מ, ש״ח). 4 עד 6 שלבים (שבועות 1-4 בנפרד, ואחר כך חודש 2 וחודש 3). 3 עד 6 משימות בכל שלב. "day" הוא מספר הימים מהיום (0 עד 90) שעד אליו המשימה צריכה להיות גמורה. כל משימה היא פעולה אחת שאפשר לסמן כבוצעה.`;

/* The plan as data: the model answers in JSON; anything that does not read
   as a plan is kept as text, so nothing is lost. */
/* The model's JSON, read leniently: Hebrew abbreviations written with a plain
   quote (מע"מ, ש"ח) become ״, code fences are dropped, and an answer cut off
   in the middle is closed at its last complete part. */
function readJSONLoose(raw) {
  let t = String(raw || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'); if (a < 0) return null; t = t.slice(a);
  t = t.replace(/([֐-׿])"(?=[֐-׿])/g, '$1״').replace(/([֐-׿])'(?=[֐-׿\s])/g, '$1׳');
  const tryParse = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  const b = t.lastIndexOf('}'); let j = b > 0 ? tryParse(t.slice(0, b + 1)) : undefined; if (j !== undefined) return j;
  /* Cut off: close what is open, from the last complete object backwards. */
  const closers = (s) => { const st = []; let q = false, esc = false;
    for (const c of s) { if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') q = false; continue; }
      if (c === '"') q = true; else if (c === '{') st.push('}'); else if (c === '[') st.push(']'); else if (c === '}' || c === ']') st.pop(); }
    return q ? null : st.reverse().join(''); };
  for (let i = t.length - 1, n = 0; i > 0 && n < 400; i--) {
    if (t[i] !== '}' && t[i] !== ']') continue; n++;
    const head = t.slice(0, i + 1), c = closers(head); if (c === null) continue;
    j = tryParse(head + c); if (j !== undefined) return j;
  }
  return null;
}
export function parsePlan(raw) {
  try {
    const j = readJSONLoose(raw); if (!j || typeof j !== 'object') return null;
    const str = (x, n = 600) => String(x ?? '').trim().slice(0, n);
    const stages = (Array.isArray(j.stages) ? j.stages : []).slice(0, 10).map(st => ({ title: str(st.title, 120),
      tasks: (Array.isArray(st.tasks) ? st.tasks : []).slice(0, 12).map(k => ({ t: str(k.t, 300), detail: str(k.detail), owner: str(k.owner, 40),
        day: Math.max(0, Math.min(365, Math.round(Number(k.day) || 0))) })).filter(k => k.t) })).filter(st => st.tasks.length);
    if (!stages.length) return null;
    return { title: str(j.title, 140), summary: str(j.summary, 1500), budget: str(j.budget, 600),
      goals: (Array.isArray(j.goals) ? j.goals : []).slice(0, 6).map(g => ({ when: str(g.when, 40), goal: str(g.goal, 300) })).filter(g => g.goal),
      measure: (Array.isArray(j.measure) ? j.measure : []).slice(0, 10).map(m => str(m, 300)).filter(Boolean), stages };
  } catch { return null; }
}
const planAsText = (d) => [d.summary, '', ...d.goals.map(g => `- ${g.when}: ${g.goal}`), '',
  ...d.stages.flatMap(st => ['## ' + st.title, ...st.tasks.map(k => `- ${k.t}`), '']), d.measure.length ? '## מה מודדים' : '', ...d.measure.map(m => '- ' + m)].join('\n').trim();

/* One call to the model. */
export async function askClaude({ key, system, messages, maxTokens = 1500, fetchImpl = fetch }) {
  /* An answer can come back without text: the model used up its room before
     writing (stop_reason max_tokens). Then ask again with more room, so the
     page never gets an empty plan. */
  let room = maxTokens, last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: room, system, messages }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = String(j?.error?.message || ('anthropic ' + r.status));
      const code = r.status === 401 ? 'bad-key' : /credit balance|billing|purchase credits/i.test(msg) ? 'credit'
        : r.status === 404 || /model/i.test(msg) && r.status === 400 ? 'bad-model' : r.status === 429 ? 'busy' : r.status === 529 || r.status >= 500 ? 'overloaded' : 'model';
      throw Object.assign(new Error(msg), { status: r.status === 401 ? 400 : 502, code, detail: msg });
    }
    const text = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    last = { stop: j.stop_reason, types: (j.content || []).map(x => x.type).join(',') || 'none' };
    console.log('coach answer', JSON.stringify({ ...last, chars: text.length, room }));
    if (text) return text;
    room = Math.min(32000, room * 2);
  }
  throw Object.assign(new Error('empty'), { code: 'empty', detail: `stop=${last?.stop} content=${last?.types}` });
}

const summaryText = (s) => 'סיכום המספרים העדכני מהמערכת (נכון לעכשיו):\n' + String(s || '').slice(0, 12000);

/* The quick actions (no model call). */
export async function coachAction(body, email, deps) {
  const st = deps.store;
  if (body.action === 'status') {
    const k = await st.get(KEY).catch(() => null);
    const chat = (await st.get(chatKey(email), { type: 'json' }).catch(() => null)) || [];
    const plans = (await st.get(planKey(email), { type: 'json' }).catch(() => null)) || {};
    return { keyed: !!k, model: MODEL, chat, plans };
  }
  if (body.action === 'set-key') {
    const k = String(body.key || '').trim();
    if (body.remove) { await st.delete(KEY); return { ok: true, keyed: false }; }
    if (!/^sk-ant-[\w-]{20,}$/.test(k)) throw Object.assign(new Error('key-format'), { status: 400 });
    await st.set(KEY, k);
    return { ok: true, keyed: true };
  }
  if (body.action === 'job') {
    const j = await st.get(jobKey(String(body.id || '')), { type: 'json' }).catch(() => null);
    return j || { state: 'pending' };
  }
  /* A file for the next question: an image (already shrunk in the page), a PDF, or text. Kept a day. */
  if (body.action === 'upload') {
    const mime = String(body.mime || ''), data = String(body.data || ''), name = String(body.name || 'קובץ').slice(0, 120);
    const kind = /^image\/(jpeg|png|webp|gif)$/.test(mime) ? 'image' : mime === 'application/pdf' ? 'pdf' : body.text != null ? 'text' : '';
    if (!kind) throw Object.assign(new Error('file-type'), { status: 400 });
    if (kind !== 'text' && (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 5_000_000)) throw Object.assign(new Error('file-size'), { status: 400 });
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await st.setJSON(fileKey(id), { email, kind, mime, name, data: kind === 'text' ? '' : data, text: kind === 'text' ? String(body.text).slice(0, 60000) : '', at: new Date().toISOString() });
    return { ok: true, id, kind };
  }
  if (body.action === 'clear') { await st.setJSON(chatKey(email), []); return { ok: true }; }
  if (body.action === 'del-plan') {
    const plans = (await st.get(planKey(email), { type: 'json' }).catch(() => null)) || {};
    delete plans[String(body.area || '')]; await st.setJSON(planKey(email), plans); return { ok: true, plans };
  }
  throw Object.assign(new Error('action'), { status: 400 });
}

/* The model call, in the background: a chat turn or a plan. The result is
   left under the job id for the page to collect. */
export async function coachRun(body, email, deps) {
  const st = deps.store, id = String(body.id || '');
  if (!/^[\w-]{6,60}$/.test(id)) throw Object.assign(new Error('id'), { status: 400 });
  await st.setJSON(jobKey(id), { state: 'running', at: new Date().toISOString() });
  try {
    const key = await st.get(KEY).catch(() => null);
    if (!key) throw Object.assign(new Error('no-key'), { code: 'no-key' });
    const sum = summaryText(body.summary);
    if (body.kind === 'plan') {
      const area = String(body.area || '').slice(0, 60), label = PLAN_AREAS[area] || String(body.label || area).slice(0, 120);
      const raw = await deps.ask({ key, system: SYSTEM + '\n\n' + sum, messages: [{ role: 'user', content: planPrompt(area, label) + (body.note ? '\nהערה ממני: ' + String(body.note).slice(0, 4000) : '') }], maxTokens: 8000 });
      if (!String(raw || '').trim()) throw Object.assign(new Error('empty'), { code: 'empty' });
      const data = parsePlan(raw);
      const plans = (await st.get(planKey(email), { type: 'json' }).catch(() => null)) || {};
      plans[area || label] = { label: data?.title || label, text: data ? planAsText(data) : raw, data: data || undefined, at: new Date().toISOString() };
      await st.setJSON(planKey(email), plans);
      await st.setJSON(jobKey(id), { state: 'done', kind: 'plan', area: area || label, plan: plans[area || label] });
      return;
    }
    if (body.kind === 'ask') {
      /* A one-off question from the search screen: answered, not kept in the conversation. */
      const q1 = String(body.text || '').trim().slice(0, 1500);
      if (!q1) throw Object.assign(new Error('empty'), { code: 'empty' });
      const text = await deps.ask({ key, system: ASK_SYSTEM + '\n\nמה המערכת יודעת עכשיו:\n' + String(body.summary || '').slice(0, 9000), messages: [{ role: 'user', content: q1 }], maxTokens: 1200 });
      await st.setJSON(jobKey(id), { state: 'done', kind: 'ask', text });
      return;
    }
    const q = String(body.text || '').trim().slice(0, 2000) || (Array.isArray(body.files) && body.files.length ? 'נתח את הקובץ המצורף.' : '');
    if (!q) throw Object.assign(new Error('empty'), { code: 'empty' });
    const chat = (await st.get(chatKey(email), { type: 'json' }).catch(() => null)) || [];
    /* Attached files go to the model with this question only; the conversation keeps their names. */
    const files = [];
    for (const fid of (Array.isArray(body.files) ? body.files : []).slice(0, 4)) {
      const f = await st.get(fileKey(String(fid)), { type: 'json' }).catch(() => null);
      if (f && f.email === email) files.push(f);
    }
    const blocks = files.map(f => f.kind === 'image' ? { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } }
      : f.kind === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
      : { type: 'text', text: `קובץ מצורף "${f.name}":\n${f.text}` });
    const ask = files.length ? [...blocks, { type: 'text', text: q + '\n\n(צורפו: ' + files.map(f => f.name).join(', ') + '. אם זה צילום מסך של רישום במערכת, אמור מה נראה שגוי, למה, ואיך מתקנים: באיזה מסך, איזה שדה, ומה הערך הנכון.)' }] : q;
    const msgs = [...chat.slice(-MAX_TURNS).map(m => ({ role: m.role, content: m.text })), { role: 'user', content: ask }];
    const text = await deps.ask({ key, system: SYSTEM + '\n\n' + sum, messages: msgs, maxTokens: 1500 });
    const now = new Date().toISOString();
    const next = [...chat, { role: 'user', text: q + (files.length ? `\n📎 ${files.map(f => f.name).join(', ')}` : ''), at: now }, { role: 'assistant', text, at: now }].slice(-MAX_TURNS * 2);
    for (const fid of (Array.isArray(body.files) ? body.files : [])) await st.delete(fileKey(String(fid))).catch(() => {});
    await st.setJSON(chatKey(email), next);
    await st.setJSON(jobKey(id), { state: 'done', kind: 'chat', text });
  } catch (e) {
    await st.setJSON(jobKey(id), { state: 'error', error: e.code || e.message || 'error', detail: String(e.detail || e.message || '').slice(0, 300) });
  }
}
