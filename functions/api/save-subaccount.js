// functions/api/save-subaccount.js
// 1. Creates or updates a Paystack subaccount for a store.
// 2. Persists the result to Firestore (head-admin project) at:
//      transferSettings/stores → { [storeId]: { subaccount_code, business_name, bank_code, account_number } }
//
// POST /api/save-subaccount
// Body: { storeId, business_name, bank_code, account_number }
//
// Requires Cloudflare environment variables:
//   PAYSTACK_SECRET_KEY                 — sk_live_...
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT — service account JSON for cloex-managerpage

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

// Firebase Admin (head-admin project)
function getHeadAdminApp(serviceAccountJson) {
  const existing = getApps().find(a => a.name === 'save-subaccount-ha');
  if (existing) return existing;
  const sa = JSON.parse(serviceAccountJson);
  return initializeApp({ credential: cert(sa) }, 'save-subaccount-ha');
}

// Paystack HTTP helper using fetch (native in Cloudflare Workers)
async function paystackRequest(method, path, body, secretKey) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return response.json();
}

export async function onRequestPost(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return Response.json({ error: 'PAYSTACK_SECRET_KEY not configured.' }, { status: 500 });
  }

  const saJson = context.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;
  if (!saJson) {
    return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });
  }

  const { storeId, business_name, bank_code, account_number } = await context.request.json();

  if (!storeId || !business_name || !bank_code || !account_number) {
    return Response.json({
      error: 'storeId, business_name, bank_code, and account_number are required.'
    }, { status: 400 });
  }

  try {
    const app = getHeadAdminApp(saJson);
    const db  = getFirestore(app);
    const ref = db.collection('transferSettings').doc('stores');

    // Step 1: check if this store already has a subaccount saved in Firestore
    const snap          = await ref.get();
    const existing      = snap.exists ? snap.data()[storeId] : null;
    const existing_code = existing && existing.subaccount_code ? existing.subaccount_code : null;

    // Step 2: create or update on Paystack
    let result;
    if (existing_code) {
      result = await paystackRequest(
        'PUT',
        `/subaccount/${existing_code}`,
        { business_name, settlement_bank: bank_code, account_number },
        secret
      );
    } else {
      result = await paystackRequest(
        'POST',
        '/subaccount',
        { business_name, settlement_bank: bank_code, account_number, percentage_charge: 0 },
        secret
      );
    }

    if (!result.status) {
      return Response.json({
        error: result.message || 'Paystack could not save the subaccount.'
      }, { status: 502 });
    }

    const subaccount_code = result.data.subaccount_code;
    const biz             = result.data.business_name;
    const acct            = result.data.account_number;

    // Step 3: persist to Firestore
    await ref.set(
      {
        [storeId]: {
          subaccount_code,
          business_name:  biz,
          bank_code,
          account_number: acct
        }
      },
      { merge: true }
    );

    console.log('[save-subaccount] Saved ' + storeId + ': ' + subaccount_code);
    return Response.json({ subaccount_code, business_name: biz, account_number: acct });

  } catch (e) {
    console.error('[save-subaccount]', e.message);
    return Response.json({ error: 'Server error: ' + e.message }, { status: 500 });
  }
}
