/* ============================================================================
   Tizon Books · the smart coach
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
const chatKey = (e) => 'coach-chat:' + e, planKey = (e) => 'coach-plans:' + e, jobKey = (id) => 'coach-job:' + id;
const MAX_TURNS = 30;

export const SYSTEM = `אתה המאמן הפיננסי של בעל עסק קטן בישראל, בתוך מערכת הנהלת החשבונות שלו (Tizon Books).
אתה מלווה אותו לאורך זמן: יעדים, הכנסות, הוצאות, תזרים, יציאה מאוברדרפט, הפרשות למס, שיווק ותוכניות עבודה לפי תחומים.
כללים:
- כתוב בעברית, ישיר וחם, בלי חנופה. אם יעד לא ריאלי בקצב הנוכחי, תגיד את זה עם מספרים, ותציע את הדרך הכי קרובה אליו.
- הישען על המספרים שבסיכום. אל תמציא נתונים; אם חסר משהו, שאל או אמור מה צריך להזין.
- תן צעדים קונקרטיים: מה עושים, עד מתי, וכמה זה אמור להביא או לחסוך. עדיף 3 פעולות חזקות מ-10 חלשות.
- אתה מאמן לניהול העסק. אתה לא יועץ השקעות מורשה ולא רואה חשבון: בשאלות על השקעות, הלוואות או דיווח למס, תן כיוון כללי והפנה לבנק או לרואה החשבון.
- תשובות בשיחה: קצרות (עד כ-200 מילים) אלא אם התבקשה תוכנית. תוכניות: כותרות קצרות ורשימות, עם יעד, פעולות לפי שבועות, תקציב אם רלוונטי, ואיך מודדים.`;

export const PLAN_AREAS = {
  clinic: 'הקליניקה (טיפולים)', store: 'החנות (מוצרים)', courses: 'קורסים והדרכות', tizon: 'Tizon Health (הפלטפורמה)',
  marketing: 'שיווק כללי לכל העסקים', debt: 'יציאה מהאוברדרפט ותזרים', costs: 'קיצוץ הוצאות',
};
const planPrompt = (area, label) => `בנה תוכנית עבודה ל-90 יום לתחום: ${label}.
מבנה: 1) איפה אנחנו עומדים (מספרים מהסיכום), 2) יעד ל-30, 60 ו-90 יום, 3) פעולות לפי שבועות לחודש הראשון ואחר כך לפי חודשים, 4) ${area === 'marketing' || area === 'clinic' || area === 'store' || area === 'courses' || area === 'tizon' ? 'ערוצי שיווק, מסרים ומבצע אחד לשבועיים הקרובים' : 'מה מקצצים או דוחים, ובאיזה סדר'}, 5) מה מודדים כל שבוע.
היה ספציפי לעסק הזה ולמספרים שלו.`;

/* One call to the model. */
export async function askClaude({ key, system, messages, maxTokens = 1500, fetchImpl = fetch }) {
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || ('anthropic ' + r.status)), { status: r.status === 401 ? 400 : 502, code: r.status === 401 ? 'bad-key' : 'model' });
  return (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
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
      const area = String(body.area || ''), label = PLAN_AREAS[area] || String(body.label || area).slice(0, 80);
      const text = await deps.ask({ key, system: SYSTEM + '\n\n' + sum, messages: [{ role: 'user', content: planPrompt(area, label) + (body.note ? '\nהערה ממני: ' + String(body.note).slice(0, 600) : '') }], maxTokens: 3000 });
      const plans = (await st.get(planKey(email), { type: 'json' }).catch(() => null)) || {};
      plans[area || label] = { label, text, at: new Date().toISOString() };
      await st.setJSON(planKey(email), plans);
      await st.setJSON(jobKey(id), { state: 'done', kind: 'plan', area: area || label, plan: plans[area || label] });
      return;
    }
    const q = String(body.text || '').trim().slice(0, 2000);
    if (!q) throw Object.assign(new Error('empty'), { code: 'empty' });
    const chat = (await st.get(chatKey(email), { type: 'json' }).catch(() => null)) || [];
    const msgs = [...chat.slice(-MAX_TURNS).map(m => ({ role: m.role, content: m.text })), { role: 'user', content: q }];
    const text = await deps.ask({ key, system: SYSTEM + '\n\n' + sum, messages: msgs, maxTokens: 1500 });
    const now = new Date().toISOString();
    const next = [...chat, { role: 'user', text: q, at: now }, { role: 'assistant', text, at: now }].slice(-MAX_TURNS * 2);
    await st.setJSON(chatKey(email), next);
    await st.setJSON(jobKey(id), { state: 'done', kind: 'chat', text });
  } catch (e) {
    await st.setJSON(jobKey(id), { state: 'error', error: e.code || e.message || 'error' });
  }
}
