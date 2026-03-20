// ============================================================
//  CGrocs — functions/api/verify-wallet-topup.js
//  POST /api/verify-wallet-topup
//
//  Headers: Authorization: Bearer <firebase_customer_id_token>
//
//  Body: { reference: string, uid: string, amount: number (naira) }
//
//  Security: Firebase ID token verified so a caller cannot credit
//  a different user's wallet by supplying someone else's uid.
//
//  Flow:
//    1. Verify the caller's Firebase ID token matches uid
//    2. Verify the Paystack reference server-side
//    3. Confirm the amount matches what Paystack reports
//    4. Check the reference hasn't been used before (replay guard)
//    5. Atomically:
//         • Credit walletBalance on the user document
//         • Write a walletTransactions entry
//         • Mark the reference as used in usedPaystackRefs
//
//  Returns: { success: true, newBalance: number }
//       or: { error: string }
// ============================================================

import {
  getAccessToken, fsGet, fsGetInTx, fsBeginTransaction,
  fsCommit, fsRollback, fsBase, toFsFields, fromFsFields, randomId,
  verifyCustomerIdToken
} from '../_wallet-firebase.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });
    }

    const { reference, uid, amount } = body;

    if (!reference || typeof reference !== 'string') {
      return Response.json({ error: 'Missing or invalid reference' }, { status: 400, headers: CORS });
    }
    if (!uid || typeof uid !== 'string') {
      return Response.json({ error: 'Missing or invalid uid' }, { status: 400, headers: CORS });
    }
    if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
      return Response.json({ error: 'Invalid amount' }, { status: 400, headers: CORS });
    }

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

    // ── 1. Verify with Paystack ──────────────────────────────────────────────
    const psRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } }
    );
    const psData = await psRes.json();

    if (!psData.status || psData.data?.status !== 'success') {
      return Response.json(
        { error: 'Payment not verified by Paystack' },
        { status: 400, headers: CORS }
      );
    }

    // ── 2. Confirm amount (Paystack stores in kobo) ──────────────────────────
    const expectedKobo = Math.round(amount * 100);
    if (psData.data.amount !== expectedKobo) {
      console.error(
        `[verify-wallet-topup] Amount mismatch: expected ${expectedKobo} kobo, got ${psData.data.amount} kobo`
      );
      return Response.json({ error: 'Amount mismatch' }, { status: 400, headers: CORS });
    }

    // ── 3. Get Firebase access token ─────────────────────────────────────────
    const sa = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const token     = await getAccessToken(sa);
    const projectId = sa.project_id;
    const base      = fsBase(projectId);

    // ── 4. Replay guard: check reference not already used ────────────────────
    const usedDoc = await fsGet(token, projectId, `usedPaystackRefs/${reference}`);
    if (usedDoc) {
      return Response.json(
        { error: 'Payment reference already used' },
        { status: 400, headers: CORS }
      );
    }

    // ── 5. Firestore transaction: credit balance + log + mark ref ────────────
    const tx = await fsBeginTransaction(token, projectId);
    let newBalance;

    try {
      const userDoc  = await fsGetInTx(token, projectId, `users/${uid}`, tx);
      const userData = userDoc ? fromFsFields(userDoc.fields) : {};
      const before   = typeof userData.walletBalance === 'number' ? userData.walletBalance : 0;
      newBalance     = before + amount;

      const txLogId = randomId();
      const now     = new Date().toISOString();

      await fsCommit(token, projectId, tx, [
        // Credit wallet balance (mask so other profile fields are untouched)
        {
          update: {
            name:   `${base}/users/${uid}`,
            fields: toFsFields({ walletBalance: newBalance })
          },
          updateMask: { fieldPaths: ['walletBalance'] }
        },
        // Transaction log entry
        {
          update: {
            name:   `${base}/users/${uid}/walletTransactions/${txLogId}`,
            fields: toFsFields({
              type:          'credit',
              amount,
              reference,
              description:   'Wallet top-up',
              date:          now,
              balanceBefore: before,
              balanceAfter:  newBalance
            })
          }
        },
        // Mark reference as used (prevents replay attacks)
        {
          update: {
            name:   `${base}/usedPaystackRefs/${reference}`,
            fields: toFsFields({ uid, amount, date: now })
          }
        }
      ]);
    } catch (txErr) {
      await fsRollback(token, projectId, tx);
      throw txErr;
    }

    return Response.json({ success: true, newBalance }, { headers: CORS });

  } catch (err) {
    console.error('[verify-wallet-topup]', err);
    return Response.json(
      { error: err.message || 'Internal server error' },
      { status: 500, headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
