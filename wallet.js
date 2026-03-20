// ============================================================
//  CGrocs — wallet.js
//  Wallet slide-in panel — same style as the Orders panel.
//
//  Exports:
//    loadWalletBalance(uid)
//    loadWalletTransactions(uid, limit)
//    renderWalletBalance(elementId, bal)
//    renderWalletTransactions(elementId, txns)
//    setWalletContext(uid, email, key, cb)
//
//  Window globals:
//    window.walletBalance      — cached balance (read by cart.js)
//    window.openWalletPanel()  — open the slide-in panel
//    window.closeWalletPanel() — close it
//    window.openWalletTopup()  — alias for backwards compat
// ============================================================

import { initializeApp, getApps }  from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js';
import {
  getFirestore, doc, getDoc, collection, getDocs, query, orderBy, limit as fsLimit
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { customerConfig } from './firebase-config.js';

const app = getApps().find(a => a.name === 'cardstorage')
  || initializeApp(customerConfig, 'cardstorage');
const db = getFirestore(app);

// ── API auth helper ───────────────────────────────────────────────────────────
// Returns the current user's Firebase ID token so wallet API calls can be
// authenticated server-side. All wallet mutation endpoints now require this.
async function _getCustomerIdToken() {
  try {
    const a = getApps().find(ap => ap.name === 'cardstorage');
    if (!a) return null;
    const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js');
    return await getAuth(a).currentUser?.getIdToken() || null;
  } catch {
    return null;
  }
}

async function _walletPost(url, body) {
  const idToken = await _getCustomerIdToken();
  return fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { 'Authorization': 'Bearer ' + idToken } : {})
    },
    body: JSON.stringify(body)
  });
}


window.walletBalance = 0;

// ── PIN session state ─────────────────────────────────────────────────────────
// After a successful PIN verification the server returns a token valid ~5 min.
// We cache it here so the customer isn't prompted repeatedly while shopping.
window._walletPinToken  = null;
window._walletPinExpiry = 0;   // ms timestamp

function _pinTokenValid() {
  return window._walletPinToken && Date.now() < window._walletPinExpiry;
}
function _storePinToken(token) {
  window._walletPinToken  = token;
  window._walletPinExpiry = Date.now() + 4 * 60 * 1000; // 4 min client-side guard
}
function _clearPinToken() {
  window._walletPinToken  = null;
  window._walletPinExpiry = 0;
}

// ── Paystack callbacks — MUST be defined at module top level ──────────────────
// Paystack's inline.js checks `callback instanceof Function`. This fails for
// any function created at runtime inside a module realm (even assigned to window).
// Defining them here at load time is the only reliable fix — same as cart.js.

let _walletPayload = null;

window._walletTopupCallback = function(response) {
  var payload = _walletPayload;
  _walletPayload = null;
  if (!payload) { console.error('wallet: topup callback fired with no payload'); return; }

  notify.info('Verifying payment…', 15000);
  _walletPost('/api/verify-wallet-topup', { reference: response.reference, uid: payload.uid, amount: payload.amount })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      window.walletBalance = data.newBalance;
      _syncBalanceEverywhere(data.newBalance);
      notify.success('₦' + Number(payload.amount).toLocaleString('en-NG') + ' added to your wallet!', 5000);
      if (typeof payload.onSuccess === 'function') payload.onSuccess(data.newBalance);
      if (payload.uid) _loadAndRenderTxns(payload.uid);
      // After first top-up: prompt PIN setup if not already set
      if (payload.uid) _checkAndPromptPinSetup(payload.uid);
    } else {
      notify.error('Top-up failed: ' + (data.error || 'Unknown error.'), 8000);
    }
  })
  .catch(function() {
    notify.error('Top-up verification failed. Contact support if you were charged.', 10000);
  });
};

window._walletTopupOnClose = function() {
  _walletPayload = null;
  notify.info('Top-up cancelled.');
};

// ── Balance ───────────────────────────────────────────────────────────────────

export async function loadWalletBalance(uid) {
  try {
    const snap    = await getDoc(doc(db, 'users', uid));
    const balance = snap.exists() ? (Number(snap.data().walletBalance) || 0) : 0;
    window.walletBalance = balance;
    return balance;
  } catch (e) {
    console.warn('wallet.js: could not load balance:', e.message);
    return window.walletBalance || 0;
  }
}

