// ============================================================
//  CGrocs — functions/api/wallet-withdraw.js
//  POST /api/wallet-withdraw
//
//  Headers: Authorization: Bearer <firebase_customer_id_token>
//
//  Body: {
//    uid:            string,
//    amount:         number  (naira),
//    accountNumber:  string,
//    bankCode:       string,
//    accountName:    string  (pre-verified by client)
//    pinToken:       string
//  }
//
//  Security: Firebase ID token verified before any action.
//
//  Double-spend fix: The balance is deducted in Firestore BEFORE the
//  Paystack transfer is initiated. If Paystack fails, the balance is
//  atomically refunded in a second Firestore transaction. This prevents
//  two concurrent requests from both reading the same balance and both
//  initiating separate transfers.
//
//  Flow:
//    1. Verify Firebase ID token matches uid
//    2. Verify PIN token
//    3. Read balance in Firestore transaction
//    4. Reject if insufficient
//    5. COMMIT Firestore deduction + pending log entry
//    6. Create Paystack transfer recipient
//    7. Initiate Paystack transfer
//    8a. On Paystack success: update log entry to completed
//    8b. On Paystack failure: REFUND balance in a new Firestore transaction
//
//  Returns: { success: true, newBalance: number, transferCode: string }
//       or: { error: string, balance?: number }
// ============================================================

