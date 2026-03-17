// functions/api/save-subaccount.js
import { getAccessToken, fsGet, fsPatch, fromDoc, toFields } from '../_firebase-rest.js';

const HEAD_ADMIN_PROJECT = 'cloex-managerpage';

export async function onRequestPost(context) {
  const secret = context.env.PAYSTACK_SECRET_KEY;
  const saJson = context.env.FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT;

  if (!secret) return Response.json({ error: 'PAYSTACK_SECRET_KEY not configured.' }, { status: 500 });
  if (!saJson) return Response.json({ error: 'FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT not configured.' }, { status: 500 });

  const { storeId, business_name, bank_code, account_number } = await context.request.json();

  if (!storeId || !business_name || !bank_code || !account_number) {
    return Response.json({ error: 'storeId, business_name, bank_code, and account_number are required.' }, { status: 400 });
  }

  try {
    const sa    = JSON.parse(saJson);
    const token = await getAccessToken(sa);

    const snap          = await fsGet(HEAD_ADMIN_PROJECT, 'transferSettings/stores', token);
    const existing      = snap ? fromDoc(snap) : null;
    const existing_code = existing?.[storeId]?.subaccount_code || null;

    let result;
    if (existing_code) {
      result = await fetch(`https://api.paystack.co/subaccount/${existing_code}`, {
        method:  'PUT',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_name, settlement_bank: bank_code, account_number })
      }).then(r => r.json());
    } else {
      result = await fetch('https://api.paystack.co/subaccount', {
        method:  'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_name, settlement_bank: bank_code, account_number, percentage_charge: 0 })
      }).then(r => r.json());
    }

    if (!result.status) {
      return Response.json({ error: result.message || 'Paystack could not save the subaccount.' }, { status: 502 });
    }

    const subaccount_code = result.data.subaccount_code;
    const biz             = result.data.business_name;
    const acct            = result.data.account_number;

    const storeData = toFields({ subaccount_code, business_name: biz, bank_code, account_number: acct });
    await fsPatch(
      HEAD_ADMIN_PROJECT,
      'transferSettings/stores',
      { [storeId]: { mapValue: { fields: storeData } } },
      [storeId],
      token
    );

    return Response.json({ subaccount_code, business_name: biz, account_number: acct });

  } catch (e) {
    console.error('[save-subaccount]', e.message);
    return Response.json({ error: 'Server error: ' + e.message }, { status: 500 });
  }
}
