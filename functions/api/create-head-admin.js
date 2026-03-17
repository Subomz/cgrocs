// functions/api/create-head-admin.js
import { getAccessToken, fsSet, toFields, authCreate } from '../_firebase-rest.js';

const HEAD_ADMIN_PROJECT = 'cloex-managerpage';

export async function onRequestPost(context) {
  const saJson = context.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });

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

    return Response.json({ uid, name, email, role, storeId: storeId || null });

  } catch (e) {
    console.error('[create-head-admin]', e.message);
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
