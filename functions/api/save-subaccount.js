// functions/api/save-subaccount.js
import {
  getAccessToken, fsGet, fsPatch, fromDoc, toFields,
  verifyCallerIsHeadAdmin, extractBearerToken
} from '../_firebase-rest.js';

const HEAD_ADMIN_PROJECT    = 'cloex-managerpage';
const HEAD_ADMIN_WEB_API_KEY_ENV = 'FIREBASE_HEAD_ADMIN_WEB_API_KEY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = env.PAYSTACK_SECRET_KEY;
  const saJson = env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;

  if (!secret) return Response.json({ error: 'PAYSTACK_SECRET_KEY not configured.' }, { status: 500, headers: CORS });
  if (!saJson) return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500, headers: CORS });

  // ── Verify the caller is an authenticated head admin ──────────────────────
  const idToken = extractBearerToken(request);
  if (!idToken) {
    return Response.json({ error: 'Authorization header required.' }, { status: 401, headers: CORS });
  }
  if (!env[HEAD_ADMIN_WEB_API_KEY_ENV]) {
    return Response.json({ error: 'Server configuration error.' }, { status: 500, headers: CORS });
  }
  const callerUid = await verifyCallerIsHeadAdmin(idToken, env[HEAD_ADMIN_WEB_API_KEY_ENV]);
  if (!callerUid) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: CORS });
  }

  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: 'Invalid JSON body.' }, { status: 400, headers: CORS });

  const { storeId, business_name, bank_code, account_number } = body;

  if (!storeId || !business_name || !bank_code || !account_number) {
    return Response.json(
      { error: 'storeId, business_name, bank_code, and account_number are required.' },
      { status: 400, headers: CORS }
    );
  }

  // Validate account_number format
  if (!/^\d{10}$/.test(String(account_number))) {
    return Response.json({ error: 'account_number must be exactly 10 digits.' }, { status: 400, headers: CORS });
  }

  try {
    const sa    = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    const snap            = await fsGet(HEAD_ADMIN_PROJECT, 'transferSettings/stores', token);
    const existing        = snap ? fromDoc(snap) : null;
    const existing_code   = existing?.[storeId]?.subaccount_code || null;
    const existing_rcp    = existing?.[storeId]?.recipient_code  || null;

    // ── Step 1: Create or update the Paystack subaccount ─────────────────────
    // The subaccount (ACCT_xxx) is used for Paystack checkout split payments.
    // It routes cartTotal to the store during card payments.
    //
    // The stored subaccount_code can become stale when switching between test
    // and live Paystack keys — a code created in test mode doesn't exist in
    // live mode and vice versa. If Paystack returns "not found" on PUT, we
    // fall through to create a fresh one instead of surfacing the 502 error.
    let result;
    let subaccountCreatedFresh = false;

    if (existing_code) {
      result = await fetch(`https://api.paystack.co/subaccount/${existing_code}`, {
        method:  'PUT',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_name, settlement_bank: bank_code, account_number })
      }).then(r => r.json());

      // If Paystack says the code doesn't exist (stale code from wrong mode),
      // discard it and create a fresh subaccount instead of returning 502.
      if (!result.status && /not found|does not exist|invalid/i.test(result.message || '')) {
        console.warn('[save-subaccount] Stored subaccount_code not found in Paystack, creating fresh one.');
        result = null;
      }
    }

    if (!existing_code || !result) {
      result = await fetch('https://api.paystack.co/subaccount', {
        method:  'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_name, settlement_bank: bank_code, account_number, percentage_charge: 0 })
      }).then(r => r.json());
      subaccountCreatedFresh = true;
    }

    if (!result.status) {
      return Response.json(
        { error: result.message || 'Paystack could not save the subaccount.' },
        { status: 502, headers: CORS }
      );
    }

    const subaccount_code = result.data.subaccount_code;
    const biz             = result.data.business_name;
    const acct            = result.data.account_number;

    // ── Step 2: Create or reuse a transfer recipient (RCP_xxx) ───────────────
    // The recipient (RCP_xxx) is required by the Transfers API for wallet payments.
    // We reuse the stored one unless the subaccount was just recreated fresh
    // (which happens when switching modes), in which case we always create a new
    // recipient to match the new subaccount.
    let recipient_code = subaccountCreatedFresh ? null : existing_rcp;

    if (!recipient_code) {
      const rcpRes = await fetch('https://api.paystack.co/transferrecipient', {
        method:  'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          type:           'nuban',
          name:           biz,
          account_number: acct,
          bank_code,
          currency:       'NGN'
        })
      }).then(r => r.json());

      if (rcpRes.status && rcpRes.data?.recipient_code) {
        recipient_code = rcpRes.data.recipient_code;
      } else {
        // Non-fatal: wallet transfers will not route to the store until resolved.
        // The subaccount (card payments) still works fine without this.
        console.error('[save-subaccount] Could not create transfer recipient:', rcpRes.message);
      }
    }

    // ── Step 3: Persist both codes to Firestore ───────────────────────────────
    const storeData = toFields({
      subaccount_code,
      recipient_code: recipient_code || '',
      business_name:  biz,
      bank_code,
      account_number: acct
    });
    await fsPatch(
      HEAD_ADMIN_PROJECT,
      'transferSettings/stores',
      { [storeId]: { mapValue: { fields: storeData } } },
      [storeId],
      token
    );

    return Response.json({ subaccount_code, recipient_code: recipient_code || null, business_name: biz, account_number: acct }, { headers: CORS });

  } catch (e) {
    console.error('[save-subaccount]', e.message);
    return Response.json({ error: 'Server error: ' + e.message }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
