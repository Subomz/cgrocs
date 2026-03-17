// functions/api/get-banks.js
export async function onRequestGet(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  if (!secret) return Response.json({ error: 'Paystack secret key not configured on server.' }, { status: 500 });

  try {
    const result = await fetch('https://api.paystack.co/bank?currency=NGN&perPage=200', {
      headers: { Authorization: `Bearer ${secret}` }
    }).then(r => r.json());

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
