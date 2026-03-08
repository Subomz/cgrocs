// api/save-subaccount.js
// Creates or updates a Paystack subaccount for a given store.
// Returns the subaccount_code so the client can save it to Firestore.

import https from 'https';

function paystackRequest(method, path, body, secretKey) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Paystack secret key not configured on server.' });
  }

  const { business_name, bank_code, account_number, existing_subaccount_code } = req.body || {};

  if (!business_name || !bank_code || !account_number) {
    return res.status(400).json({ error: 'business_name, bank_code, and account_number are required.' });
  }

  try {
    let result;

    if (existing_subaccount_code) {
      // Update the existing subaccount
      result = await paystackRequest(
        'PUT',
        `/subaccount/${existing_subaccount_code}`,
        { business_name, settlement_bank: bank_code, account_number },
        secret
      );
    } else {
      // Create a brand new subaccount
      // percentage_charge: 0 because we use a flat transaction_charge in cart.js
      result = await paystackRequest(
        'POST',
        '/subaccount',
        { business_name, settlement_bank: bank_code, account_number, percentage_charge: 0 },
        secret
      );
    }

    if (!result.status) {
      return res.status(502).json({ error: result.message || 'Paystack could not save the subaccount.' });
    }

    return res.status(200).json({
      subaccount_code: result.data.subaccount_code,
      business_name:   result.data.business_name,
      account_number:  result.data.account_number
    });
  } catch (e) {
    console.error('[save-subaccount]', e.message);
    return res.status(500).json({ error: 'Server error saving subaccount.' });
  }
}
