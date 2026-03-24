// functions/api/get-banks.js

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestGet(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  if (!secret) return Response.json({ error: 'Paystack secret key not configured on server.' }, { status: 500, headers: CORS });

  try {
    const result = await fetch('https://api.paystack.co/bank?currency=NGN&perPage=200', {
      headers: { Authorization: `Bearer ${secret}` }
    }).then(r => r.json());

    if (!result.status) {
      return Response.json({ error: result.message || 'Could not fetch banks from Paystack.' }, { status: 502, headers: CORS });
    }
    const banks = result.data.map(b => ({ name: b.name, code: b.code }));
    return Response.json({ banks }, { headers: CORS });
  } catch (e) {
    console.error('[get-banks]', e.message);
    return Response.json({ error: 'Server error fetching banks.' }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
