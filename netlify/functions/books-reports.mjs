/* Tizon Finance · the reports, on a schedule. Runs every hour; each run sends
   what is due and was not sent yet (see netlify/reports-core.mjs). */
import { runReports } from '../reports-core.mjs';
import { realDeps } from '../reports-deps.mjs';
import { mailReady } from './books-mail.mjs';

export default async () => {
  if (!mailReady()) { console.log('reports: mail is not set up'); return new Response('no-mail'); }
  try {
    const sent = await runReports(new Date(), realDeps(process.env.URL || ''));
    console.log('reports sent', JSON.stringify(sent));
    return new Response(JSON.stringify({ ok: true, sent }));
  } catch (e) { console.error('reports', e); return new Response('error', { status: 500 }); }
};

export const config = { schedule: '7 * * * *' };
