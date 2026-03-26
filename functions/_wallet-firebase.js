// ============================================================
//  CGrocs — functions/_wallet-firebase.js
//  Firebase Firestore REST API helper used by wallet functions.
//  No firebase-admin dependency — uses Web Crypto + REST API.
// ============================================================

// ── JWT / Auth ────────────────────────────────────────────────────────────────

async function pemToPrivateKey(pem) {
  const clean = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const binary = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', binary.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

function b64url(input) {
  const str = typeof input === 'string'
    ? input
    : String.fromCharCode(...new Uint8Array(input));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Exchange a Google service account JSON for an OAuth2 access token. */
export async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now
  }));

  const unsigned = `${header}.${payload}`;
  const key = await pemToPrivateKey(serviceAccount.private_key);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Failed to get access token: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// ── Firebase ID token verification ───────────────────────────────────────────
//
// Verifies a Firebase client ID token server-side by calling the Identity
// Toolkit accounts:lookup endpoint. The web API key is public (already
// embedded in the frontend app) — store it as FIREBASE_CUSTOMER_WEB_API_KEY
// in Cloudflare environment variables for cleanliness.
//
// Returns true if the token is valid AND belongs to expectedUid.
// Returns false on any failure (expired, tampered, wrong uid, network error).

export async function verifyCustomerIdToken(idToken, expectedUid, webApiKey) {
  if (!idToken || !expectedUid || !webApiKey) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${webApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    const data = await res.json();
    if (data.error || !Array.isArray(data.users) || data.users.length === 0) return false;
    return data.users[0].localId === expectedUid;
  } catch {
    return false;
  }
}

// ── Firestore REST helpers ────────────────────────────────────────────────────

function fsBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}
export { fsBase };

/**
 * Returns the Firestore document name path used in commit write operations.
 * fsCommit expects names starting with "projects/..." NOT the full URL.
 * e.g. fsDocPath('myproject', 'users/uid123')
 *   → "projects/myproject/databases/(default)/documents/users/uid123"
 */
export function fsDocPath(projectId, docPath) {
  return `projects/${projectId}/databases/(default)/documents/${docPath}`;
}

/** Get a single Firestore document. Returns null if not found. */
export async function fsGet(token, projectId, path) {
  const res = await fetch(`${fsBase(projectId)}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const data = await res.json();
  if (data.error) throw new Error(`fsGet(${path}): ${data.error.message}`);
  return data;
}

/** Begin a read-write Firestore transaction. Returns the transaction ID string. */
export async function fsBeginTransaction(token, projectId) {
  const res = await fetch(`${fsBase(projectId)}:beginTransaction`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ options: { readWrite: {} } })
  });
  const data = await res.json();
  if (data.error) throw new Error('fsBeginTransaction: ' + data.error.message);
  return data.transaction;
}

/** Get a document inside an open transaction. Returns null if not found. */
export async function fsGetInTx(token, projectId, path, transaction) {
  const url = `${fsBase(projectId)}/${path}?transaction=${encodeURIComponent(transaction)}`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const data = await res.json();
  if (data.error) throw new Error(`fsGetInTx(${path}): ${data.error.message}`);
  return data;
}

/** Commit a transaction with a list of write operations. */
export async function fsCommit(token, projectId, transaction, writes) {
  const res = await fetch(`${fsBase(projectId)}:commit`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transaction, writes })
  });
  const data = await res.json();
  if (data.error) throw new Error('fsCommit: ' + data.error.message);
  return data;
}

/** Roll back an open transaction (best-effort). */
export async function fsRollback(token, projectId, transaction) {
  await fetch(`${fsBase(projectId)}:rollback`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transaction })
  }).catch(() => {});
}

// ── Firestore value converters ────────────────────────────────────────────────

/** Convert a plain JS object to Firestore REST API field map. */
export function toFsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toFsValue(v);
  return out;
}

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')        return { booleanValue: v };
  if (typeof v === 'number') {
    // Always use doubleValue for monetary amounts to avoid integer/float mismatch
    return { doubleValue: v };
  }
  if (typeof v === 'string')  return { stringValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object')  return { mapValue: { fields: toFsFields(v) } };
  return { stringValue: String(v) };
}

/** Convert a Firestore REST API field map to a plain JS object. */
export function fromFsFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFsValue(v);
  return out;
}

function fromFsValue(v) {
  if ('nullValue'      in v) return null;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('stringValue'    in v) return v.stringValue;
  if ('bytesValue'     in v) return v.bytesValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue'       in v) return fromFsFields(v.mapValue.fields || {});
  return null;
}

/** Generate a random Firestore-safe document ID (20 chars). */
export function randomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}
