// functions/api/create-head-admin.js
// Creates a head admin Firebase Auth account + Firestore role/profile docs
// in the HEAD ADMIN project (cloex-managerpage) using the Admin SDK.
//
// POST /api/create-head-admin
// Body: { name, email, password, role, storeId }
//
// Requires Cloudflare environment variable:
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT — service account JSON from the
//   cloex-managerpage Firebase project

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

  const { name, email, password, role, storeId } = await context.request.json();

  if (!name || !email || !password)
    return Response.json({ error: 'name, email, and password are required.' }, { status: 400 });
  if (!['general', 'store-head'].includes(role))
    return Response.json({ error: 'role must be "general" or "store-head".' }, { status: 400 });
  if (role === 'store-head' && !storeId)
    return Response.json({ error: 'storeId is required for store-head role.' }, { status: 400 });
  if (password.length < 6)
    return Response.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });

  try {
    const app  = getAdminApp(saJson);
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

    return Response.json({ uid, name, email, role, storeId: storeId || null });

  } catch (e) {
    console.error('[create-head-admin]', e);
    const code = e.errorInfo?.code;
    if (code === 'auth/email-already-exists')
      return Response.json({ error: 'This email is already registered.' }, { status: 400 });
    if (code === 'auth/invalid-email')
      return Response.json({ error: 'Please enter a valid email address.' }, { status: 400 });
    if (code === 'auth/weak-password')
      return Response.json({ error: 'Password is too weak.' }, { status: 400 });
    return Response.json({ error: e.message || 'Could not create account.' }, { status: 500 });
  }
}
