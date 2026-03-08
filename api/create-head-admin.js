// api/create-head-admin.js
// Creates a head admin Firebase Auth account + Firestore role/profile docs
// in the HEAD ADMIN project (cloex-managerpage) using the Admin SDK.
//
// POST /api/create-head-admin
// Body: { name, email, password, role, storeId }
//
// Requires Vercel environment variable:
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT — service account JSON from the
//   cloex-managerpage Firebase project
//   (Firebase Console → cloex-managerpage → Project Settings →
//    Service Accounts → Generate new private key)

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

  const { name, email, password, role, storeId } = req.body || {};

  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email, and password are required.' });
  if (!['general', 'store-head'].includes(role))
    return res.status(400).json({ error: 'role must be "general" or "store-head".' });
  if (role === 'store-head' && !storeId)
    return res.status(400).json({ error: 'storeId is required for store-head role.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    const app  = getAdminApp();
    const auth = getAuth(app);
    const db   = getFirestore(app);

    // Create Firebase Auth user
    const userRecord = await auth.createUser({ email, password, displayName: name });
    const uid = userRecord.uid;

    // Write role document — read by auth guard on login
    const roleDoc = { role, email, createdAt: new Date().toISOString() };
    if (role === 'store-head') roleDoc.storeId = storeId;

    // Write profile document — read by head-admin.js for display name
    const profileDoc = { name, email, createdAt: new Date().toISOString() };

    await Promise.all([
      db.collection('admins').doc(uid).set(roleDoc),
      db.collection('headAdmins').doc(uid).set(profileDoc)
    ]);

    return res.status(200).json({ uid, name, email, role, storeId: storeId || null });

  } catch (e) {
    console.error('[create-head-admin]', e);
    const code = e.errorInfo?.code;
    if (code === 'auth/email-already-exists')
      return res.status(400).json({ error: 'This email is already registered.' });
    if (code === 'auth/invalid-email')
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (code === 'auth/weak-password')
      return res.status(400).json({ error: 'Password is too weak.' });
    return res.status(500).json({ error: e.message || 'Could not create account.' });
  }
};
