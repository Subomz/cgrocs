// ============================================================
//  CGrocs — functions/api/wallet-set-pin.js
//  POST /api/wallet-set-pin
//
//  Headers: Authorization: Bearer <firebase_customer_id_token>
//
//  Body: { uid: string, pin: string (4 digits) }
//
//  Verifies the caller's Firebase ID token matches uid before
//  accepting the PIN. Hashes the PIN with PBKDF2 and stores it
//  in Firestore at users/{uid}.walletPin / walletPinSet.
//
//  Returns: { success: true }
//       or: { error: string }
// ============================================================

import { hashPin } from '../_wallet-pin.js';
import { getAccessToken, fsBase, toFsFields, verifyCustomerIdToken } from '../_wallet-firebase.js';

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
    const base      = fsBase(projectId);

    // Hash the PIN with PBKDF2-SHA256
    const { hash, salt } = await hashPin(pin);

    // Store in Firestore — field mask so we only touch PIN fields, never walletBalance
    const res = await fetch(
      `${base}/users/${uid}?updateMask.fieldPaths=walletPin&updateMask.fieldPaths=walletPinSet`,
      {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: toFsFields({
            walletPin:    { hash, salt },
            walletPinSet: true
          })
        })
      }
    );

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    return Response.json({ success: true }, { headers: CORS });

  } catch (err) {
    console.error('[wallet-set-pin]', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