export function renderWalletBalance(elementId, balance) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = fmt(balance);
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function loadWalletTransactions(uid, limitCount = 20) {
  try {
    const q    = query(
      collection(db, 'users/' + uid + '/walletTransactions'),
      orderBy('date', 'desc'),
      fsLimit(limitCount)
    );
    const snap = await getDocs(q);
    const txns = [];
    snap.forEach(function(d) { txns.push(Object.assign({ id: d.id }, d.data())); });
    return txns;
  } catch (e) {
    console.warn('wallet.js: could not load transactions:', e.message);
    return [];
  }
}

export function renderWalletTransactions(elementId, transactions) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!transactions || transactions.length === 0) {
    el.innerHTML = '<p class="wallet-empty">No transactions yet.</p>';
    return;
  }
  el.innerHTML = transactions.map(function(tx) {
    var isCredit = tx.type === 'credit';
    var dateStr  = tx.date
      ? new Date(tx.date).toLocaleDateString('en-NG', {
          day: 'numeric', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        })
      : '—';
    var desc = esc(tx.description || (isCredit ? 'Top-up' : 'Debit'));
    return '<div class="wallet-tx-item">' +
      '<div class="wallet-tx-left">' +
        '<span class="wallet-tx-icon ' + (isCredit ? 'tx-credit' : 'tx-debit') + '">' + (isCredit ? '↑' : '↓') + '</span>' +
        '<div>' +
          '<div class="wallet-tx-desc">' + desc + '</div>' +
          '<div class="wallet-tx-date">' + dateStr + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="wallet-tx-right">' +
        '<div class="wallet-tx-amount ' + (isCredit ? 'amount-credit' : 'amount-debit') + '">' +
          (isCredit ? '+' : '−') + fmt(tx.amount || 0) +
        '</div>' +
        '<div class="wallet-tx-bal">Bal: ' + fmt(tx.balanceAfter || 0) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Panel open / close ────────────────────────────────────────────────────────

export function setWalletContext(uid, email, paystackKey, onSuccess) {
  window._walletCtx = { uid: uid, email: email, paystackKey: paystackKey, onSuccess: onSuccess };
}

window.openWalletPanel = function() {
  var panel   = document.getElementById('wallet-panel');
  var overlay = document.getElementById('wallet-overlay');
  if (!panel || !overlay) return;
  overlay.style.display = 'block';
  panel.classList.add('open');
  _showSection('wallet-section-main');
  var ctx = window._walletCtx;
  if (ctx && ctx.uid) {
    _syncBalanceEverywhere(window.walletBalance);
    _loadAndRenderTxns(ctx.uid);
  }
};

window.closeWalletPanel = function() {
  var panel   = document.getElementById('wallet-panel');
  var overlay = document.getElementById('wallet-overlay');
  if (panel)   panel.classList.remove('open');
  if (overlay) overlay.style.display = 'none';
  _showSection('wallet-section-main');
};

// Backwards compatibility
window.openWalletTopup = window.openWalletPanel;

// Expose PIN gate for cart.js
// Called as: window._requireWalletPin(uid, function(token) { ... })
// token is null if no PIN is set (proceed normally)
// token is null if user cancelled (caller should abort)
window._requireWalletPin = function(uid, onDone) {
  // Check if PIN is set by looking at the user's Firestore doc
  // We cache pinSet status to avoid a round-trip every payment
  if (window._walletPinSet === false) {
    // PIN not set — proceed without PIN
    onDone(null);
    return;
  }
  if (window._walletPinSet === true) {
    // PIN is set — gate it
    _requirePin(uid, onDone);
    return;
  }
  // Unknown — check Firestore once then cache
  getDoc(doc(db, 'users', uid)).then(function(snap) {
    var pinSet = snap.exists() && snap.data().walletPinSet === true;
    window._walletPinSet = pinSet;
    if (pinSet) {
      _requirePin(uid, onDone);
    } else {
      onDone(null);
    }
  }).catch(function() {
    // On error, proceed without PIN rather than blocking checkout
    onDone(null);
  });
};

// Also expose the PIN setup shortcut for use from profile page
window._walletSetPin = function() {
  var ctx = window._walletCtx;
  if (!ctx) { notify.error('Wallet not ready. Please refresh.'); return; }
  window.openWalletPanel();
  _showPinSetupPanel(ctx.uid);
};

// ── Section switching ─────────────────────────────────────────────────────────

function _showSection(id) {
  var sections = ['wallet-section-main', 'wallet-section-topup', 'wallet-section-withdraw'];
  sections.forEach(function(s) {
    var el = document.getElementById(s);
    if (el) el.style.display = s === id ? 'flex' : 'none';
  });
}

window._walletShowMain = function() { _showSection('wallet-section-main'); };

window._walletShowTopup = function() {
  _showSection('wallet-section-topup');
  setTimeout(function() {
    var el = document.getElementById('wt-custom-amount');
    if (el) el.focus();
  }, 100);
};

window._walletShowWithdraw = async function() {
  _showSection('wallet-section-withdraw');
  var sel = document.getElementById('wd-bank-select');
  if (!sel || sel.dataset.loaded) return;
  sel.innerHTML = '<option value="">Loading banks…</option>';
  var banks = await _loadBanks();
  if (!banks.length) {
    sel.innerHTML = '<option value="">Could not load banks. Try again.</option>';
    return;
  }
  sel.innerHTML = '<option value="">— Select your bank —</option>' +
    banks.map(function(b) {
      return '<option value="' + esc(b.code) + '">' + esc(b.name) + '</option>';
    }).join('');
  sel.dataset.loaded = 'true';
};

// ── Balance sync ──────────────────────────────────────────────────────────────

function _syncBalanceEverywhere(balance) {
  // Panel balance display
  var panelBal = document.getElementById('wallet-panel-balance');
  if (panelBal) panelBal.textContent = fmt(balance);
  // Nav badge
  var navBal = document.getElementById('wallet-nav-balance');
  if (navBal) navBal.textContent = fmt(balance);
  // Any data-wallet-balance elements
  document.querySelectorAll('[data-wallet-balance]').forEach(function(el) {
    el.textContent = fmt(balance);
  });
  // Profile page balance display
  renderWalletBalance('wallet-balance-display', balance);
}

// ── Transaction list in panel ─────────────────────────────────────────────────

async function _loadAndRenderTxns(uid) {
  var listEl = document.getElementById('wallet-panel-txns');
  if (!listEl) return;
  listEl.innerHTML = '<p class="wallet-empty">Loading…</p>';
  var txns = await loadWalletTransactions(uid, 30);
  renderWalletTransactions('wallet-panel-txns', txns);
}

// ── Top-up ────────────────────────────────────────────────────────────────────

window._walletDoTopup = function() {
  var ctx = window._walletCtx;
  if (!ctx) { notify.error('Wallet not ready. Please refresh.'); return; }

  var activePreset = document.querySelector('#wallet-section-topup .amount-preset.active');
  var customInput  = document.getElementById('wt-custom-amount');
  var raw = activePreset
    ? parseFloat(activePreset.dataset.v)
    : parseFloat((customInput && customInput.value) || '0');

  if (!raw || raw < 100) {
    notify.warning('Please select or enter a minimum of ₦100.');
    return;
  }

  if (typeof PaystackPop === 'undefined') {
    notify.error('Payment system not loaded. Please refresh.');
    return;
  }

  var amount = Math.round(raw);
  var ref    = 'wt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  _walletPayload = { uid: ctx.uid, amount: amount, onSuccess: ctx.onSuccess };

  var handler = PaystackPop.setup({
    key:      ctx.paystackKey,
    email:    ctx.email,
    amount:   amount * 100,
    currency: 'NGN',
    ref:      ref,
    metadata: {
      custom_fields: [
        { display_name: 'Purpose',     variable_name: 'purpose', value: 'Wallet Top-up' },
        { display_name: 'Customer ID', variable_name: 'uid',     value: ctx.uid }
      ]
    },
    callback: window._walletTopupCallback,
    onClose:  window._walletTopupOnClose
  });

  handler.openIframe();
};

// ── Withdrawal ────────────────────────────────────────────────────────────────

var _banksCache = null;

async function _loadBanks() {
  if (_banksCache) return _banksCache;
  try {
    // Paystack's bank list endpoint is public — no auth needed
    var res  = await fetch('https://api.paystack.co/bank?currency=NGN&perPage=200');
    var data = await res.json();
    if (data.status && Array.isArray(data.data)) {
      _banksCache = data.data
        .map(function(b) { return { name: b.name, code: b.code }; })
        .sort(function(a, b) { return a.name.localeCompare(b.name); });
      return _banksCache;
    }
  } catch (e) {
    console.warn('Could not load banks:', e.message);
  }
  return [];
}

window._walletResolveAccount = async function() {
  var acctInput   = document.getElementById('wd-account-number');
  var bankSel     = document.getElementById('wd-bank-select');
  var nameDisplay = document.getElementById('wd-account-name');
  if (!acctInput || !bankSel || !nameDisplay) return;

  var acctNo   = acctInput.value.trim();
  var bankCode = bankSel.value;

  if (acctNo.length !== 10 || !bankCode) {
    nameDisplay.textContent      = '';
    nameDisplay.dataset.verified = '';
    nameDisplay.dataset.acctName = '';
    return;
  }

  nameDisplay.textContent = 'Verifying account…';
  nameDisplay.style.color = '#6b7280';

  try {
    var res  = await fetch('/api/resolve-bank-account?account_number=' + acctNo + '&bank_code=' + bankCode);
    var data = await res.json();
    if (data.success) {
      nameDisplay.textContent      = data.account_name;
      nameDisplay.style.color      = '#16a34a';
      nameDisplay.dataset.verified = 'true';
      nameDisplay.dataset.acctName = data.account_name;
    } else {
      nameDisplay.textContent      = data.error || 'Account not found';
      nameDisplay.style.color      = '#dc2626';
      nameDisplay.dataset.verified = '';
      nameDisplay.dataset.acctName = '';
    }
  } catch (e) {
    nameDisplay.textContent      = 'Could not verify. Try again.';
    nameDisplay.style.color      = '#dc2626';
    nameDisplay.dataset.verified = '';
    nameDisplay.dataset.acctName = '';
  }
};

window._walletDoWithdraw = async function() {
  var ctx = window._walletCtx;
  if (!ctx) { notify.error('Wallet not ready. Please refresh.'); return; }

  var acctInput   = document.getElementById('wd-account-number');
  var bankSel     = document.getElementById('wd-bank-select');
  var amtInput    = document.getElementById('wd-amount');
  var nameDisplay = document.getElementById('wd-account-name');

  var acctNo     = (acctInput  && acctInput.value.trim()) || '';
  var bankCode   = (bankSel    && bankSel.value)          || '';
  var amount     = parseFloat((amtInput && amtInput.value) || '0');
  var acctName   = (nameDisplay && nameDisplay.dataset.acctName)  || '';
  var isVerified = (nameDisplay && nameDisplay.dataset.verified === 'true');

  if (acctNo.length !== 10)          { notify.warning('Enter a valid 10-digit account number.'); return; }
  if (!bankCode)                     { notify.warning('Please select your bank.'); return; }
  if (!isVerified || !acctName)      { notify.warning('Please verify your account number first.'); return; }
  if (!amount || amount < 100)       { notify.warning('Minimum withdrawal is ₦100.'); return; }
  if (amount > window.walletBalance) { notify.warning('Insufficient wallet balance.'); return; }

  var btn = document.getElementById('wd-submit-btn');

  // Confirm first, then require PIN, then execute
  notify.confirm(
    'Withdraw ' + fmt(amount) + ' to ' + acctName + '?',
    function() {
      if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
      _requirePin(ctx.uid, async function(pinToken) {
        if (!pinToken) {
          // PIN entry was cancelled
          if (btn) { btn.disabled = false; btn.textContent = 'Withdraw Funds'; }
          return;
        }
        btn && (btn.textContent = 'Processing…');
        try {
          var res  = await _walletPost('/api/wallet-withdraw', {
              uid:           ctx.uid,
              amount:        amount,
              accountNumber: acctNo,
              bankCode:      bankCode,
              accountName:   acctName,
              pinToken:      pinToken
          });
          var data = await res.json();

          if (data.success) {
            window.walletBalance = data.newBalance;
            _syncBalanceEverywhere(data.newBalance);
            notify.success(fmt(amount) + ' withdrawal initiated! Arrives in a few minutes.', 7000);
            if (acctInput)   acctInput.value      = '';
            if (bankSel)     bankSel.value         = '';
            if (amtInput)    amtInput.value        = '';
            if (nameDisplay) {
              nameDisplay.textContent      = '';
              nameDisplay.dataset.verified = '';
              nameDisplay.dataset.acctName = '';
            }
            _loadAndRenderTxns(ctx.uid);
            _showSection('wallet-section-main');
          } else {
            notify.error(data.error || 'Withdrawal failed. Please try again.', 8000);
            // If PIN session expired server-side, clear local token
            if (data.requirePin) _clearPinToken();
          }
        } catch (e) {
          notify.error('Withdrawal failed. Check your connection.', 8000);
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Withdraw Funds'; }
        }
      });
    },
    function() {}
  );
};



// ── PIN functions ─────────────────────────────────────────────────────────────

/**
 * Check if the user has a PIN set. If not, show the setup prompt.
 * Called after every successful top-up.
 */
async function _checkAndPromptPinSetup(uid) {
  try {
    var snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists() && snap.data().walletPinSet) return; // already set
  } catch (e) { return; } // non-fatal

  // Slight delay so the top-up success toast shows first
  setTimeout(function() { _showPinSetupPrompt(uid); }, 1200);
}

/**
 * Show a non-blocking prompt encouraging the user to set a PIN.
 * Has a "Set PIN" button and a "Maybe later" dismiss.
 */
function _showPinSetupPrompt(uid) {
  var existing = document.getElementById('wallet-pin-prompt');
  if (existing) existing.remove();

  var el = document.createElement('div');
  el.id  = 'wallet-pin-prompt';
  el.style.cssText = [
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);',
    'background:#0a0a0a;color:white;border-radius:14px;',
    'padding:16px 20px;max-width:360px;width:calc(100% - 32px);',
    'box-shadow:0 8px 32px rgba(0,0,0,0.25);z-index:999998;',
    'display:flex;align-items:center;gap:14px;font-family:inherit;',
    'animation:wpPromptIn .3s cubic-bezier(.34,1.56,.64,1) both;'
  ].join('');
  el.innerHTML = '<style>@keyframes wpPromptIn{from{opacity:0;transform:translateX(-50%) translateY(20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}</style>' +
    '<div style="font-size:22px;flex-shrink:0;">🔐</div>' +
    '<div style="flex:1;min-width:0;">' +
      '<div style="font-size:14px;font-weight:700;margin-bottom:3px;">Secure your wallet</div>' +
      '<div style="font-size:12px;color:rgba(255,255,255,0.6);line-height:1.4;">Set a 4-digit PIN to protect payments and withdrawals.</div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">' +
      '<button id="wp-set-btn" style="padding:7px 14px;background:white;color:#0a0a0a;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Set PIN</button>' +
      '<button id="wp-later-btn" style="padding:4px;background:none;border:none;color:rgba(255,255,255,0.5);font-size:11px;cursor:pointer;font-family:inherit;">Later</button>' +
    '</div>';

  document.body.appendChild(el);

  el.querySelector('#wp-set-btn').addEventListener('click', function() {
    el.remove();
    _showPinSetupPanel(uid);
  });
  el.querySelector('#wp-later-btn').addEventListener('click', function() {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(function() { el.remove(); }, 200);
  });

  // Auto-dismiss after 12 seconds
  setTimeout(function() {
    if (document.getElementById('wallet-pin-prompt')) {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function() { el.remove(); }, 300);
    }
  }, 12000);
}

