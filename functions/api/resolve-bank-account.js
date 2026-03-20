// ============================================================
//  CGrocs — functions/api/resolve-bank-account.js
//  GET /api/resolve-bank-account?account_number=0123456789&bank_code=058
//
//  Proxies Paystack's account resolution endpoint server-side
//  so the secret key is never exposed to the client.
//
//  Returns: { success: true, account_name: string, account_number: string }
//       or: { error: string }
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestGet({ request, env }) {
  try {
    const url      = new URL(request.url);
    const acctNo   = url.searchParams.get('account_number') || '';
    const bankCode = url.searchParams.get('bank_code')      || '';

    // Strict validation before forwarding to Paystack
    if (!acctNo || !bankCode) {
      return Response.json(
        { error: 'account_number and bank_code are required' },
        { status: 400, headers: CORS }
      );
    }
    if (!/^\d{10}$/.test(acctNo)) {
      return Response.json(
        { error: 'account_number must be exactly 10 digits' },
        { status: 400, headers: CORS }
      );
    }
    if (!/^\d{2,9}$/.test(bankCode)) {
      return Response.json(
        { error: 'bank_code must be 2–9 digits' },
        { status: 400, headers: CORS }
      );
    }

    const res  = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(acctNo)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } }
    );
    const data = await res.json();

    if (!data.status || !data.data?.account_name) {
      return Response.json(
        { error: 'Could not verify account. Check the number and bank.' },
        { status: 400, headers: CORS }
      );
    }

    return Response.json({
      success:        true,
      account_name:   data.data.account_name,
      account_number: data.data.account_number
    }, { headers: CORS });

  } catch (err) {
    console.error('[resolve-bank-account]', err);
    return Response.json({ error: 'Server error. Please try again.' }, { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
