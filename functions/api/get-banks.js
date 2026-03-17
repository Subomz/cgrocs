// functions/api/get-banks.js
// Fetches the list of Nigerian banks from Paystack.
// Secret key stays server-side in Cloudflare environment variables — never exposed to the browser.

function paystackGet(path, secretKey) {
  return fetch(`https://api.paystack.co${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}` }
  }).then(r => r.json());
}

export async function onRequestGet(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return Response.json({ error: 'Paystack secret key not configured on server.' }, { status: 500 });
  }

  try {
    const result = await paystackGet('/bank?currency=NGN&perPage=200', secret);
    if (!result.status) {
      return Response.json({ error: result.message || 'Could not fetch banks from Paystack.' }, { status: 502 });
    }
    const banks = result.data.map(b => ({ name: b.name, code: b.code }));
    return Response.json({ banks });
  } catch (e) {
    console.error('[get-banks]', e.message);
    return Response.json({ error: 'Server error fetching banks.' }, { status: 500 });
  }
}