/**
 * Show the PIN setup screen inside the wallet panel.
 */
function _showPinSetupPanel(uid) {
  window.openWalletPanel();
  _showSection('wallet-section-setpin');
  // Make sure the section exists — create it dynamically if needed
  _ensureSetPinSection(uid);
}

/**
 * Create the set-PIN section inside #wallet-panel if it doesn't exist yet.
 */
function _ensureSetPinSection(uid) {
  if (document.getElementById('wallet-section-setpin')) return;

  var panel = document.getElementById('wallet-panel');
  if (!panel) return;

  var sec = document.createElement('div');
  sec.id        = 'wallet-section-setpin';
  sec.className = 'wallet-section';
  sec.style.display = 'flex';
  sec.innerHTML =
    '<div class="wallet-back-row">' +
      '<button class="wallet-back-btn" onclick="window._walletShowMain()">&#8592; Back</button>' +
      '<h3 class="wallet-section-title">Set Wallet PIN</h3>' +
    '</div>' +
    '<div class="wallet-form-body">' +
      '<p style="font-size:13px;color:#6b7280;margin:0;">Create a 4-digit PIN to protect wallet payments and withdrawals.</p>' +
      '<div class="wallet-field">' +
        '<label>New PIN</label>' +
        '<div id="sp-pin-dots" class="wallet-pin-dots"></div>' +
        '<div class="wallet-numpad" id="sp-numpad"></div>' +
      '</div>' +
      '<div class="wallet-field" id="sp-confirm-wrap" style="display:none;">' +
        '<label>Confirm PIN</label>' +
        '<div id="sp-confirm-dots" class="wallet-pin-dots"></div>' +
      '</div>' +
      '<p id="sp-error" style="font-size:12px;color:#dc2626;min-height:16px;margin:0;"></p>' +
    '</div>';

  panel.appendChild(sec);
  _buildNumpad('sp-numpad', 'sp-pin-entry', uid);
}

