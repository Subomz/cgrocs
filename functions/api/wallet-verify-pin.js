// ============================================================
//  CGrocs — functions/api/wallet-verify-pin.js
//  POST /api/wallet-verify-pin
//
//  Headers: Authorization: Bearer <firebase_customer_id_token>
//
//  Body: { uid: string, pin: string (4 digits) }
//
//  Verifies the caller's Firebase ID token matches uid before
//  checking the PIN. On success returns a short-lived HMAC
//  session token valid for ~5 minutes.
//
//  Returns: { success: true, token: string }
//       or: { error: string, wrongPin?: true }
// ============================================================

import { verifyPin, generatePinToken } from '../_wallet-pin.js';
import { getAccessToken, fsGet, fsBase, fromFsFields, verifyCustomerIdToken } from '../_wallet-firebase.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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

    // ── Verify the caller's Firebase ID token ────────────────────────────────
    const idToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!idToken) {
      return Response.json({ error: 'Authorization header required' }, { status: 401, headers: CORS });
    }
    if (!env.FIREBASE_CUSTOMER_WEB_API_KEY) {
      return Response.json({ error: 'Server configuration error' }, { status: 500, headers: CORS });
    }
    const callerVerified = await verifyCustomerIdToken(idToken, uid, env.FIREBASE_CUSTOMER_WEB_API_KEY);
    if (!callerVerified) {
      return Response.json({ error: 'Invalid or expired session. Please log in again.' }, { status: 401, headers: CORS });
    }

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

    // Verify PIN using constant-time comparison
    const stored  = userData.walletPin; // { hash, salt }
    const correct = await verifyPin(pin, stored);

    if (!correct) {
      return Response.json(
        { error: 'Incorrect PIN. Please try again.', wrongPin: true },
        { status: 401, headers: CORS }
      );
    }

    if (!env.WALLET_PIN_SECRET) {
      return Response.json({ error: 'Server configuration error' }, { status: 500, headers: CORS });
    }

    // Generate HMAC session token (valid ~5 minutes)
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
