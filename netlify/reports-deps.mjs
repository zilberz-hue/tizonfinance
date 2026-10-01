/* What the reports read and send through, on the real server: the books'
   own database (with the service account the payment pages use), iCount for
   the documents issued there, Blobs to remember what was sent, and the mail. */
import { saJson, sendMail, secrets, icountDocs } from './functions/books-mail.mjs';

let fsCache = null;
async function firestore() {
  if (fsCache) return fsCache;
  const sa = await saJson();
  if (!sa) throw new Error('no-service-account');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps().find(a => a.name === 'books') || initializeApp({ credential: cert(sa), projectId: sa.project_id }, 'books');
  fsCache = getFirestore(app);
  return fsCache;
}
const months = (from, to) => { const out = []; let a = from; while (a <= to) { const [y, m] = a.slice(0, 7).split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); out.push([a, end < to ? end : to]); a = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); } return out; };

export function realDeps(url) {
  return {
    appUrl: url,
    async books() { const fs = await firestore(); return (await fs.collection('books').get()).docs.map(d => ({ ...d.data(), id: d.id })); },
    async rows(book, from, to) {
      const fs = await firestore();
      /* Only the dates asked for: a few dozen reads, never the whole collection. */
      const range = async (col) => (await fs.collection(`books/${book.id}/${col}`).where('date', '>=', from).where('date', '<=', to).get()).docs.map(d => ({ ...d.data(), id: d.id }));
      const [own, incomes, expenses] = await Promise.all([range('documents'), range('incomes'), range('expenses')]);
      const docs = own.filter(d => d.series === 'live');
      /* What was issued in iCount (the clinic's invoices) comes from iCount itself. */
      const ic = await secrets().get('icount:' + book.id, { type: 'json' }).catch(() => null);
      if (ic?.token) {
        for (const [a, b] of months(from, to)) {
          try { (await icountDocs(ic.token, a, b)).docs.forEach(d => docs.push({ ...d, series: 'icount' })); }
          catch (e) { console.warn('reports icount', book.id, a, e.message); }
        }
      }
      return { docs, incomes, expenses };
    },
    wasSent: async (k) => !!(await secrets().get(k).catch(() => null)),
    markSent: (k) => secrets().set(k, new Date().toISOString()),
    send: (m) => sendMail(m),
  };
}