/**
 * Show the PIN entry modal (for payments/withdrawals).
 * Calls onDone(token) on success, onDone(null) on cancel.
 */
function _showPinEntryModal(uid, onDone) {
  var existing = document.getElementById('wallet-pin-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id  = 'wallet-pin-modal';
  modal.style.cssText = [
    'position:fixed;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);',
    'display:flex;align-items:center;justify-content:center;z-index:999999;padding:16px;'
  ].join('');

  modal.innerHTML =
    '<div style="background:white;border-radius:20px;width:100%;max-width:340px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.3);font-family:inherit;">' +
      '<div style="background:#0a0a0a;color:white;padding:18px 20px;display:flex;justify-content:space-between;align-items:center;">' +
        '<div>' +
          '<div style="font-size:16px;font-weight:700;">Enter Wallet PIN</div>' +
          '<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:2px;">Required to complete this action</div>' +
        '</div>' +
        '<button id="pin-modal-close" style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;">&#215;</button>' +
      '</div>' +
      '<div style="padding:24px 20px 20px;">' +
        '<div id="pm-pin-dots" class="wallet-pin-dots" style="margin-bottom:20px;"></div>' +
        '<div class="wallet-numpad" id="pm-numpad"></div>' +
        '<p id="pm-error" style="font-size:12px;color:#dc2626;text-align:center;min-height:16px;margin:8px 0 0;"></p>' +
        '<button id="pm-forgot-btn" style="display:block;margin:10px auto 0;background:none;border:none;color:#6b7280;font-size:12px;cursor:pointer;font-family:inherit;text-decoration:underline;">Forgot PIN?</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  var closeAndCancel = function() {
    modal.remove();
    onDone(null);
  };
  modal.querySelector('#pin-modal-close').addEventListener('click', closeAndCancel);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeAndCancel(); });

  modal.querySelector('#pm-forgot-btn').addEventListener('click', function() {
    modal.remove();
    _showForgotPin(uid);
  });

  _buildNumpad('pm-numpad', 'pm-pin-verify', uid, onDone, modal);
}

