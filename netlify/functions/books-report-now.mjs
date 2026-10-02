/* Tizon Finance · one report now, to the person asking (from the settings:
   "send me one now"). Only for someone logged in, about their own books. */
import { runReports } from '../reports-core.mjs';
import { realDeps } from '../reports-deps.mjs';
import { mailReady, who } from './books-mail.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  try {
    const body = await req.json().catch(() => ({}));
    const email = await who(String(body.idToken || ''));
    if (!mailReady()) return json(400, { error: 'no-mail' });
    const kind = ['daily', 'weekly', 'monthly'].includes(body.kind) ? body.kind : 'daily';
    const sent = await runReports(new Date(), realDeps(process.env.URL || new URL(req.url).origin), { email, kind });
    return json(200, { ok: true, sent: sent.length, to: email });
  } catch (e) {
    return json(e.status || 500, { error: String(e.message || e) });
  }
};
