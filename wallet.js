// ============================================================
//  CGrocs — wallet.js
//  Client-side wallet module.
//
//  Provides:
//    loadWalletBalance(uid)               → number
//    loadWalletTransactions(uid, limit)   → Array
//    renderWalletBalance(elementId, bal)  → void
//    renderWalletTransactions(el, txns)   → void
//    openTopupModal(uid, email, key, cb)  → void
//
//  Also exposes on window:
//    window.walletBalance    — cached balance (read by cart.js)
//    window.openWalletTopup  — no-arg shortcut (uses window._walletCtx)
// ============================================================

import { initializeApp, getApps }  from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js';
import {
  getFirestore, doc, getDoc, collection, getDocs, query, orderBy, limit as fsLimit
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';
import { customerConfig } from './firebase-config.js';

const app = getApps().find(a => a.name === 'cardstorage')
  || initializeApp(customerConfig, 'cardstorage');
const db = getFirestore(app);

// Cached balance — read by cart.js
window.walletBalance = 0;

// ── Balance ───────────────────────────────────────────────────────────────────

/** Load the customer's wallet balance from Firestore and cache it. */
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

/** Update a DOM element with a formatted naira balance. */
export function renderWalletBalance(elementId, balance) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = fmt(balance);
}

// ── Transactions ──────────────────────────────────────────────────────────────

/** Load wallet transaction history (newest first). */
export async function loadWalletTransactions(uid, limitCount = 20) {
  try {
    const q    = query(
      collection(db, `users/${uid}/walletTransactions`),
      orderBy('date', 'desc'),
      fsLimit(limitCount)
    );
    const snap = await getDocs(q);
    const txns = [];
    snap.forEach(d => txns.push({ id: d.id, ...d.data() }));
    return txns;
  } catch (e) {
    console.warn('wallet.js: could not load transactions:', e.message);
    return [];
  }
}

