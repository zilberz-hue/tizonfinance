/* Tizon Finance · collection, on a schedule: payment reminders once a day at
   the business's hour, and standing orders on their day (netlify/collect-core.mjs). */
import { runCollect } from '../collect-core.mjs';
import { realCollectDeps } from '../collect-deps.mjs';
import { mailReady } from './books-mail.mjs';

export default async () => {
  try {
    const sent = await runCollect(new Date(), { ...realCollectDeps(process.env.URL || ''), ...(mailReady() ? {} : { send: async () => { throw new Error('no-mail'); } }) });
    console.log('collect', JSON.stringify(sent));
    return new Response(JSON.stringify({ ok: true, sent }));
  } catch (e) { console.error('collect', e); return new Response('error', { status: 500 }); }
};

export const config = { schedule: '23 * * * *' };
