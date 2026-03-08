// api/delete-store.js
// Deletes ALL Firestore data for a given storeId across all three Firebase projects:
//   • Customer project  (cloexlogin-d466a)     → stores/{storeId}/*
//   • Admin project     (cloexadminlogin)       → stores/{storeId}/*
//   • Head-admin project (cloex-managerpage)    → transferSettings/stores[storeId]
//                                                  storeConfig/list[storeId]
//
// POST /api/delete-store
// Body: { storeId: "store1" }
//
// Requires Vercel environment variables:
//   FIREBASE_CUSTOMER_SERVICE_ACCOUNT    → service account for cloexlogin-d466a
//   FIREBASE_ADMIN_SERVICE_ACCOUNT       → service account for cloexadminlogin
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT  → service account for cloex-managerpage

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

// ── App initialisation (each project needs its own Admin SDK app) ────────────

function getApp(name, envVar) {
  const existing = getApps().find(a => a.name === name);
  if (existing) return existing;
  const serviceAccount = JSON.parse(process.env[envVar]);
  return initializeApp({ credential: cert(serviceAccount) }, name);
}

function getCustomerDb() {
  return getFirestore(getApp('del-store-customer', 'FIREBASE_CUSTOMER_SERVICE_ACCOUNT'));
}

function getAdminDb() {
  return getFirestore(getApp('del-store-admin', 'FIREBASE_ADMIN_SERVICE_ACCOUNT'));
}

function getHeadAdminDb() {
  return getFirestore(getApp('del-store-head-admin', 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT'));
}

// ── Recursive collection deleter ─────────────────────────────────────────────
// Firestore Admin SDK doesn't expose recursiveDelete in Node.js directly,
// so we do it manually: fetch all docs in a collection, delete each one
// (including any known sub-collections), in batches of 400.

const BATCH_SIZE = 400;

async function deleteCollection(db, collectionRef) {
  let deleted = 0;
  while (true) {
    const snap = await collectionRef.limit(BATCH_SIZE).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }
  return deleted;
}

// Delete all known sub-collections under stores/{storeId}
async function deleteStoreData(db, storeId, collections) {
  const results = {};
  for (const col of collections) {
    const ref = db.collection(`stores/${storeId}/${col}`);
    results[col] = await deleteCollection(db, ref);
  }
  // Delete the store document itself if it exists
  await db.doc(`stores/${storeId}`).delete().catch(() => {});
  return results;
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { storeId } = req.body || {};
  if (!storeId || typeof storeId !== 'string' || !storeId.trim()) {
    return res.status(400).json({ error: 'storeId is required.' });
  }

  const log = {};

  try {
    // ── 1. Customer project: products, purchases, categories, reservations ──
    const customerDb = getCustomerDb();
    log.customer = await deleteStoreData(customerDb, storeId, [
      'products', 'purchases', 'categories', 'reservations'
    ]);

    // ── 2. Admin project: product_logs ────────────────────────────────────
    const adminDb = getAdminDb();
    log.admin = await deleteStoreData(adminDb, storeId, ['product_logs']);

    // ── 3. Head-admin project: transferSettings entry + storeConfig entry ─
    const headAdminDb = getHeadAdminDb();

    // Remove this store's entry from transferSettings/stores
    const tsRef  = headAdminDb.doc('transferSettings/stores');
    const tsSnap = await tsRef.get();
    if (tsSnap.exists && tsSnap.data()?.[storeId]) {
      const { [storeId]: _removed, ...rest } = tsSnap.data();
      await tsRef.set(rest);
      log.transferSettings = 'removed';
    } else {
      log.transferSettings = 'not found';
    }

    // Remove this store from storeConfig/list
    const scRef  = headAdminDb.doc('storeConfig/list');
    const scSnap = await scRef.get();
    if (scSnap.exists) {
      const stores = (scSnap.data().stores || []).filter(s => s.id !== storeId);
      await scRef.set({ stores });
      log.storeConfig = 'removed';
    } else {
      log.storeConfig = 'not found';
    }

    console.log(`[delete-store] ${storeId} deleted:`, log);
    return res.status(200).json({ success: true, storeId, log });

  } catch (e) {
    console.error('[delete-store] Error:', e);
    return res.status(500).json({ error: e.message || 'Unexpected error.', log });
  }
};
