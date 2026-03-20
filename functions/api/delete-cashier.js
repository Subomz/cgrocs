// functions/api/delete-cashier.js
import {
  getAccessToken, fsDelete, authDelete,
  verifyCallerIsHeadAdmin, extractBearerToken
} from '../_firebase-rest.js';

const ADMIN_PROJECT         = 'cloexadminlogin';
const HEAD_ADMIN_WEB_API_KEY_ENV = 'FIREBASE_HEAD_ADMIN_WEB_API_KEY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const saJson = env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) {
    return Response.json({ error: 'FIREBASE_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500, headers: CORS });
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

  const { uid } = body;
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return Response.json({ error: 'uid is required.' }, { status: 400, headers: CORS });
  }

  try {
    const sa    = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    const [authResult, firestoreResult] = await Promise.allSettled([
      authDelete(ADMIN_PROJECT, uid, token),
      fsDelete(ADMIN_PROJECT, `cashiers/${uid}`, token)
    ]);

    if (authResult.status === 'rejected') {
      const code = authResult.reason?.errorInfo?.code;
      if (code !== 'auth/user-not-found') {
        console.error('[delete-cashier] Auth deletion failed:', authResult.reason);
        return Response.json(
          { error: 'Could not delete Auth account: ' + (authResult.reason?.message || 'Unknown error') },
          { status: 500, headers: CORS }
        );
      }
      console.warn('[delete-cashier] Auth user not found (already deleted?), Firestore doc removed.');
    }

    if (firestoreResult.status === 'rejected') {
      console.error('[delete-cashier] Firestore deletion failed:', firestoreResult.reason);
      return Response.json(
        { error: 'Auth account deleted but Firestore profile could not be removed: ' + (firestoreResult.reason?.message || 'Unknown error') },
        { status: 500, headers: CORS }
      );
    }

    return Response.json({ success: true, uid }, { headers: CORS });

  } catch (e) {
    console.error('[delete-cashier] Unexpected error:', e);
    return Response.json({ error: e.message || 'Unexpected server error.' }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
