// functions/_firebase-rest.js
// Firebase REST API helpers — no firebase-admin, no Node.js built-ins.
// Uses Web Crypto API (native in Cloudflare Workers) to sign JWTs.

/**
 * Exchange a service account JSON for a short-lived OAuth2 access token.
 */
export async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);

  const encode = obj =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Strip PEM headers and decode base64
  const pem     = serviceAccount.private_key.replace(/-----[^-]+-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const b64sig = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${signingInput}.${b64sig}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Caller authentication ─────────────────────────────────────────────────────
//
// Verifies a Firebase client ID token server-side using the Identity Toolkit
// accounts:lookup endpoint. The web API key is public (already in the frontend
// app) — add it as FIREBASE_HEAD_ADMIN_WEB_API_KEY in Cloudflare env vars.
//
// verifyCallerIsHeadAdmin: returns the caller's uid if the token is valid for
// the head-admin Firebase project, or null if invalid/missing.
//
// All admin API endpoints (create-head-admin, delete-cashier, delete-store,
// save-subaccount, etc.) call this before performing any destructive action.
// Any account with a valid token in the head-admin project IS a head admin —
// regular customers cannot obtain tokens in that project.

export async function verifyCallerIsHeadAdmin(idToken, webApiKey) {
  if (!idToken || !webApiKey) return null;
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
    if (data.error || !Array.isArray(data.users) || data.users.length === 0) return null;
    return data.users[0].localId; // uid of the verified caller
  } catch {
    return null;
  }
}

/**
 * Extract a Bearer token from the Authorization header.
 * Returns the token string or null.
 */
export function extractBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

// ── Firestore REST helpers ────────────────────────────────────────────────────

const fsBase = (projectId) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

/** GET a single Firestore document. Returns null if not found. */
export async function fsGet(projectId, docPath, token) {
  const res  = await fetch(`${fsBase(projectId)}/${docPath}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const data = await res.json();
  if (data.error) throw new Error(`Firestore get (${docPath}): ${data.error.message}`);
  return data;
}

/** PATCH a Firestore document (full overwrite of listed fields via updateMask). */
export async function fsPatch(projectId, docPath, fields, fieldMasks, token) {
  const maskQuery = fieldMasks.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const res  = await fetch(`${fsBase(projectId)}/${docPath}?${maskQuery}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Firestore patch (${docPath}): ${data.error.message}`);
  return data;
}

/** Full document SET (overwrites entire document). */
export async function fsSet(projectId, docPath, fields, token) {
  const res  = await fetch(`${fsBase(projectId)}/${docPath}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Firestore set (${docPath}): ${data.error.message}`);
  return data;
}

/** LIST documents in a collection. Returns array of document objects. */
export async function fsList(projectId, collectionPath, token, pageSize = 300) {
  const res  = await fetch(`${fsBase(projectId)}/${collectionPath}?pageSize=${pageSize}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(`Firestore list (${collectionPath}): ${data.error.message}`);
  return data.documents || [];
}

/** DELETE a single Firestore document. */
export async function fsDelete(projectId, docPath, token) {
  const res = await fetch(`${fsBase(projectId)}/${docPath}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json();
    throw new Error(`Firestore delete (${docPath}): ${data.error?.message}`);
  }
}

// ── Firestore value converters ────────────────────────────────────────────────

export function fromDoc(doc) {
  if (!doc?.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fromVal(v);
  return out;
}

function fromVal(v) {
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue    !== undefined) return null;
  if (v.mapValue     !== undefined) return fromDoc(v.mapValue);
  if (v.arrayValue   !== undefined) return (v.arrayValue.values || []).map(fromVal);
  return null;
}

export function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toVal(v);
  return out;
}

function toVal(v) {
  if (v === null || v === undefined)   return { nullValue: null };
  if (typeof v === 'string')           return { stringValue: v };
  if (typeof v === 'boolean')          return { booleanValue: v };
  if (typeof v === 'number')           return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v))                return { arrayValue: { values: v.map(toVal) } };
  if (typeof v === 'object')           return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

// ── Firebase Auth REST helpers ────────────────────────────────────────────────

/** Create a Firebase Auth user (admin scope). */
export async function authCreate(projectId, { email, password, displayName }, token) {
  const res  = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, displayName })
    }
  );
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || '';
    const err = new Error(msg);
    if (msg.includes('EMAIL_EXISTS'))   err.errorInfo = { code: 'auth/email-already-exists' };
    else if (msg.includes('INVALID_EMAIL')) err.errorInfo = { code: 'auth/invalid-email' };
    else if (msg.includes('WEAK_PASSWORD')) err.errorInfo = { code: 'auth/weak-password' };
    else                                err.errorInfo = { code: 'auth/unknown' };
    throw err;
  }
  return { uid: data.localId };
}

/** Delete a Firebase Auth user (admin scope). */
export async function authDelete(projectId, uid, token) {
  const res  = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:delete`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ localId: uid })
    }
  );
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || '';
    const err = new Error(msg);
    err.errorInfo = { code: msg.includes('USER_NOT_FOUND') ? 'auth/user-not-found' : 'auth/unknown' };
    throw err;
  }
}
