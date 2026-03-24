// functions/api/verify-account.js

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  if (!secret) return Response.json({ error: 'Paystack secret key not configured on server.' }, { status: 500, headers: CORS });

  const body = await context.request.json().catch(() => null);
  if (!body) return Response.json({ error: 'Invalid JSON body.' }, { status: 400, headers: CORS });

  const { account_number, bank_code } = body;

  if (!account_number || !bank_code) {
    return Response.json({ error: 'account_number and bank_code are required.' }, { status: 400, headers: CORS });
  }

  // Validate inputs before forwarding to Paystack
  if (!/^\d{10}$/.test(String(account_number))) {
    return Response.json({ error: 'account_number must be exactly 10 digits.' }, { status: 400, headers: CORS });
  }
  if (!/^\d{2,9}$/.test(String(bank_code))) {
    return Response.json({ error: 'bank_code must be 2–9 digits.' }, { status: 400, headers: CORS });
  }

  if (secret.startsWith('sk_test_')) {
    return Response.json({
      error: 'Account verification requires a live Paystack secret key (sk_live_...). Update PAYSTACK_SECRET_KEY in your Cloudflare environment variables.'
    }, { status: 400, headers: CORS });
  }

  try {
    const url    = `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`;
    const result = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } }).then(r => r.json());

    if (!result.status) {
      return Response.json({
        error: result.message || 'Account could not be verified. Check the account number and bank, then try again.'
      }, { status: 400, headers: CORS });
    }
    return Response.json({ account_name: result.data.account_name }, { headers: CORS });
  } catch (e) {
    console.error('[verify-account]', e.message);
    return Response.json({ error: 'Server error verifying account: ' + e.message }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
