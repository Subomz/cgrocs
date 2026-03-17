// functions/api/delete-store.js
// Deletes ALL Firestore data for a given storeId across all three Firebase projects:
//   • Customer project   (cloexlogin-d466a)    → stores/{storeId}/*
//   • Admin project      (cloexadminlogin)      → stores/{storeId}/*
//   • Head-admin project (cloex-managerpage)    → transferSettings/stores[storeId]
//                                                  storeConfig/list[storeId]
//
// POST /api/delete-store
// Body: { storeId: "store1" }
//
// Requires Cloudflare environment variables:
//   FIREBASE_CUSTOMER_SERVICE_ACCOUNT    → service account for cloexlogin-d466a
//   FIREBASE_ADMIN_SERVICE_ACCOUNT       → service account for cloexadminlogin
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT  → service account for cloex-managerpage

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function getApp(name, serviceAccountJson) {
  const existing = getApps().find(a => a.name === name);
  if (existing) return existing;
  const serviceAccount = JSON.parse(serviceAccountJson);
  return initializeApp({ credential: cert(serviceAccount) }, name);
}

function getCustomerDb(env) {
  return getFirestore(getApp('del-store-customer', env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT));
}

function getAdminDb(env) {
  return getFirestore(getApp('del-store-admin', env.FIREBASE_ADMIN_SERVICE_ACCOUNT));
}

function getHeadAdminDb(env) {
  return getFirestore(getApp('del-store-head-admin', env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT));
}

// ── Recursive collection deleter ─────────────────────────────────────────────
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

async function deleteStoreData(db, storeId, collections) {
  const results = {};
  for (const col of collections) {
    const ref = db.collection(`stores/${storeId}/${col}`);
    results[col] = await deleteCollection(db, ref);
  }
  await db.doc(`stores/${storeId}`).delete().catch(() => {});
  return results;
}

export async function onRequestPost(context) {
  const { env } = context;

  if (!env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT || !env.FIREBASE_ADMIN_SERVICE_ACCOUNT || !env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT) {
    return Response.json({ error: 'One or more Firebase service account env vars are not configured.' }, { status: 500 });
  }

  const { storeId } = await context.request.json();

  if (!storeId || typeof storeId !== 'string' || !storeId.trim()) {
    return Response.json({ error: 'storeId is required.' }, { status: 400 });
  }

  const log = {};

  try {
    // 1. Customer project
    const customerDb = getCustomerDb(env);
    log.customer = await deleteStoreData(customerDb, storeId, [
      'products', 'purchases', 'categories', 'reservations'
    ]);

    // 2. Admin project
    const adminDb = getAdminDb(env);
    log.admin = await deleteStoreData(adminDb, storeId, ['product_logs']);

    // 3. Head-admin project
    const headAdminDb = getHeadAdminDb(env);

    // Remove from transferSettings/stores
    const tsRef  = headAdminDb.doc('transferSettings/stores');
    const tsSnap = await tsRef.get();
    if (tsSnap.exists && tsSnap.data()?.[storeId]) {
      const { [storeId]: _removed, ...rest } = tsSnap.data();
      await tsRef.set(rest);
      log.transferSettings = 'removed';
    } else {
      log.transferSettings = 'not found';
    }

    // Remove from storeConfig/list
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
    return Response.json({ success: true, storeId, log });

  } catch (e) {
    console.error('[delete-store] Error:', e);
    return Response.json({ error: e.message || 'Unexpected error.', log }, { status: 500 });
  }
}
