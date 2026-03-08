// api/delete-head-admin.js
// Deletes a head admin's Firebase Auth account + both Firestore docs
// (/admins/{uid} and /headAdmins/{uid}) from the head admin project.
//
// POST /api/delete-head-admin
// Body: { uid }
//
// Requires: FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT env var (same as create-head-admin)

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth }                       = require('firebase-admin/auth');
const { getFirestore }                  = require('firebase-admin/firestore');

function getAdminApp() {
  const existing = getApps().find(a => a.name === 'head-admin-mgmt');
  if (existing) return existing;
  const serviceAccount = JSON.parse(process.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) }, 'head-admin-mgmt');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid is required.' });

  try {
    const app  = getAdminApp();
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
        return res.status(500).json({ error: 'Could not delete auth account: ' + authResult.reason?.message });
      }
    }

    if (adminsResult.status === 'rejected' || profileResult.status === 'rejected') {
      console.error('[delete-head-admin] Firestore error:', adminsResult.reason || profileResult.reason);
      return res.status(500).json({ error: 'Auth deleted but Firestore cleanup failed.' });
    }

    return res.status(200).json({ success: true, uid });

  } catch (e) {
    console.error('[delete-head-admin]', e);
    return res.status(500).json({ error: e.message || 'Unexpected error.' });
  }
};
