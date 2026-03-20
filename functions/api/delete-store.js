// functions/api/delete-store.js
import {
  getAccessToken, fsGet, fsSet, fsDelete, fsList, fromDoc, toFields,
  verifyCallerIsHeadAdmin, extractBearerToken
} from '../_firebase-rest.js';

const CUSTOMER_PROJECT      = 'cloexlogin-d466a';
const ADMIN_PROJECT         = 'cloexadminlogin';
const HEAD_ADMIN_PROJECT    = 'cloex-managerpage';
const HEAD_ADMIN_WEB_API_KEY_ENV = 'FIREBASE_HEAD_ADMIN_WEB_API_KEY';

const BATCH_SIZE = 100;

// storeId must be lowercase alphanumeric + hyphens only, max 40 chars.
// This prevents path-traversal attacks like storeId = "../users" which could
// delete data from unrelated Firestore collections.
const VALID_STORE_ID = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

async function deleteCollection(projectId, collectionPath, token) {
  let deleted = 0;
  while (true) {
    const docs = await fsList(projectId, collectionPath, token, BATCH_SIZE);
    if (!docs.length) break;
    await Promise.all(docs.map(doc => {
      const parts   = doc.name.split('/documents/');
      const docPath = parts[1];
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
  const { request, env } = context;

  if (!env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT || !env.FIREBASE_ADMIN_SERVICE_ACCOUNT || !env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT) {
    return Response.json(
      { error: 'One or more Firebase service account env vars are not configured.' },
      { status: 500, headers: CORS }
    );
  }

  // ── Verify the caller is an authenticated head admin ──────────────────────
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return Response.json({ error: 'Authorization header required.' }, { status: 401, headers: CORS });
  }
  if (!env[HEAD_ADMIN_WEB_API_KEY_ENV]) {
    return Response.json({ error: 'Server configuration error.' }, { status: 500, headers: CORS });
  }
  const callerUid = await verifyCallerIsHeadAdmin(idToken, env[HEAD_ADMIN_WEB_API_KEY_ENV]);
  if (!callerUid) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: CORS });
  }

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: 'Invalid JSON body.' }, { status: 400, headers: CORS });

  const { storeId } = body;

  if (!storeId || typeof storeId !== 'string') {
    return Response.json({ error: 'storeId is required.' }, { status: 400, headers: CORS });
  }

  // Strict validation: only allow safe store IDs to prevent path traversal
  if (!VALID_STORE_ID.test(storeId)) {
    return Response.json(
      { error: 'Invalid storeId format. Use only lowercase letters, numbers, and hyphens.' },
      { status: 400, headers: CORS }
    );
  }

  // Reject any storeId that looks like a traversal attempt (extra safety)
  if (storeId.includes('..') || storeId.includes('/') || storeId.includes('\\')) {
    return Response.json({ error: 'Invalid storeId.' }, { status: 400, headers: CORS });
  }

  const log = {};

  try {
    // 1. Customer project
    const customerSa    = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const customerToken = await getAccessToken(customerSa);
    log.customer = await deleteStoreData(
      CUSTOMER_PROJECT, storeId,
      ['products', 'purchases', 'categories', 'reservations'],
      customerToken
    );

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

    console.log(`[delete-store] ${storeId} deleted by ${callerUid}:`, log);
    return Response.json({ success: true, storeId, log }, { headers: CORS });

  } catch (e) {
    console.error('[delete-store] Error:', e);
    return Response.json({ error: e.message || 'Unexpected error.', log }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
