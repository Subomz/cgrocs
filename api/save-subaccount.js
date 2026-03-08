// api/save-subaccount.js
// 1. Creates or updates a Paystack subaccount for a store.
// 2. Persists the result to Firestore (head-admin project) at:
//      transferSettings/stores → { [storeId]: { subaccount_code, business_name, bank_code, account_number } }
//
// POST /api/save-subaccount
// Body: { storeId, business_name, bank_code, account_number }
//
// Requires Vercel environment variables:
//   PAYSTACK_SECRET_KEY                 — sk_live_...
//   FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT — service account JSON for cloex-managerpage

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');
const https                             = require('https');

// Firebase Admin (head-admin project)
function getHeadAdminApp() {
  const existing = getApps().find(a => a.name === 'save-subaccount-ha');
  if (existing) return existing;
  const sa = JSON.parse(process.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(sa) }, 'save-subaccount-ha');
}

// Paystack HTTP helper
function paystackRequest(method, path, body, secretKey) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method,
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON from Paystack')); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not configured.' });
  }
  if (!process.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT) {
    return res.status(500).json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' });
  }

  const { storeId, business_name, bank_code, account_number } = req.body || {};

  if (!storeId || !business_name || !bank_code || !account_number) {
    return res.status(400).json({
      error: 'storeId, business_name, bank_code, and account_number are required.'
    });
  }

  try {
    // Step 1: check if this store already has a subaccount saved in Firestore
    const app = getHeadAdminApp();
    const db  = getFirestore(app);
    const ref = db.collection('transferSettings').doc('stores');

    const snap          = await ref.get();
    const existing      = snap.exists ? snap.data()[storeId] : null;
    const existing_code = existing && existing.subaccount_code ? existing.subaccount_code : null;

    // Step 2: create or update on Paystack
    let result;
    if (existing_code) {
      result = await paystackRequest(
        'PUT',
        '/subaccount/' + existing_code,
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
      return res.status(502).json({
        error: result.message || 'Paystack could not save the subaccount.'
      });
    }

    const subaccount_code = result.data.subaccount_code;
    const biz             = result.data.business_name;
    const acct            = result.data.account_number;

    // Step 3: persist to Firestore so data survives page reloads and tab switches
    await ref.set(
      {
        [storeId]: {
          subaccount_code,
          business_name:  biz,
          bank_code,
          account_number: acct
        }
      },
      { merge: true }  // keep other stores' entries intact
    );

    console.log('[save-subaccount] Saved ' + storeId + ': ' + subaccount_code);

    return res.status(200).json({ subaccount_code, business_name: biz, account_number: acct });

  } catch (e) {
    console.error('[save-subaccount]', e.message);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
};
