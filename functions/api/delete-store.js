// functions/api/delete-store.js
import { getAccessToken, fsGet, fsSet, fsDelete, fsList, fromDoc, toFields } from '../_firebase-rest.js';

const CUSTOMER_PROJECT   = 'cloexlogin-d466a';
const ADMIN_PROJECT      = 'cloexadminlogin';
const HEAD_ADMIN_PROJECT = 'cloex-managerpage';

const BATCH_SIZE = 100;

async function deleteCollection(projectId, collectionPath, token) {
  let deleted = 0;
  while (true) {
    const docs = await fsList(projectId, collectionPath, token, BATCH_SIZE);
    if (!docs.length) break;
    await Promise.all(docs.map(doc => {
      // doc.name is the full resource path — extract just the relative part
      const parts    = doc.name.split('/documents/');
      const docPath  = parts[1];
      return fsDelete(projectId, docPath, token);
    }));
    deleted += docs.length;
    if (docs.length < BATCH_SIZE) break;
  }
  return deleted;
}

async function deleteStoreData(projectId, storeId, collections, token) {
  const results = {};
  for (const col of collections) {
    results[col] = await deleteCollection(projectId, `stores/${storeId}/${col}`, token);
  }
  await fsDelete(projectId, `stores/${storeId}`, token);
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
    const customerSa    = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const customerToken = await getAccessToken(customerSa);
    log.customer = await deleteStoreData(CUSTOMER_PROJECT, storeId, ['products', 'purchases', 'categories', 'reservations'], customerToken);

    // 2. Admin project
    const adminSa    = JSON.parse(env.FIREBASE_ADMIN_SERVICE_ACCOUNT);
    const adminToken = await getAccessToken(adminSa);
    log.admin = await deleteStoreData(ADMIN_PROJECT, storeId, ['product_logs'], adminToken);

    // 3. Head-admin project
    const headSa    = JSON.parse(env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT);
    const headToken = await getAccessToken(headSa);

    // Remove from transferSettings/stores
    const tsSnap = await fsGet(HEAD_ADMIN_PROJECT, 'transferSettings/stores', headToken);
    if (tsSnap) {
      const tsData = fromDoc(tsSnap);
      if (tsData?.[storeId]) {
        delete tsData[storeId];
        await fsSet(HEAD_ADMIN_PROJECT, 'transferSettings/stores', toFields(tsData), headToken);
        log.transferSettings = 'removed';
      } else {
        log.transferSettings = 'not found';
      }
    } else {
      log.transferSettings = 'not found';
    }

    // Remove from storeConfig/list
    const scSnap = await fsGet(HEAD_ADMIN_PROJECT, 'storeConfig/list', headToken);
    if (scSnap) {
      const scData = fromDoc(scSnap);
      const stores = (scData?.stores || []).filter(s => s.id !== storeId);
      await fsSet(HEAD_ADMIN_PROJECT, 'storeConfig/list', toFields({ stores }), headToken);
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