// ── Number pad builder ────────────────────────────────────────────────────────

function _buildNumpad(containerId, mode, uid, onDone, modal) {
  var container = document.getElementById(containerId);
  if (!container) return;

  var digits    = [];
  var phase     = 'enter'; // 'enter' | 'confirm' (set-pin only)
  var firstPin  = '';

  var KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  container.innerHTML = KEYS.map(function(k) {
    if (!k) return '<div></div>';
    return '<button class="wallet-numpad-key" data-k="' + k + '">' + k + '</button>';
  }).join('');

  function dotsId()  { return mode === 'pm-pin-verify' ? 'pm-pin-dots' : (phase === 'confirm' ? 'sp-confirm-dots' : 'sp-pin-dots'); }
  function errorId() { return mode === 'pm-pin-verify' ? 'pm-error' : 'sp-error'; }

  function updateDots() {
    var el = document.getElementById(dotsId());
    if (!el) return;
    el.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      var dot = document.createElement('div');
      dot.className = 'wallet-pin-dot' + (i < digits.length ? ' filled' : '');
      el.appendChild(dot);
    }
  }
  updateDots();

  function setError(msg) {
    var el = document.getElementById(errorId());
    if (el) el.textContent = msg;
  }

  container.addEventListener('click', async function(e) {
    var key = e.target.closest('.wallet-numpad-key');
    if (!key) return;
    var k = key.dataset.k;

    if (k === '⌫') {
      digits.pop();
      updateDots();
      setError('');
      return;
    }

    if (digits.length >= 4) return;
    digits.push(k);
    updateDots();
    setError('');

    if (digits.length < 4) return;

    var pin = digits.join('');

    // ── SET PIN flow ──────────────────────────────────────────────────────
    if (mode === 'sp-pin-entry') {
      if (phase === 'enter') {
        firstPin = pin;
        digits   = [];
        phase    = 'confirm';
        // Show confirm section
        var cw = document.getElementById('sp-confirm-wrap');
        if (cw) cw.style.display = '';
        updateDots();
        setError('');
        return;
      }
      // Confirm phase
      if (pin !== firstPin) {
        digits  = [];
        phase   = 'enter';
        firstPin = '';
        var cw = document.getElementById('sp-confirm-wrap');
        if (cw) cw.style.display = 'none';
        updateDots();
        setError('PINs don’t match. Please try again.');
        return;
      }
      // PINs match — save
      setError('');
      container.querySelectorAll('.wallet-numpad-key').forEach(function(b) { b.disabled = true; });
      try {
        var res  = await _walletPost('/api/wallet-set-pin', { uid: uid, pin: pin });
        var data = await res.json();
        if (data.success) {
          notify.success('Wallet PIN set! Your wallet is now protected.', 5000);
          _showSection('wallet-section-main');
          var sec = document.getElementById('wallet-section-setpin');
          if (sec) sec.remove();
        } else {
          setError(data.error || 'Could not save PIN. Try again.');
          digits = []; phase = 'enter'; firstPin = '';
          var cw = document.getElementById('sp-confirm-wrap');
          if (cw) cw.style.display = 'none';
          updateDots();
          container.querySelectorAll('.wallet-numpad-key').forEach(function(b) { b.disabled = false; });
        }
      } catch(e) {
        setError('Network error. Please try again.');
        digits = []; updateDots();
        container.querySelectorAll('.wallet-numpad-key').forEach(function(b) { b.disabled = false; });
      }
      return;
    }

    // ── VERIFY PIN flow ───────────────────────────────────────────────────
    container.querySelectorAll('.wallet-numpad-key').forEach(function(b) { b.disabled = true; });
    try {
      var res  = await _walletPost('/api/wallet-verify-pin', { uid: uid, pin: pin });
      var data = await res.json();
      if (data.success && data.token) {
        _storePinToken(data.token);
        if (modal) modal.remove();
        onDone(data.token);
      } else {
        setError(data.error || 'Incorrect PIN.');
        digits = []; updateDots();
        container.querySelectorAll('.wallet-numpad-key').forEach(function(b) { b.disabled = false; });
      }
    } catch(e) {
      setError('Network error. Please try again.');
      digits = []; updateDots();
      container.querySelectorAll('.wallet-numpad-key').forEach(function(b) { b.disabled = false; });
    }
  });
}

/**
 * Gate function: if PIN session is still valid use the cached token,
 * otherwise show the PIN entry modal first.
 */
function _requirePin(uid, onDone) {
  if (_pinTokenValid()) {
    onDone(window._walletPinToken);
    return;
  }
  _showPinEntryModal(uid, onDone);
}

/**
 * Forgot PIN — re-authenticate via Firebase then allow reset.
 */
function _showForgotPin(uid) {
  notify.info('To reset your PIN, please log out and log back in. Your PIN will be reset on next setup.', 8000);
  // A production implementation would trigger email re-auth here.
  // For now this guides the user to re-authenticate, after which
  // they can call wallet-set-pin again (it overwrites the old hash).
}

// ── Preset button helpers (called from HTML) ──────────────────────────────────

window._walletSelectPreset = function(btn) {
  // Deactivate all presets in this section then activate clicked one
  var presets = document.querySelectorAll('#wallet-section-topup .amount-preset');
  presets.forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  // Clear custom input
  var custom = document.getElementById('wt-custom-amount');
  if (custom) custom.value = '';
};

window._walletClearPresets = function() {
  var presets = document.querySelectorAll('#wallet-section-topup .amount-preset');
  presets.forEach(function(b) { b.classList.remove('active'); });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
