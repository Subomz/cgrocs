// functions/api/delete-cashier.js
// Deletes a cashier's Firebase Auth account AND their Firestore profile
// in a single server-side call using the Firebase Admin SDK.
//
// POST /api/delete-cashier
// Body: { uid: "firebase-auth-uid" }
//
// Requires Cloudflare environment variable:
//   FIREBASE_ADMIN_SERVICE_ACCOUNT  — the full JSON of the service account
//                                     key from the ADMIN Firebase project
//                                     (cloexadminlogin → Project Settings →
//                                      Service Accounts → Generate new private key)

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth }                       from 'firebase-admin/auth';
import { getFirestore }                  from 'firebase-admin/firestore';

function getAdminApp(serviceAccountJson) {
  const existing = getApps().find(a => a.name === 'delete-cashier-admin');
  if (existing) return existing;
  const serviceAccount = JSON.parse(serviceAccountJson);
  return initializeApp({ credential: cert(serviceAccount) }, 'delete-cashier-admin');
}

export async function onRequestPost(context) {
  const saJson = context.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) {
    return Response.json({ error: 'FIREBASE_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });
  }

  const { uid } = await context.request.json();

  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return Response.json({ error: 'uid is required.' }, { status: 400 });
  }

  try {
    const app  = getAdminApp(saJson);
    const auth = getAuth(app);
    const db   = getFirestore(app);

    const [authResult, firestoreResult] = await Promise.allSettled([
      auth.deleteUser(uid),
      db.collection('cashiers').doc(uid).delete()
    ]);

    // If Auth deletion failed for a reason other than user-not-found, surface it
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
        {
          error: 'Auth account deleted but Firestore profile could not be removed: ' +
                 (firestoreResult.reason?.message || 'Unknown error')
        },
        { status: 500 }
      );
    }

    return Response.json({ success: true, uid });

  } catch (e) {
    console.error('[delete-cashier] Unexpected error:', e);
    return Response.json({ error: e.message || 'Unexpected server error.' }, { status: 500 });
  }
}
