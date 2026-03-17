// functions/api/verify-account.js
export async function onRequestPost(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  if (!secret) return Response.json({ error: 'Paystack secret key not configured on server.' }, { status: 500 });

  const { account_number, bank_code } = await context.request.json();
  if (!account_number || !bank_code) {
    return Response.json({ error: 'account_number and bank_code are required.' }, { status: 400 });
  }

  if (secret.startsWith('sk_test_')) {
    return Response.json({
      error: 'Account verification requires a live Paystack secret key (sk_live_...). Update PAYSTACK_SECRET_KEY in your Cloudflare environment variables.'
    }, { status: 400 });
  }

  try {
    const url    = `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`;
    const result = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } }).then(r => r.json());

    if (!result.status) {
      return Response.json({
        error: result.message || 'Account could not be verified. Check the account number and bank, then try again.'
      }, { status: 400 });
    }
    return Response.json({ account_name: result.data.account_name });
  } catch (e) {
    console.error('[verify-account]', e.message);
    return Response.json({ error: 'Server error verifying account: ' + e.message }, { status: 500 });
  }
}
