// ============================================================
//  CGrocs — functions/api/wallet-withdraw.js
//  POST /api/wallet-withdraw
//
//  Body: {
//    uid:            string,
//    amount:         number  (naira),
//    accountNumber:  string,
//    bankCode:       string,
//    accountName:    string  (pre-verified by client)
//  }
//
//  Flow:
//    1. Validate inputs
//    2. Read wallet balance in a Firestore transaction
//    3. Reject if insufficient
//    4. Create a Paystack transfer recipient
//    5. Initiate the Paystack transfer
//    6. On Paystack acceptance:
//         • Deduct walletBalance in Firestore
//         • Write a walletTransactions debit entry
//
//  Returns: { success: true, newBalance: number, transferCode: string }
//       or: { error: string, balance?: number }
//
//  NOTE: Paystack transfers require your Paystack account to have
//  transfers enabled and your balance to be funded. The transfer
//  is initiated instantly but settlement to the recipient's bank
//  typically takes a few minutes.
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
    if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });

    const { uid, amount, accountNumber, bankCode, accountName } = body;

    // ── Validate ─────────────────────────────────────────────────────────────
    if (!uid || typeof uid !== 'string')
      return Response.json({ error: 'Missing uid' }, { status: 400, headers: CORS });
    if (typeof amount !== 'number' || amount < 100 || !isFinite(amount))
      return Response.json({ error: 'Minimum withdrawal is ₦100' }, { status: 400, headers: CORS });
    if (!accountNumber || !/^\d{10}$/.test(accountNumber))
      return Response.json({ error: 'Invalid account number' }, { status: 400, headers: CORS });
    if (!bankCode || typeof bankCode !== 'string')
      return Response.json({ error: 'Missing bank code' }, { status: 400, headers: CORS });
    if (!accountName || typeof accountName !== 'string')
      return Response.json({ error: 'Missing account name' }, { status: 400, headers: CORS });

    const amountKobo = Math.round(amount * 100);

    // ── Firebase setup ────────────────────────────────────────────────────────
    const sa        = JSON.parse(env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT);
    const token     = await getAccessToken(sa);
    const projectId = sa.project_id;
    const base      = fsBase(projectId);

    // ── Check wallet balance in Firestore transaction ─────────────────────────
    const tx       = await fsBeginTransaction(token, projectId);
    let newBalance;

    try {
      const userDoc  = await fsGetInTx(token, projectId, `users/${uid}`, tx);
      const userData = userDoc ? fromFsFields(userDoc.fields) : {};
      const before   = typeof userData.walletBalance === 'number' ? userData.walletBalance : 0;

      if (before < amount) {
        await fsRollback(token, projectId, tx);
        return Response.json(
          { error: 'Insufficient wallet balance', balance: before },
          { status: 400, headers: CORS }
        );
      }

      // ── Create Paystack transfer recipient ──────────────────────────────────
      const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type:           'nuban',
          name:           accountName,
          account_number: accountNumber,
          bank_code:      bankCode,
          currency:       'NGN'
        })
      });
      const recipientData = await recipientRes.json();

      if (!recipientData.status || !recipientData.data?.recipient_code) {
        await fsRollback(token, projectId, tx);
        return Response.json(
          { error: 'Could not create transfer recipient. Check account details.' },
          { status: 400, headers: CORS }
        );
      }

      const recipientCode = recipientData.data.recipient_code;

      // ── Initiate Paystack transfer ──────────────────────────────────────────
      const reference    = 'wdraw-' + uid.slice(0, 6) + '-' + Date.now();
      const transferRes  = await fetch('https://api.paystack.co/transfer', {
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

      // Paystack returns status=true for pending/success transfers
      if (!transferData.status) {
        await fsRollback(token, projectId, tx);
        const psMsg = transferData.message || 'Transfer initiation failed.';
        return Response.json({ error: psMsg }, { status: 400, headers: CORS });
      }

      const transferCode = transferData.data?.transfer_code || reference;
      newBalance         = before - amount;
      const now          = new Date().toISOString();
      const txLogId      = randomId();

      // ── Commit: deduct balance + log ────────────────────────────────────────
      await fsCommit(token, projectId, tx, [
        {
          update: {
            name:   `${base}/users/${uid}`,
            fields: toFsFields({ walletBalance: newBalance })
          },
          updateMask: { fieldPaths: ['walletBalance'] }
        },
        {
          update: {
            name:   `${base}/users/${uid}/walletTransactions/${txLogId}`,
            fields: toFsFields({
              type:          'debit',
              amount,
              reference:     transferCode,
              description:   `Withdrawal to ${accountName} (${accountNumber})`,
              date:          now,
              balanceBefore: before,
              balanceAfter:  newBalance,
              withdrawalDetails: {
                accountNumber,
                accountName,
                bankCode,
                transferCode
              }
            })
          }
        }
      ]);

      return Response.json({ success: true, newBalance, transferCode }, { headers: CORS });

    } catch (txErr) {
      await fsRollback(token, projectId, tx);
      throw txErr;
    }

  } catch (err) {
    console.error('[wallet-withdraw]', err);
    return Response.json(
      { error: err.message || 'Internal server error' },
      { status: 500, headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
