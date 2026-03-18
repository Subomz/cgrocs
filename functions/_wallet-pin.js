// ============================================================
//  CGrocs — functions/_wallet-pin.js
//  Shared PIN crypto helpers used by wallet-set-pin.js and
//  wallet-verify-pin.js. Runs on Web Crypto API (Cloudflare).
// ============================================================

// ── PBKDF2 PIN hashing ────────────────────────────────────────────────────────

/** Hash a 4-digit PIN with PBKDF2-SHA256. Returns { hash, salt } as base64 strings. */
export async function hashPin(pin) {
  const salt    = crypto.getRandomValues(new Uint8Array(16));
  const derived = await _pbkdf2(pin, salt);
  return {
    hash: _b64(derived),
    salt: _b64(salt)
  };
}

/** Verify a plain PIN against a stored { hash, salt }. Returns boolean. */
export async function verifyPin(pin, stored) {
  const salt    = _unb64(stored.salt);
  const derived = await _pbkdf2(pin, salt);
  const storedBytes = _unb64(stored.hash);
  // Constant-time comparison
  if (derived.byteLength !== storedBytes.byteLength) return false;
  const a = new Uint8Array(derived);
  const b = new Uint8Array(storedBytes);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function _pbkdf2(pin, salt) {
  const enc     = new TextEncoder();
  const keyMat  = await crypto.subtle.importKey(
    'raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    keyMat, 256
  );
}

// ── HMAC session token ────────────────────────────────────────────────────────
//
// Token = HMAC-SHA256( uid + ":" + windowSlot, WALLET_PIN_SECRET )
// where windowSlot = floor(Date.now() / PIN_WINDOW_MS)
//
// This gives a token valid for PIN_WINDOW_MS (5 minutes). The server checks
// both the current window and the previous one to handle clock skew.

const PIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Generate a PIN session token for a given uid. */
export async function generatePinToken(uid, secret) {
  const slot  = Math.floor(Date.now() / PIN_WINDOW_MS);
  return _hmacHex(uid + ':' + slot, secret);
}

/**
 * Verify a PIN session token. Accepts the current window and the previous
 * one so a token stays valid for up to ~10 minutes in practice.
 */
export async function verifyPinToken(uid, token, secret) {
  const slot = Math.floor(Date.now() / PIN_WINDOW_MS);
  const [current, previous] = await Promise.all([
    _hmacHex(uid + ':' + slot,       secret),
    _hmacHex(uid + ':' + (slot - 1), secret)
  ]);
  return token === current || token === previous;
}

async function _hmacHex(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function _unb64(str) {
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
