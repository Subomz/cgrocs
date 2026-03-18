// ============================================================
//  CGrocs — functions/api/wallet-pay.js
//  POST /api/wallet-pay
//
//  Body: {
//    uid:           string,
//    storeId:       string,
//    purchaseId:    string,
//    items:         Array<{ name, quantity, price }>,
//    total:         number  (naira — goods only, no service charge),
//    email:         string,
//    customerName:  string,
//    customerPhone: string
//  }
//
//  Atomically inside a single Firestore transaction:
//    1. Reads the user's walletBalance
//    2. Rejects if balance < total
//    3. Deducts the total from walletBalance
//    4. Creates the purchase document in stores/{storeId}/purchases/{purchaseId}
//    5. Writes a walletTransactions debit entry
//
//  The client is responsible for deducting product stock after a successful
//  response (mirrors the existing Paystack callback behaviour in cart.js).
//
//  Returns: { success: true, newBalance: number, purchaseId: string }
//       or: { error: string, balance?: number }
// ============================================================

import {
  getAccessToken, fsGetInTx, fsBeginTransaction,
  fsCommit, fsRollback, fsBase, toFsFields, fromFsFields, randomId
} from '../_wallet-firebase.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });
    }

    const { uid, storeId, purchaseId, items, total, email, customerName, customerPhone } = body;

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

    // ── Firebase setup ───────────────────────────────────────────────────────
    const sa        = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const token     = await getAccessToken(sa);
    const projectId = sa.project_id;
    const base      = fsBase(projectId);

    // ── Firestore transaction ────────────────────────────────────────────────
    const tx = await fsBeginTransaction(token, projectId);
    let newBalance;

    try {
      // Read wallet balance inside transaction (prevents concurrent deductions)
      const userDoc  = await fsGetInTx(token, projectId, `users/${uid}`, tx);
      const userData = userDoc ? fromFsFields(userDoc.fields) : {};
      const before   = typeof userData.walletBalance === 'number' ? userData.walletBalance : 0;

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
        name:     String(i.name     || ''),
        quantity: Number(i.quantity || 0),
        price:    Number(i.price    || 0)
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
              cartSubtotal:  total,   // no service charge on wallet payments
              serviceCharge: 0,
              date:          now,
              verified:      false,
              storeId,
              uid,
              email:         email         || '',
              customerName:  customerName  || '',
              customerPhone: customerPhone || '',
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
