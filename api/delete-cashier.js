// api/delete-cashier.js
// Deletes a cashier's Firebase Auth account AND their Firestore profile
// in a single server-side call using the Firebase Admin SDK.
//
// POST /api/delete-cashier
// Body: { uid: "firebase-auth-uid" }
//
// Requires Vercel environment variable:
//   FIREBASE_ADMIN_SERVICE_ACCOUNT  — the full JSON of the service account
//                                     key from the ADMIN Firebase project
//                                     (cloexadminlogin → Project Settings →
//                                      Service Accounts → Generate new private key)

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth }                       = require('firebase-admin/auth');
const { getFirestore }                  = require('firebase-admin/firestore');

// Initialise once — Vercel may reuse the function container across requests
function getAdminApp() {
  const existing = getApps().find(a => a.name === 'delete-cashier-admin');
  if (existing) return existing;

  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) }, 'delete-cashier-admin');
}

module.exports = async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid } = req.body || {};

  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    return res.status(400).json({ error: 'uid is required.' });
  }

  try {
    const app   = getAdminApp();
    const auth  = getAuth(app);
    const db    = getFirestore(app);

    // Run both deletions concurrently — if Auth deletion fails (e.g. user
    // was already deleted), we still remove the Firestore doc so the UI
    // stays in sync. The try/catch handles each failure mode separately.
    const [authResult, firestoreResult] = await Promise.allSettled([
      auth.deleteUser(uid),
      db.collection('cashiers').doc(uid).delete()
    ]);

    // If Auth deletion failed for a reason other than user-not-found, surface it
    if (authResult.status === 'rejected') {
      const code = authResult.reason?.errorInfo?.code;
      if (code !== 'auth/user-not-found') {
        // Firestore may have succeeded — log it but still return an error
        console.error('[delete-cashier] Auth deletion failed:', authResult.reason);
        return res.status(500).json({
          error: 'Could not delete Auth account: ' + (authResult.reason?.message || 'Unknown error')
        });
      }
      // auth/user-not-found is fine — Firestore doc is still cleaned up
      console.warn('[delete-cashier] Auth user not found (already deleted?), Firestore doc removed.');
    }

    if (firestoreResult.status === 'rejected') {
      console.error('[delete-cashier] Firestore deletion failed:', firestoreResult.reason);
      return res.status(500).json({
        error: 'Auth account deleted but Firestore profile could not be removed: ' +
               (firestoreResult.reason?.message || 'Unknown error')
      });
    }

    return res.status(200).json({ success: true, uid });

  } catch (e) {
    console.error('[delete-cashier] Unexpected error:', e);
    return res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
};
