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
    let result;
    if (existing_code) {
      result = await fetch(`https://api.paystack.co/subaccount/${existing_code}`, {
        method:  'PUT',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_name, settlement_bank: bank_code, account_number })
      }).then(r => r.json());
    } else {
      result = await fetch('https://api.paystack.co/subaccount', {
        method:  'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_name, settlement_bank: bank_code, account_number, percentage_charge: 0 })
      }).then(r => r.json());
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
    // The recipient (RCP_xxx) is a separate Paystack entity required for the
    // Transfers API. wallet-pay.js uses this to route cartTotal to the store
    // from the platform's Paystack balance when a customer pays with their wallet.
    // We reuse an existing recipient if one was already created for this store.
    let recipient_code = existing_rcp;

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
        // Non-fatal: wallet transfers will simply not route to the store until
        // this is resolved. Log it but do not block subaccount setup.
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