import {
  getAccessToken, fsGetInTx, fsBeginTransaction,
  fsCommit, fsRollback, fsBase, fsDocPath, toFsFields, fromFsFields, randomId,
  verifyCustomerIdToken, fsGet
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
    if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });

    const { uid, amount, accountNumber, bankCode, accountName, pinToken } = body;

    // ── Validate ─────────────────────────────────────────────────────────────
    if (!uid || typeof uid !== 'string')
      return Response.json({ error: 'Missing uid' }, { status: 400, headers: CORS });
    if (typeof amount !== 'number' || amount < 100 || !isFinite(amount))
      return Response.json({ error: 'Minimum withdrawal is ₦100' }, { status: 400, headers: CORS });
    if (!accountNumber || !/^\d{10}$/.test(String(accountNumber)))
      return Response.json({ error: 'Invalid account number — must be exactly 10 digits' }, { status: 400, headers: CORS });
    if (!bankCode || typeof bankCode !== 'string' || !/^\d{2,9}$/.test(bankCode))
      return Response.json({ error: 'Invalid bank code' }, { status: 400, headers: CORS });
    if (!accountName || typeof accountName !== 'string' || accountName.trim().length < 2)
      return Response.json({ error: 'Missing account name' }, { status: 400, headers: CORS });

    const amountKobo = Math.round(amount * 100);

    // ── Verify Firebase ID token ─────────────────────────────────────────────
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

    // ── PIN token validation ─────────────────────────────────────────────────
    if (!pinToken || typeof pinToken !== 'string') {
      return Response.json({ error: 'PIN verification required', requirePin: true }, { status: 401, headers: CORS });
    }
    if (!env.WALLET_PIN_SECRET) {
      return Response.json({ error: 'Server configuration error' }, { status: 500, headers: CORS });
    }
    const pinValid = await verifyPinToken(uid, pinToken, env.WALLET_PIN_SECRET);
    if (!pinValid) {
      return Response.json(
        { error: 'PIN session expired. Please verify your PIN again.', requirePin: true },
        { status: 401, headers: CORS }
      );
    }

    // ── Firebase setup ────────────────────────────────────────────────────────
    const sa        = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const token     = await getAccessToken(sa);
    const projectId = sa.project_id;
    const base      = fsBase(projectId);
    const docPath   = (path) => fsDocPath(projectId, path);

    // ── STEP 1: Deduct balance in Firestore BEFORE calling Paystack ───────────
    // This prevents two concurrent requests from both passing the balance check
    // and initiating duplicate transfers. If Paystack fails we refund below.
    const tx = await fsBeginTransaction(token, projectId);
    let newBalance;
    let before;
    const txLogId    = randomId();
    const reference  = 'wdraw-' + uid.slice(0, 6) + '-' + Date.now();
    const now        = new Date().toISOString();

    try {
      const userDoc  = await fsGetInTx(token, projectId, `users/${uid}`, tx);
      const userData = userDoc ? fromFsFields(userDoc.fields) : {};
      before         = typeof userData.walletBalance === 'number' ? userData.walletBalance : 0;

      if (before < amount) {
        await fsRollback(token, projectId, tx);
        return Response.json(
          { error: 'Insufficient wallet balance', balance: before },
          { status: 400, headers: CORS }
        );
      }

      newBalance = before - amount;

      // Commit the deduction + a "pending" log entry now, before any Paystack calls.
      await fsCommit(token, projectId, tx, [
        {
          update: {
            name:   `${docPath(`users/${uid}`)}`,
            fields: toFsFields({ walletBalance: newBalance })
          },
          updateMask: { fieldPaths: ['walletBalance'] }
        },
        {
          update: {
            name:   `${docPath(`users/${uid}/walletTransactions/${txLogId}`)}`,
            fields: toFsFields({
              type:          'debit',
              amount,
              reference,
              status:        'pending',
              description:   `Withdrawal to ${String(accountName).slice(0, 100)} (${accountNumber})`,
              date:          now,
              balanceBefore: before,
              balanceAfter:  newBalance,
              withdrawalDetails: {
                accountNumber,
                accountName: String(accountName).slice(0, 100),
                bankCode,
                transferCode: ''
              }
            })
          }
        }
      ]);
    } catch (txErr) {
      await fsRollback(token, projectId, tx);
      throw txErr;
    }

    // ── STEP 2: Call Paystack (balance already deducted) ─────────────────────
    let transferCode = reference;

    try {
      // Create transfer recipient
      const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type:           'nuban',
          name:           String(accountName).slice(0, 100),
          account_number: accountNumber,
          bank_code:      bankCode,
          currency:       'NGN'
        })
      });
      const recipientData = await recipientRes.json();

      if (!recipientData.status || !recipientData.data?.recipient_code) {
        throw new Error('Could not create transfer recipient. Check account details.');
      }

      const recipientCode = recipientData.data.recipient_code;

      // Initiate transfer
      const transferRes = await fetch('https://api.paystack.co/transfer', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source:    'balance',
          amount:    amountKobo,
          recipient: recipientCode,
          reason:    'CGrocs wallet withdrawal',
          reference
        })
      });
      const transferData = await transferRes.json();

      if (!transferData.status) {
        throw new Error(transferData.message || 'Transfer initiation failed.');
      }

      transferCode = transferData.data?.transfer_code || reference;

      // Update log to completed (best-effort — do not fail the response if this write fails)
      await _updateWithdrawalLog(token, projectId, base, uid, txLogId, 'completed', transferCode).catch(e => {
        console.warn('[wallet-withdraw] Could not update log to completed:', e.message);
      });

      return Response.json({ success: true, newBalance, transferCode }, { headers: CORS });

    } catch (paystackErr) {
      // ── STEP 3: Paystack failed — refund the balance ──────────────────────
      console.error('[wallet-withdraw] Paystack error, refunding balance:', paystackErr.message);

      try {
        const refundTx = await fsBeginTransaction(token, projectId);
        const freshDoc = await fsGetInTx(token, projectId, `users/${uid}`, refundTx);
        const freshBalance = freshDoc
          ? (fromFsFields(freshDoc.fields).walletBalance || newBalance)
          : newBalance;

        await fsCommit(token, projectId, refundTx, [
          {
            update: {
              name:   `${docPath(`users/${uid}`)}`,
              fields: toFsFields({ walletBalance: freshBalance + amount })
            },
            updateMask: { fieldPaths: ['walletBalance'] }
          }
        ]);
      } catch (refundErr) {
        // Critical: balance was deducted but refund failed. Log for manual resolution.
        console.error(
          'CRITICAL [wallet-withdraw] Refund failed. Manual action required.',
          { uid, amount, reference, refundError: refundErr.message }
        );
      }

      // Update log to failed status
      await _updateWithdrawalLog(token, projectId, base, uid, txLogId, 'failed', reference, paystackErr.message).catch(() => {});

      return Response.json(
        { error: paystackErr.message || 'Transfer failed. Your balance has been refunded.' },
        { status: 400, headers: CORS }
      );
    }

  } catch (err) {
    console.error('[wallet-withdraw]', err);
    return Response.json(
      { error: err.message || 'Internal server error' },
      { status: 500, headers: CORS }
    );
  }
}

/**
 * Update the withdrawal log entry status using a direct PATCH.
 * No transaction needed — there are no reads, just a targeted field update.
 * Using a transaction here adds overhead and leaves a hanging transaction
 * if the commit throws (no rollback path in the original).
 */
async function _updateWithdrawalLog(token, projectId, base, uid, txLogId, status, transferCode, errorMessage) {
  const fsFields = {
    status:       { stringValue: status },
    transferCode: { stringValue: transferCode || '' }
  };
  if (errorMessage) fsFields.errorMessage = { stringValue: String(errorMessage).slice(0, 500) };

  const maskPaths = Object.keys(fsFields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');

  await fetch(`${base}/users/${uid}/walletTransactions/${txLogId}?${maskPaths}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields: fsFields })
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
