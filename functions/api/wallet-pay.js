// ============================================================
//  CGrocs — functions/api/wallet-pay.js
//  POST /api/wallet-pay
//
//  Headers: Authorization: Bearer <firebase_customer_id_token>
//
//  Body: {
//    uid:           string,
//    storeId:       string,
//    purchaseId:    string,
//    items:         Array<{ name, quantity, price }>,
//    total:         number  (naira — goods only, no service charge),
//    email:         string,
//    customerName:  string,
//    customerPhone: string,
//    pinToken:      string | null
//  }
//
//  Security: The caller's Firebase ID token is verified server-side and
//  must match the uid in the body. This prevents one user from paying
//  from another user's wallet.
//
//  PIN logic:
//    - If the user has a PIN set (walletPinSet === true), a valid pinToken
//      is required. The client obtains this from /api/wallet-verify-pin.
//    - If the user has NOT set a PIN, pinToken may be null and payment
//      proceeds without a PIN check.
//
//  Atomically inside a single Firestore transaction:
//    1. Verifies the caller's Firebase ID token
//    2. Reads the user document (balance + PIN status)
//    3. Enforces PIN requirement if set
//    4. Rejects if balance < total
//    5. Deducts walletBalance
//    6. Creates the purchase document
//    7. Writes a walletTransactions debit entry
//
//  Returns: { success: true, newBalance: number, purchaseId: string }
//       or: { error: string, requirePin?: true, balance?: number }
// ============================================================

import {
  getAccessToken, fsGetInTx, fsBeginTransaction,
  fsCommit, fsRollback, fsBase, toFsFields, fromFsFields, randomId,
  verifyCustomerIdToken
} from '../_wallet-firebase.js';
import { verifyPinToken } from '../_wallet-pin.js';

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

    const { uid, storeId, purchaseId, items, total, email, customerName, customerPhone, pinToken } = body;

    // ── Validate inputs ──────────────────────────────────────────────────────
    if (!uid || typeof uid !== 'string') {
      return Response.json({ error: 'Missing uid' }, { status: 400, headers: CORS });
    }
    if (!storeId || typeof storeId !== 'string') {
      return Response.json({ error: 'Missing storeId' }, { status: 400, headers: CORS });
    }
    if (!purchaseId || typeof purchaseId !== 'string') {
      return Response.json({ error: 'Missing purchaseId' }, { status: 400, headers: CORS });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'Missing or empty items' }, { status: 400, headers: CORS });
    }
    if (typeof total !== 'number' || total <= 0 || !isFinite(total)) {
      return Response.json({ error: 'Invalid total' }, { status: 400, headers: CORS });
    }

    // ── Verify the caller's Firebase ID token ────────────────────────────────
    // Ensures the request comes from the authenticated user whose uid is in
    // the body — prevents one user from draining another user's wallet.
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

    // ── Validate pinToken if provided ────────────────────────────────────────
    // If the client sent a pinToken, validate it up-front before any Firestore
    // work. If no pinToken is provided, we check inside the transaction whether
    // the user has a PIN set (and reject if they do).
    let pinTokenValid = false;
    if (pinToken && typeof pinToken === 'string') {
      if (!env.WALLET_PIN_SECRET) {
        return Response.json({ error: 'Server configuration error' }, { status: 500, headers: CORS });
      }
      pinTokenValid = await verifyPinToken(uid, pinToken, env.WALLET_PIN_SECRET);
      if (!pinTokenValid) {
        return Response.json(
          { error: 'PIN session expired. Please verify your PIN again.', requirePin: true },
          { status: 401, headers: CORS }
        );
      }
    }

    // ── Firebase setup ───────────────────────────────────────────────────────
    const sa        = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const token     = await getAccessToken(sa);
    const projectId = sa.project_id;
    const base      = fsBase(projectId);

    // ── Firestore transaction ────────────────────────────────────────────────
    const tx = await fsBeginTransaction(token, projectId);
    let newBalance;

    try {
      // Read wallet balance and PIN status inside transaction
      const userDoc  = await fsGetInTx(token, projectId, `users/${uid}`, tx);
      const userData = userDoc ? fromFsFields(userDoc.fields) : {};
      const before   = typeof userData.walletBalance === 'number' ? userData.walletBalance : 0;

      // If the user has a PIN set but no valid pinToken was provided, reject
      if (userData.walletPinSet === true && !pinTokenValid) {
        await fsRollback(token, projectId, tx);
        return Response.json(
          { error: 'PIN verification required', requirePin: true },
          { status: 401, headers: CORS }
        );
      }

      if (before < total) {
        await fsRollback(token, projectId, tx);
        return Response.json(
          { error: 'Insufficient wallet balance', balance: before },
          { status: 400, headers: CORS }
        );
      }

      newBalance = before - total;
      const now     = new Date().toISOString();
      const txLogId = randomId();

      // Sanitise items to only store the fields we need
      const safeItems = items.map(i => ({
        name:     String(i.name     || '').slice(0, 200),
        quantity: Math.max(0, Math.round(Number(i.quantity) || 0)),
        price:    Math.max(0, Number(i.price) || 0)
      }));

      await fsCommit(token, projectId, tx, [
        // 1. Deduct wallet balance (field mask: only walletBalance)
        {
          update: {
            name:   `${base}/users/${uid}`,
            fields: toFsFields({ walletBalance: newBalance })
          },
          updateMask: { fieldPaths: ['walletBalance'] }
        },

        // 2. Create the purchase document
        {
          update: {
            name:   `${base}/stores/${storeId}/purchases/${purchaseId}`,
            fields: toFsFields({
              id:            purchaseId,
              items:         safeItems,
              total,
              cartSubtotal:  total,   // no convenience fee on wallet payments
              serviceCharge: 0,   // kept as 0; field name preserved for DB compatibility
              date:          now,
              verified:      false,
              storeId,
              uid,
              email:         String(email         || '').slice(0, 254),
              customerName:  String(customerName  || '').slice(0, 200),
              customerPhone: String(customerPhone || '').slice(0, 30),
              paymentMethod: 'wallet',
              reference:     'wallet-' + purchaseId
            })
          }
        },

        // 3. Wallet transaction log entry
        {
          update: {
            name:   `${base}/users/${uid}/walletTransactions/${txLogId}`,
            fields: toFsFields({
              type:          'debit',
              amount:        total,
              purchaseId,
              description:   'Purchase at CGrocs',
              date:          now,
              balanceBefore: before,
              balanceAfter:  newBalance,
              storeId
            })
          }
        }
      ]);
    } catch (txErr) {
      await fsRollback(token, projectId, tx);
      throw txErr;
    }

    return Response.json({ success: true, newBalance, purchaseId }, { headers: CORS });

  } catch (err) {
    console.error('[wallet-pay]', err);
    return Response.json(
      { error: err.message || 'Internal server error' },
      { status: 500, headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
