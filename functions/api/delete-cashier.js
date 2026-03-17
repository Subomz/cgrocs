// functions/api/delete-cashier.js
import { getAccessToken, fsDelete, authDelete } from '../_firebase-rest.js';

const ADMIN_PROJECT = 'cloexadminlogin';

export async function onRequestPost(context) {
  const saJson = context.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) return Response.json({ error: 'FIREBASE_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });

  const { uid } = await context.request.json();
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return Response.json({ error: 'uid is required.' }, { status: 400 });
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
          { status: 500 }
        );
      }
      console.warn('[delete-cashier] Auth user not found (already deleted?), Firestore doc removed.');
    }

    if (firestoreResult.status === 'rejected') {
      console.error('[delete-cashier] Firestore deletion failed:', firestoreResult.reason);
      return Response.json(
        { error: 'Auth account deleted but Firestore profile could not be removed: ' + (firestoreResult.reason?.message || 'Unknown error') },
        { status: 500 }
      );
    }

    return Response.json({ success: true, uid });

  } catch (e) {
    console.error('[delete-cashier] Unexpected error:', e);
    return Response.json({ error: e.message || 'Unexpected server error.' }, { status: 500 });
  }
}
