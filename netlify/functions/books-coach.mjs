/* Tizon Books · the smart coach: status, the key, the answer to a job. */
import { coachAction } from '../coach-core.mjs';
import { ownerOf, realCoachDeps, json } from '../coach-deps.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  try {
    const body = await req.json().catch(() => ({}));
    const email = await ownerOf(body.idToken);
    return json(200, await coachAction(body, email, realCoachDeps()));
  } catch (e) {
    return json(e.status || 500, { error: String(e.message || e) });
  }
};