/** Render a transaction list into a container element. */
export function renderWalletTransactions(elementId, transactions) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!transactions || transactions.length === 0) {
    el.innerHTML = '<p class="wallet-empty">No transactions yet.</p>';
    return;
  }

  el.innerHTML = transactions.map(tx => {
    const isCredit = tx.type === 'credit';
    const dateStr  = tx.date
      ? new Date(tx.date).toLocaleDateString('en-NG', {
          day: 'numeric', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        })
      : '—';
    const desc = esc(tx.description || (isCredit ? 'Top-up' : 'Purchase'));

    return `
    <div class="wallet-tx-item">
      <div class="wallet-tx-left">
        <span class="wallet-tx-icon ${isCredit ? 'tx-credit' : 'tx-debit'}">${isCredit ? '↑' : '↓'}</span>
        <div>
          <div class="wallet-tx-desc">${desc}</div>
          <div class="wallet-tx-date">${dateStr}</div>
        </div>
      </div>
      <div class="wallet-tx-right">
        <div class="wallet-tx-amount ${isCredit ? 'amount-credit' : 'amount-debit'}">
          ${isCredit ? '+' : '−'}${fmt(tx.amount || 0)}
        </div>
        <div class="wallet-tx-bal">Bal: ${fmt(tx.balanceAfter || 0)}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Top-up modal ──────────────────────────────────────────────────────────────

/**
 * Open the wallet top-up modal.
 * @param {string}   uid              Firebase UID of the logged-in customer
 * @param {string}   userEmail        Customer email (passed to Paystack)
 * @param {string}   paystackKey      Paystack public key
 * @param {Function} [onSuccess]      Called with newBalance after a successful top-up
 */
export function openTopupModal(uid, userEmail, paystackKey, onSuccess) {
  const existing = document.getElementById('wallet-topup-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id    = 'wallet-topup-modal';
  modal.className = 'wallet-modal-overlay';
  modal.innerHTML = `
    <div class="wallet-modal-box">
      <div class="wallet-modal-header">
        <h2>Top Up Wallet</h2>
        <button id="wt-close" class="wallet-modal-close" aria-label="Close">&#215;</button>
      </div>
      <div class="wallet-modal-body">
        <p class="wallet-modal-sub">Funds are added instantly. Powered by Paystack.</p>

        <div class="wallet-amount-presets">
          <button class="amount-preset" data-v="500">₦500</button>
          <button class="amount-preset" data-v="1000">₦1,000</button>
          <button class="amount-preset" data-v="2000">₦2,000</button>
          <button class="amount-preset" data-v="5000">₦5,000</button>
        </div>

        <div class="wallet-field">
          <label for="wt-amount">Or enter custom amount</label>
          <div class="wallet-amount-wrap">
            <span class="wallet-currency">₦</span>
            <input type="number" id="wt-amount" placeholder="0" min="100" step="50">
          </div>
          <span class="wallet-hint">Minimum: ₦100</span>
        </div>

        <button id="wt-pay-btn" class="wallet-btn-primary">Continue to Payment</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('wallet-modal-visible'), 10);

  // Preset buttons
  modal.querySelectorAll('.amount-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.amount-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const input = document.getElementById('wt-amount');
      if (input) input.value = btn.dataset.v;
    });
  });

  // Close helpers
  const closeModal = () => {
    modal.classList.remove('wallet-modal-visible');
    setTimeout(() => modal.remove(), 220);
  };
  modal.querySelector('#wt-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Pay button
  modal.querySelector('#wt-pay-btn').addEventListener('click', () => {
    const raw = parseFloat(document.getElementById('wt-amount')?.value || '0');
    if (!raw || raw < 100) {
      notify.warning('Please enter a minimum of ₦100.');
      return;
    }
    const amount = Math.round(raw); // whole naira

    if (typeof PaystackPop === 'undefined') {
      notify.error('Payment system not loaded. Please refresh.');
      return;
    }

    closeModal();

    // Unique reference for this top-up
    const ref = 'wt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    const handler = PaystackPop.setup({
      key:      paystackKey,
      email:    userEmail,
      amount:   amount * 100, // kobo
      currency: 'NGN',
      ref,
      metadata: {
        custom_fields: [
          { display_name: 'Purpose',    variable_name: 'purpose', value: 'Wallet Top-up' },
          { display_name: 'Customer ID', variable_name: 'uid',    value: uid }
        ]
      },
      callback: async (response) => {
        const toastId = notify.info('Verifying payment…', 15000);
        try {
          const res  = await fetch('/api/verify-wallet-topup', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ reference: response.reference, uid, amount })
          });
          const data = await res.json();

          if (data.success) {
            window.walletBalance = data.newBalance;
            _updateAllBalanceDisplays(data.newBalance);
            notify.success(`${fmt(amount)} added to your wallet!`, 5000);
            if (typeof onSuccess === 'function') onSuccess(data.newBalance);
          } else {
            notify.error('Top-up failed: ' + (data.error || 'Unknown error.'), 8000);
          }
        } catch {
          notify.error(
            'Top-up verification failed. Contact support if you were charged.',
            10000
          );
        }
      },
      onClose: () => notify.info('Top-up cancelled.')
    });

    handler.openIframe();
  });

  setTimeout(() => document.getElementById('wt-amount')?.focus(), 120);
}

/** Update every wallet balance display element on the page. */
function _updateAllBalanceDisplays(balance) {
  document.querySelectorAll('[data-wallet-balance]').forEach(el => {
    el.textContent = fmt(balance);
  });
  // Also update the explicit IDs used in profile and customer pages
  ['wallet-balance-display', 'wallet-nav-balance'].forEach(id => {
    renderWalletBalance(id, balance);
  });
}

// ── Global shortcut ───────────────────────────────────────────────────────────

/**
 * Set the context needed for the no-arg shortcut below.
 * Call this from profile.js / customer.html after auth resolves.
 */
export function setWalletContext(uid, email, paystackKey, onSuccess) {
  window._walletCtx = { uid, email, paystackKey, onSuccess };
}

/** No-argument shortcut suitable for onclick="window.openWalletTopup()" in HTML. */
window.openWalletTopup = function () {
  const ctx = window._walletCtx;
  if (!ctx) { notify.error('Wallet not initialised. Please refresh.'); return; }
  openTopupModal(ctx.uid, ctx.email, ctx.paystackKey, ctx.onSuccess);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
