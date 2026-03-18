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

window.walletBalance = 0;

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
  fetch('/api/verify-wallet-topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: response.reference, uid: payload.uid, amount: payload.amount })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      window.walletBalance = data.newBalance;
      _syncBalanceEverywhere(data.newBalance);
      notify.success('₦' + Number(payload.amount).toLocaleString('en-NG') + ' added to your wallet!', 5000);
      if (typeof payload.onSuccess === 'function') payload.onSuccess(data.newBalance);
      if (payload.uid) _loadAndRenderTxns(payload.uid);
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

  notify.confirm(
    'Withdraw ' + fmt(amount) + ' to ' + acctName + '?',
    async function() {
      if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
      try {
        var res  = await fetch('/api/wallet-withdraw', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid:           ctx.uid,
            amount:        amount,
            accountNumber: acctNo,
            bankCode:      bankCode,
            accountName:   acctName
          })
        });
        var data = await res.json();

        if (data.success) {
          window.walletBalance = data.newBalance;
          _syncBalanceEverywhere(data.newBalance);
          notify.success(fmt(amount) + ' withdrawal initiated! Arrives in a few minutes.', 7000);
          // Clear form
          if (acctInput)   acctInput.value       = '';
          if (bankSel)     { bankSel.value = ''; }
          if (amtInput)    amtInput.value        = '';
          if (nameDisplay) {
            nameDisplay.textContent       = '';
            nameDisplay.dataset.verified  = '';
            nameDisplay.dataset.acctName  = '';
          }
          _loadAndRenderTxns(ctx.uid);
          _showSection('wallet-section-main');
        } else {
          notify.error(data.error || 'Withdrawal failed. Please try again.', 8000);
        }
      } catch (e) {
        notify.error('Withdrawal failed. Check your connection.', 8000);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Withdraw Funds'; }
      }
    },
    function() {}
  );
};


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
