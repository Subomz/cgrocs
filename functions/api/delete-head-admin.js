// functions/api/delete-head-admin.js
import { getAccessToken, fsDelete, authDelete } from '../_firebase-rest.js';

const HEAD_ADMIN_PROJECT = 'cloex-managerpage';

export async function onRequestPost(context) {
  const saJson = context.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });

  const { uid } = await context.request.json();
  if (!uid) return Response.json({ error: 'uid is required.' }, { status: 400 });

  try {
    const sa    = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    const [authResult, adminsResult, profileResult] = await Promise.allSettled([
      authDelete(HEAD_ADMIN_PROJECT, uid, token),
      fsDelete(HEAD_ADMIN_PROJECT, `admins/${uid}`, token),
      fsDelete(HEAD_ADMIN_PROJECT, `headAdmins/${uid}`, token)
    ]);

    if (authResult.status === 'rejected') {
      const code = authResult.reason?.errorInfo?.code;
      if (code !== 'auth/user-not-found') {
        console.error('[delete-head-admin] Auth error:', authResult.reason);
        return Response.json({ error: 'Could not delete auth account: ' + authResult.reason?.message }, { status: 500 });
      }
    }

    if (adminsResult.status === 'rejected' || profileResult.status === 'rejected') {
      console.error('[delete-head-admin] Firestore error:', adminsResult.reason || profileResult.reason);
      return Response.json({ error: 'Auth deleted but Firestore cleanup failed.' }, { status: 500 });
    }

    return Response.json({ success: true, uid });

  } catch (e) {
    console.error('[delete-head-admin]', e.message);
    return Response.json({ error: e.message || 'Unexpected error.' }, { status: 500 });
  }
}
