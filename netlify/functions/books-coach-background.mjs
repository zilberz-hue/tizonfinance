/* Tizon Books · the smart coach, thinking: runs in the background (up to 15
   minutes), so a long plan never times out. The page polls books-coach for
   the job's answer. */
import { coachRun } from '../coach-core.mjs';
import { ownerOf, realCoachDeps } from '../coach-deps.mjs';

export default async (req) => {
  const body = await req.json().catch(() => ({}));
  const deps = realCoachDeps();
  try {
    const email = await ownerOf(body.idToken);
    await coachRun(body, email, deps);
  } catch (e) {
    console.error('coach', e);
    /* The page is waiting on this job: tell it why nothing will come. */
    if (/^[\w-]{6,60}$/.test(String(body.id || ''))) await deps.store.setJSON('coach-job:' + body.id, { state: 'error', error: String(e.message || e) }).catch(() => {});
  }
};
