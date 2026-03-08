// api/get-banks.js
// Fetches the list of Nigerian banks from Paystack.
// Secret key stays server-side in Vercel environment variables — never exposed to the browser.

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
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Paystack secret key not configured on server.' });
  }

  try {
    const result = await paystackGet('/bank?currency=NGN&perPage=200', secret);
    if (!result.status) {
      return res.status(502).json({ error: result.message || 'Could not fetch banks from Paystack.' });
    }
    const banks = result.data.map(b => ({ name: b.name, code: b.code }));
    return res.status(200).json({ banks });
  } catch (e) {
    console.error('[get-banks]', e.message);
    return res.status(500).json({ error: 'Server error fetching banks.' });
  }
}
