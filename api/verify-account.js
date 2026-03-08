// api/verify-account.js
// Resolves a bank account number to the account holder's name via Paystack.

import https from 'https';

function paystackGet(path, secretKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` }
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

  const { account_number, bank_code } = req.body || {};
  if (!account_number || !bank_code) {
    return res.status(400).json({ error: 'account_number and bank_code are required.' });
  }

  // Warn early if a test key is being used — /bank/resolve requires a live key
  if (secret.startsWith('sk_test_')) {
    return res.status(400).json({
      error: 'Account verification requires a live Paystack secret key (sk_live_...). ' +
             'Test keys cannot resolve real bank accounts. Update PAYSTACK_SECRET_KEY in your Vercel environment variables.'
    });
  }

  try {
    const path = `/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`;
    const result = await paystackGet(path, secret);

    console.log('[verify-account] Paystack response:', JSON.stringify(result));

    if (!result.status) {
      return res.status(400).json({
        error: result.message || 'Account could not be verified. Check the account number and bank, then try again.'
      });
    }
    return res.status(200).json({ account_name: result.data.account_name });
  } catch (e) {
    console.error('[verify-account]', e.message);
    return res.status(500).json({ error: 'Server error verifying account: ' + e.message });
  }
}
