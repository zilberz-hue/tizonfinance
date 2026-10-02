/* What the collection run reads and writes on the real server: the books'
   own database (service account), payment pages made by the server, and the
   mail. Reminder history lives in books/{id}/remind, standing orders in
   books/{id}/standing, so the app shows the same thing. */
import { saJson, sendMail, payCreateFor, payCancelFor } from './functions/books-mail.mjs';

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
const clean = (o) => JSON.parse(JSON.stringify(o));

export function realCollectDeps(url) {
  const base = String(url || '').replace(/\/+$/, '');
  return {
    async books() { const fs = await firestore(); return (await fs.collection('books').get()).docs.map(d => ({ ...d.data(), id: d.id })); },
    /* Every document of the book that can hold a debt: read once a day, and only for a book with reminders on. */
    async allDocs(book) {
      const fs = await firestore();
      const snap = await fs.collection(`books/${book.id}/documents`).where('type', 'in', ['305', '320', '400', '330', 'CR', 'WO']).get();
      return snap.docs.map(d => ({ ...d.data(), id: d.id }));
    },
    async remindLog(book) { const fs = await firestore(); return Object.fromEntries((await fs.collection(`books/${book.id}/remind`).get()).docs.map(d => [d.data().key || d.id, d.data()])); },
    async saveRemind(book, key, rec) {
      const fs = await firestore(), id = key.replace(/[^\w@.:-]/g, '_').replace(/\//g, '_').slice(0, 140);
      if (!rec) return fs.doc(`books/${book.id}/remind/${id}`).delete();
      return fs.doc(`books/${book.id}/remind/${id}`).set(clean({ ...rec, key, id }));
    },
    async standing(book) { const fs = await firestore(); return (await fs.collection(`books/${book.id}/standing`).get()).docs.map(d => ({ ...d.data(), id: d.id })); },
    async saveStanding(book, r) { const fs = await firestore(); return fs.doc(`books/${book.id}/standing/${r.id}`).set(clean(r)); },
    payCreate: (book, o) => payCreateFor({ bookId: book.id, base, by: 'auto', ...o }),
    payCancel: (book, id) => payCancelFor(book.id, id, 'auto'),
    async wasDone(k) { const fs = await firestore(); return (await fs.doc(`collectRuns/${k.replace(/[^\w-]/g, '_')}`).get()).exists; },
    async markDone(k) { const fs = await firestore(); return fs.doc(`collectRuns/${k.replace(/[^\w-]/g, '_')}`).set({ at: new Date().toISOString() }); },
    send: (m) => sendMail(m),
  };
}
