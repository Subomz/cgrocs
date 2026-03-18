// ============================================================
//  CGrocs — functions/api/wallet-verify-pin.js
//  POST /api/wallet-verify-pin
//
//  Body: { uid: string, pin: string (4 digits) }
//
//  Loads the stored PIN hash from Firestore, verifies it, and
//  on success returns a short-lived HMAC session token valid
//  for ~5 minutes. The client sends this token with wallet-pay
//  and wallet-withdraw so the server can confirm PIN was checked.
//
//  Returns: { success: true, token: string }
//       or: { error: string, wrongPin?: true }
// ============================================================

import { verifyPin, generatePinToken } from '../_wallet-pin.js';
import { getAccessToken, fsGet, fsBase, fromFsFields } from '../_wallet-firebase.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });

    const { uid, pin } = body;

    if (!uid || typeof uid !== 'string')
      return Response.json({ error: 'Missing uid' }, { status: 400, headers: CORS });
    if (!pin || !/^\d{4}$/.test(String(pin)))
      return Response.json({ error: 'PIN must be exactly 4 digits' }, { status: 400, headers: CORS });

    const sa        = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const token     = await getAccessToken(sa);
    const projectId = sa.project_id;

    // Load user document
    const userDoc = await fsGet(token, projectId, `users/${uid}`);
    if (!userDoc) return Response.json({ error: 'User not found' }, { status: 404, headers: CORS });

    const userData = fromFsFields(userDoc.fields);

    if (!userData.walletPinSet || !userData.walletPin) {
      return Response.json({ error: 'No PIN set. Please set a PIN first.' }, { status: 400, headers: CORS });
    }

    // Verify PIN
    const stored  = userData.walletPin; // { hash, salt }
    const correct = await verifyPin(pin, stored);

    if (!correct) {
      return Response.json(
        { error: 'Incorrect PIN. Please try again.', wrongPin: true },
        { status: 401, headers: CORS }
      );
    }

    // Generate session token
    const sessionToken = await generatePinToken(uid, env.WALLET_PIN_SECRET);

    return Response.json({ success: true, token: sessionToken }, { headers: CORS });

  } catch (err) {
    console.error('[wallet-verify-pin]', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
