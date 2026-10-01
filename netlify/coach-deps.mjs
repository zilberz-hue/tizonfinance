/* What the coach runs with on the real server: who is asking (their login),
   that they own a business here, a Blobs store, and the model. */
import { getStore } from '@netlify/blobs';
import { saJson, who } from './functions/books-mail.mjs';
import { askClaude } from './coach-core.mjs';

let fsCache = null;
async function firestore() {
  if (fsCache) return fsCache;
  const sa = await saJson();
  if (!sa) throw Object.assign(new Error('no-service-account'), { status: 400 });
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps().find(a => a.name === 'books') || initializeApp({ credential: cert(sa), projectId: sa.project_id }, 'books');
  fsCache = getFirestore(app);
  return fsCache;
}
/* The coach is for owners: the login must own at least one business. */
export async function ownerOf(idToken) {
  const email = await who(String(idToken || ''));
  const fs = await firestore();
  const s = await fs.collection('books').where('owners', 'array-contains', email).limit(1).get();
  if (s.empty) throw Object.assign(new Error('owners only'), { status: 403 });
  return email;
}
export const realCoachDeps = () => ({
  store: getStore({ name: 'books-coach', consistency: 'strong' }),
  ask: (o) => askClaude(o),
});
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
