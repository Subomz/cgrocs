// functions/api/delete-head-admin.js
// Deletes a head admin's Firebase Auth account + both Firestore docs
// (/admins/{uid} and /headAdmins/{uid}) from the head admin project.
//
// POST /api/delete-head-admin
// Body: { uid }
//
// Requires Cloudflare environment variable:
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth }                       from 'firebase-admin/auth';
import { getFirestore }                  from 'firebase-admin/firestore';

function getAdminApp(serviceAccountJson) {
  const existing = getApps().find(a => a.name === 'head-admin-mgmt');
  if (existing) return existing;
  const serviceAccount = JSON.parse(serviceAccountJson);
  return initializeApp({ credential: cert(serviceAccount) }, 'head-admin-mgmt');
}

export async function onRequestPost(context) {
  const saJson = context.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) {
    return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });
  }

  const { uid } = await context.request.json();
  if (!uid) return Response.json({ error: 'uid is required.' }, { status: 400 });

  try {
    const app  = getAdminApp(saJson);
    const auth = getAuth(app);
    const db   = getFirestore(app);

    const [authResult, adminsResult, profileResult] = await Promise.allSettled([
      auth.deleteUser(uid),
      db.collection('admins').doc(uid).delete(),
      db.collection('headAdmins').doc(uid).delete()
    ]);

    // auth/user-not-found is fine — Firestore docs still get cleaned up
    if (authResult.status === 'rejected') {
      const code = authResult.reason?.errorInfo?.code;
      if (code !== 'auth/user-not-found') {
        console.error('[delete-head-admin] Auth error:', authResult.reason);
        return Response.json(
          { error: 'Could not delete auth account: ' + authResult.reason?.message },
          { status: 500 }
        );
      }
    }

    if (adminsResult.status === 'rejected' || profileResult.status === 'rejected') {
      console.error('[delete-head-admin] Firestore error:', adminsResult.reason || profileResult.reason);
      return Response.json(
        { error: 'Auth deleted but Firestore cleanup failed.' },
        { status: 500 }
      );
    }

    return Response.json({ success: true, uid });

  } catch (e) {
    console.error('[delete-head-admin]', e);
    return Response.json({ error: e.message || 'Unexpected error.' }, { status: 500 });
  }
}
