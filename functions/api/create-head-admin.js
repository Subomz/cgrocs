// functions/api/create-head-admin.js
import {
  getAccessToken, fsSet, toFields, authCreate,
  verifyCallerIsHeadAdmin, extractBearerToken
} from '../_firebase-rest.js';

const HEAD_ADMIN_PROJECT    = 'cloex-managerpage';
const HEAD_ADMIN_WEB_API_KEY_ENV = 'FIREBASE_HEAD_ADMIN_WEB_API_KEY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const saJson = env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) {
    return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500, headers: CORS });
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

  const { name, email, password, role, storeId } = body;

  if (!name || !email || !password)
    return Response.json({ error: 'name, email, and password are required.' }, { status: 400, headers: CORS });
  if (!['general', 'store-head'].includes(role))
    return Response.json({ error: 'role must be "general" or "store-head".' }, { status: 400, headers: CORS });
  if (role === 'store-head' && !storeId)
    return Response.json({ error: 'storeId is required for store-head role.' }, { status: 400, headers: CORS });
  if (password.length < 6)
    return Response.json({ error: 'Password must be at least 6 characters.' }, { status: 400, headers: CORS });

  try {
    const sa    = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    // Create Firebase Auth user
    const { uid } = await authCreate(HEAD_ADMIN_PROJECT, { email, password, displayName: name }, token);

    // Write role doc
    const roleData = { role, email, createdAt: new Date().toISOString() };
    if (role === 'store-head') roleData.storeId = storeId;

    // Write profile doc
    const profileData = { name, email, createdAt: new Date().toISOString() };

    await Promise.all([
      fsSet(HEAD_ADMIN_PROJECT, `admins/${uid}`,     toFields(roleData),    token),
      fsSet(HEAD_ADMIN_PROJECT, `headAdmins/${uid}`, toFields(profileData), token)
    ]);

    return Response.json({ uid, name, email, role, storeId: storeId || null }, { headers: CORS });

  } catch (e) {
    console.error('[create-head-admin]', e.message);
    const code = e.errorInfo?.code;
    if (code === 'auth/email-already-exists')
      return Response.json({ error: 'This email is already registered.' }, { status: 400, headers: CORS });
    if (code === 'auth/invalid-email')
      return Response.json({ error: 'Please enter a valid email address.' }, { status: 400, headers: CORS });
    if (code === 'auth/weak-password')
      return Response.json({ error: 'Password is too weak.' }, { status: 400, headers: CORS });
    return Response.json({ error: e.message || 'Could not create account.' }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
