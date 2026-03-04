// head-admin.js — Head Cashier / Head Admin dashboard
import { initializeApp, getApps }              from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  createUserWithEmailAndPassword, signOut
}                                               from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot,
  getDocs, doc, getDoc, setDoc, updateDoc, query, orderBy
}                                               from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { headAdminConfig, adminConfig, customerConfig } from "./firebase-config.js";

// ── Firebase setup ────────────────────────────────────────────────────────────
// Reuse the app instances already created by admin-auth-guard.js
// Auth lives in the head-admin project
const adminApp  = getApps().find(a => a.name === 'head-admin-guard')
  || initializeApp(headAdminConfig, 'head-admin-guard');
const adminAuth = getAuth(adminApp);

// Cashier profiles are stored in the regular admin project (cloexadminlogin)
const cashierApp = getApps().find(a => a.name === 'admin-guard')
  || initializeApp(adminConfig, 'admin-guard');
const cashierDb  = getFirestore(cashierApp);

const custApp = getApps().find(a => a.name === 'cardstorage')
  || initializeApp(customerConfig, 'cardstorage');
const custDb  = getFirestore(custApp);

// ── State ─────────────────────────────────────────────────────────────────────
let _allPurchases    = [];
let _purchFilter     = 'all';
let _allCashiers     = {};        // { email: { name, role, verifiedCount, total } }
let _selectedCashier = null;
let _purchUnsub      = null;
let _cashierNameMap  = {};
let _allProdLogs     = [];
let _prodFilter      = 'all';
let _prodUnsub       = null;        // { email → displayName } loaded from cashiers collection

// ── Auth: wire name/avatar once guard confirms login ─────────────────────────
onAuthStateChanged(adminAuth, async (user) => {
  if (!user) return;

  // Load this admin's cashier profile for display in the nav
  try {
    const snap = await getDoc(doc(cashierDb, 'cashiers', user.uid));
    const data  = snap.exists() ? snap.data() : {};
    const name  = data.name || user.email.split('@')[0];
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const avatarEl = document.getElementById('ha-avatar');
    const nameEl   = document.getElementById('ha-name');
    if (avatarEl) avatarEl.textContent = initials;
    if (nameEl)   nameEl.textContent   = name;
  } catch (e) { /* non-fatal */ }

  // Load cashier name map first, then start listeners
  await loadCashierNameMap();
  startPurchasesListener();
  startProductLogsListener();
  loadAccounts();
});

// ── CASHIER NAME MAP ─────────────────────────────────────────────────────────
async function loadCashierNameMap() {
  try {
    const snap = await getDocs(collection(cashierDb, 'cashiers'));
    snap.forEach(d => {
      const data = d.data();
      if (data.email) {
        _cashierNameMap[data.email.toLowerCase()] = data.name || data.email;
      }
    });
    console.log('Cashier name map loaded:', Object.keys(_cashierNameMap).length, 'entries');
  } catch (e) {
    console.warn('Could not load cashier name map:', e.message);
  }
}

// Helper: resolve a cashier's display name from stored fields or the name map
function resolveCashierName(purchase) {
  if (purchase.verifiedByName) return purchase.verifiedByName;
  const email = (purchase.verifiedBy || '').toLowerCase();
  if (email && _cashierNameMap[email]) return _cashierNameMap[email];
  return purchase.verifiedBy || 'Unknown';
}

// ── REAL-TIME PURCHASES LISTENER ─────────────────────────────────────────────
function startPurchasesListener() {
  if (_purchUnsub) return; // already listening

  _purchUnsub = onSnapshot(
    collection(custDb, 'purchases'),
    (snap) => {
      _allPurchases = [];
      snap.forEach(d => _allPurchases.push({ ...d.data(), _docId: d.id }));
      _allPurchases.sort((a, b) => new Date(b.date) - new Date(a.date));

      updateStats();
      renderPurchaseList();
      buildCashierData();
    },
    (e) => {
      console.error('Purchases listener error:', e);
      notify.error('Could not load purchases: ' + e.message);
    }
  );
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const total    = _allPurchases.length;
  const verified = _allPurchases.filter(p => p.verified).length;
  const pending  = total - verified;
  const revenue  = _allPurchases
    .filter(p => p.verified)
    .reduce((s, p) => s + (p.total || 0), 0);

  setText('s-total',    total);
  setText('s-verified', verified);
  setText('s-pending',  pending);
  setText('s-revenue',  '₦' + revenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }));

  const sub = document.getElementById('purch-subtitle');
  if (sub) sub.textContent = `${total} purchase${total !== 1 ? 's' : ''} · live updates on`;
}

// ── PURCHASE LIST RENDER ──────────────────────────────────────────────────────
window.setPurchFilter = function(btn) {
  document.querySelectorAll('#tab-purchases .filter-pill[data-f]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _purchFilter = btn.dataset.f;
  applyPurchaseFilters();
};

window.applyPurchaseFilters = function() {
  const search  = (document.getElementById('purch-search')?.value || '').toLowerCase().trim();
  const dateVal = document.getElementById('purch-date')?.value;

  let list = _allPurchases;

  // Status filter
  if (_purchFilter === 'verified') list = list.filter(p => p.verified);
  if (_purchFilter === 'pending')  list = list.filter(p => !p.verified);

  // Date filter
  if (dateVal) {
    const picked = new Date(dateVal + 'T00:00:00').toDateString();
    list = list.filter(p => p.date && new Date(p.date).toDateString() === picked);
  }

  // Search
  if (search) {
    list = list.filter(p => {
      const fields = [
        p.id, p.customerName, p.email,
        (p.items || []).map(i => i.name).join(' '),
        p.verifiedByName, p.verifiedBy
      ].join(' ').toLowerCase();
      return fields.includes(search);
    });
  }

  renderPurchaseList(list);
};

function renderPurchaseList(list) {
  if (!list) list = _allPurchases;
  const container = document.getElementById('purch-list');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = `<div class="list-empty"><span class="list-empty-icon">🔍</span>No purchases match your filters.</div>`;
    return;
  }

  container.innerHTML = list.map(p => {
    const date       = p.date ? new Date(p.date).toLocaleString('en-NG', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const amount     = '₦' + (p.total ? p.total.toLocaleString('en-NG', { minimumFractionDigits:2 }) : '0.00');
    const items      = (p.items || []).map(i => `${i.quantity}× ${i.name}`).join(', ') || '—';
    const badge      = p.verified
      ? `<span class="badge badge-verified">✓ Verified</span>`
      : `<span class="badge badge-pending">⏳ Pending</span>`;
    const cashierCol = p.verified
      ? `<span class="cashier-chip"><span class="cashier-dot"></span>${resolveCashierName(p)}</span>`
      : `<span style="color:var(--muted);font-size:12px;">—</span>`;

    const safeId = (p.id || '').replace(/'/g, "\\'");
    const safeDocId = (p._docId || '').replace(/'/g, "\\'");
    const actionBtn = p.verified
      ? `<button class="btn-reprint" onclick="reprintReceipt('${safeId}')">🖨 Print</button>`
      : `<div style="display:flex;flex-direction:column;gap:4px;">
           <button class="btn-verify-ha" onclick="verifyPurchaseHA('${safeDocId}','${safeId}')">✓ Verify</button>
           <button class="btn-reprint" onclick="reprintReceipt('${safeId}')">🖨 Print</button>
         </div>`;
    return `
    <div class="list-row lr-purchases" id="ha-row-${p._docId}">
      <div>
        <div class="row-id">${p.id || '—'}</div>
        ${badge}
      </div>
      <div>
        <div class="row-customer">${p.customerName || p.email || 'Unknown'}</div>
        <div class="row-items">${items}</div>
      </div>
      <div class="row-amount">${amount}</div>
      <div class="col-cashier">${cashierCol}</div>
      <div class="row-date">${date}</div>
      <div>${actionBtn}</div>
    </div>`;
  }).join('');
}

// ── BY CASHIER TAB ────────────────────────────────────────────────────────────
function buildCashierData() {
  _allCashiers = {};

  _allPurchases.filter(p => p.verified).forEach(p => {
    const key  = p.verifiedBy || 'unknown';
    const name = resolveCashierName(p);
    if (!_allCashiers[key]) {
      _allCashiers[key] = { name, email: key, count: 0, total: 0, purchases: [] };
    }
    _allCashiers[key].count++;
    _allCashiers[key].total += (p.total || 0);
    _allCashiers[key].purchases.push(p);
  });

  renderCashierGrid();
  // Re-render detail if a cashier is selected
  if (_selectedCashier && _allCashiers[_selectedCashier]) {
    renderCashierDetail(_selectedCashier);
  }
}

function renderCashierGrid() {
  const grid = document.getElementById('cashier-grid');
  if (!grid) return;

  const entries = Object.entries(_allCashiers);
  if (entries.length === 0) {
    grid.innerHTML = `<div class="list-empty"><span class="list-empty-icon">👤</span>No verified purchases yet.</div>`;
    return;
  }

  grid.innerHTML = entries
    .sort(([,a],[,b]) => b.count - a.count)
    .map(([key, c]) => {
      const initials = c.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
      const isSelected = _selectedCashier === key;
      return `
      <div class="cashier-summary-card${isSelected ? ' selected' : ''}" onclick="selectCashier('${key}')">
        <div class="cs-top">
          <div class="cs-avatar">${initials}</div>
          <div>
            <div class="cs-name">${c.name}</div>
            <div class="cs-email">${c.email !== 'unknown' ? c.email : '—'}</div>
          </div>
        </div>
        <div class="cs-stats">
          <div>
            <div class="cs-stat-val">${c.count}</div>
            <div class="cs-stat-lbl">Verified</div>
          </div>
          <div>
            <div class="cs-stat-val">₦${c.total.toLocaleString('en-NG', { minimumFractionDigits:0 })}</div>
            <div class="cs-stat-lbl">Total Value</div>
          </div>
        </div>
      </div>`;
    }).join('');
}

window.selectCashier = function(key) {
  _selectedCashier = key;
  renderCashierGrid();
  renderCashierDetail(key);
};

function renderCashierDetail(key) {
  const cashier    = _allCashiers[key];
  const detailWrap = document.getElementById('cashier-detail');
  const titleEl    = document.getElementById('cashier-detail-title');
  const listEl     = document.getElementById('cashier-detail-list');
  if (!detailWrap || !cashier) return;

  detailWrap.style.display = 'block';
  titleEl.textContent = `Verified by ${cashier.name}`;

  const sorted = [...cashier.purchases].sort((a, b) => new Date(b.verifiedDate || b.date) - new Date(a.verifiedDate || a.date));

  listEl.innerHTML = sorted.map(p => {
    const verifiedAt = p.verifiedDate
      ? new Date(p.verifiedDate).toLocaleString('en-NG', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
      : '—';
    const amount = '₦' + (p.total ? p.total.toLocaleString('en-NG', { minimumFractionDigits:2 }) : '0.00');
    const items  = (p.items || []).map(i => `${i.quantity}× ${i.name}`).join(', ') || '—';

    return `
    <div class="list-row lr-cashier">
      <div class="row-id">${p.id || '—'}</div>
      <div class="row-amount">${amount}</div>
      <div class="row-items col-purchases">${items}</div>
      <div class="row-date">${verifiedAt}</div>
    </div>`;
  }).join('');
}

// ── MANAGE ACCOUNTS ───────────────────────────────────────────────────────────
async function loadAccounts() {
  const listEl = document.getElementById('accounts-list-body');
  if (!listEl) return;
  try {
    const snap = await getDocs(collection(cashierDb, 'cashiers'));
    const accounts = [];
    snap.forEach(d => accounts.push({ uid: d.id, ...d.data() }));

    if (accounts.length === 0) {
      listEl.innerHTML = `<div class="list-empty" style="padding:28px;"><span class="list-empty-icon">👤</span>No accounts yet.</div>`;
      return;
    }

    listEl.innerHTML = accounts
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(a => {
        const isHead = a.role === 'Head Cashier' || a.role === 'Supervisor';
        return `
        <div class="account-row">
          <div class="acc-info">
            <div class="acc-name">${a.name || '—'}</div>
            <div class="acc-email">${a.email || '—'}</div>
          </div>
          <span class="acc-role-badge${isHead ? ' head' : ''}">${a.role || 'Cashier'}</span>
        </div>`;
      }).join('');
  } catch (e) {
    console.error('Could not load accounts:', e);
    listEl.innerHTML = `<div class="list-empty" style="padding:28px;">Could not load accounts.</div>`;
  }
}

// Create a new cashier account.
// Uses a SEPARATE temporary Firebase app instance so that creating the new user
// does NOT sign out the currently logged-in head admin.
window.createAccount = async function() {
  const first    = document.getElementById('new-first').value.trim();
  const last     = document.getElementById('new-last').value.trim();
  const role     = document.getElementById('new-role').value;
  const email    = document.getElementById('new-email').value.trim();
  const password = document.getElementById('new-password').value;

  if (!first || !last)    { notify.error('Please enter first and last name.'); return; }
  if (!email)             { notify.error('Please enter an email address.');    return; }
  if (!password)          { notify.error('Please enter a password.');          return; }
  if (password.length < 6){ notify.error('Password must be at least 6 characters.'); return; }

  const btn = document.getElementById('btn-create-account');
  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    // Temporary isolated app — won't affect the current admin session
    const tempApp  = initializeApp(adminConfig, 'temp-create-' + Date.now());
    const tempAuth = getAuth(tempApp);

    const cred = await createUserWithEmailAndPassword(tempAuth, email, password);
    const uid  = cred.user.uid;

    // Sign out from the temp app immediately — this doesn't touch the main session
    await signOut(tempAuth);

    // Save the profile in cashierDb/cashiers
    const profileData = {
      name:      `${first} ${last}`,
      role,
      email,
      uid,
      createdAt: new Date().toISOString()
    };
    await setDoc(doc(cashierDb, 'cashiers', uid), profileData);

    notify.success(`Account created for ${first} ${last}!`);

    // Clear form
    ['new-first','new-last','new-email','new-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // Refresh accounts list
    loadAccounts();

  } catch (e) {
    console.error('Create account error:', e);
    const code = e.code || '';
    if (code === 'auth/email-already-in-use') {
      notify.error('This email is already registered.');
    } else if (code === 'auth/invalid-email') {
      notify.error('Please enter a valid email address.');
    } else if (code === 'auth/weak-password') {
      notify.error('Password is too weak. Use at least 6 characters.');
    } else {
      notify.error('Could not create account: ' + e.message);
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create Account';
  }
};

// ── VERIFY PURCHASE (head admin) ─────────────────────────────────────────────
window.verifyPurchaseHA = async function(docId, purchaseId) {
  if (!docId) { notify.error('Cannot verify: document ID missing.'); return; }

  const verifiedDate = new Date().toISOString();
  const headAdminEmail = (window.currentHeadAdmin && window.currentHeadAdmin.email) || '';

  try {
    await updateDoc(doc(custDb, 'purchases', docId), {
      verified:       true,
      verifiedDate:   verifiedDate,
      verifiedBy:     headAdminEmail,
      verifiedByName: 'Head Admin'
    });
    notify.success('Purchase verified successfully.');
    // onSnapshot will re-render the list automatically
  } catch (e) {
    console.error('Verify error:', e);
    notify.error('Could not verify purchase: ' + e.message);
  }
};

// ── REPRINT RECEIPT ──────────────────────────────────────────────────────────
window.reprintReceipt = function(purchaseId) {
  const purchase = _allPurchases.find(p => p.id === purchaseId);
  if (!purchase) { notify.error('Purchase not found.'); return; }

  const customerName  = purchase.customerName  || purchase.email || 'Unknown';
  const customerPhone = purchase.customerPhone || '—';
  const customerEmail = purchase.email         || '—';
  const cashierName   = resolveCashierName(purchase);

  const printWindow = window.open('', '', 'width=800,height=700');
  printWindow.document.write(`
    <!DOCTYPE html><html><head><title>Receipt - ${purchase.id}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:Arial,sans-serif;padding:28px;max-width:620px;margin:0 auto;color:#111;}
      .receipt-header{text-align:center;border-bottom:2px solid #111;padding-bottom:18px;margin-bottom:20px;}
      .receipt-header h1{font-size:28px;font-weight:900;}
      .receipt-header h2{font-size:15px;font-weight:400;color:#555;margin-top:4px;}
      .verified-badge{display:inline-block;margin-top:10px;background:#111;color:white;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700;}
      .pending-badge{display:inline-block;margin-top:10px;background:#f59e0b;color:white;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700;}
      .section{margin:18px 0;}
      .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #eee;}
      .detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:14px;}
      .detail-row span:first-child{color:#555;}
      .detail-row span:last-child{font-weight:600;text-align:right;max-width:60%;}
      .items-table{width:100%;border-collapse:collapse;margin-top:6px;}
      .items-table th{background:#f5f5f5;padding:9px 10px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#888;}
      .items-table td{padding:9px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;}
      .totals-table{width:100%;border-collapse:collapse;margin-top:12px;}
      .totals-table td{padding:7px 10px;font-size:14px;}
      .grand-total{font-size:18px;font-weight:800;border-top:2px solid #111;}
      .grand-total td{padding-top:12px;}
      .footer{text-align:center;margin-top:36px;color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:16px;}
    </style></head><body>
    <div class="receipt-header">
      <h1>ColEx</h1><h2>Purchase Receipt</h2>
      ${purchase.verified
        ? '<div class="verified-badge">✓ VERIFIED</div>'
        : '<div class="pending-badge">⏳ PENDING</div>'}
    </div>
    <div class="section">
      <div class="section-title">Customer</div>
      <div class="detail-row"><span>Name</span><span>${customerName}</span></div>
      <div class="detail-row"><span>Phone</span><span>${customerPhone}</span></div>
      <div class="detail-row"><span>Email</span><span>${customerEmail}</span></div>
    </div>
    <div class="section">
      <div class="section-title">Order Info</div>
      <div class="detail-row"><span>Purchase ID</span><span style="font-family:monospace;font-size:12px;">${purchase.id}</span></div>
      <div class="detail-row"><span>Date</span><span>${new Date(purchase.date).toLocaleString()}</span></div>
      <div class="detail-row"><span>Payment Ref</span><span style="font-family:monospace;font-size:12px;">${purchase.reference || '—'}</span></div>
      ${purchase.verified
        ? `<div class="detail-row"><span>Verified At</span><span>${new Date(purchase.verifiedDate).toLocaleString()}</span></div>
           <div class="detail-row"><span>Verified By</span><span>${cashierName}</span></div>`
        : ''}
    </div>
    <div class="section">
      <div class="section-title">Items</div>
      <table class="items-table">
        <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead>
        <tbody>
          ${(purchase.items || []).map(item => `
            <tr>
              <td>${item.name}</td><td>${item.quantity}</td>
              <td>₦${Number(item.price).toFixed(2)}</td>
              <td>₦${(item.quantity * Number(item.price)).toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <table class="totals-table">
        <tr class="grand-total">
          <td colspan="3" style="text-align:right;font-weight:700;">Total</td>
          <td style="font-weight:800;">₦${Number(purchase.total || 0).toFixed(2)}</td>
        </tr>
      </table>
    </div>
    <div class="footer">
      <p>Thank you for shopping with ColEx!</p>
      <p style="margin-top:4px;">Reprinted at ${new Date().toLocaleString()}</p>
    </div>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
  printWindow.document.close();
};

// ── PRODUCT LOGS ─────────────────────────────────────────────────────────────
function startProductLogsListener() {
  if (_prodUnsub) return;
  _prodUnsub = onSnapshot(
    collection(cashierDb, 'product_logs'),
    (snap) => {
      _allProdLogs = [];
      snap.forEach(d => _allProdLogs.push({ ...d.data(), _docId: d.id }));
      _allProdLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      applyProductFilters();
    },
    (e) => console.error('Product logs listener error:', e)
  );
}

window.setProdFilter = function(btn) {
  document.querySelectorAll('#tab-products .filter-pill[data-f]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _prodFilter = btn.dataset.f;
  applyProductFilters();
};

window.applyProductFilters = function() {
  const search  = (document.getElementById('prod-search')?.value || '').toLowerCase();
  const dateVal = document.getElementById('prod-date')?.value;

  let list = _allProdLogs;

  if (_prodFilter !== 'all') list = list.filter(l => l.action === _prodFilter);

  if (dateVal) {
    const picked = new Date(dateVal + 'T00:00:00').toDateString();
    list = list.filter(l => l.timestamp && new Date(l.timestamp).toDateString() === picked);
  }

  if (search) {
    list = list.filter(l =>
      (l.productName || '').toLowerCase().includes(search) ||
      (l.cashierName || '').toLowerCase().includes(search) ||
      (l.cashierEmail || '').toLowerCase().includes(search)
    );
  }

  renderProductLogs(list);
};

function renderProductLogs(list) {
  const el = document.getElementById('prod-log-list');
  if (!el) return;

  if (!list || list.length === 0) {
    el.innerHTML = `<div class="list-empty"><span class="list-empty-icon">📦</span>No product activity yet.</div>`;
    return;
  }

  el.innerHTML = list.map(log => {
    const date       = log.timestamp ? new Date(log.timestamp).toLocaleString('en-NG', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const isAdd      = log.action === 'add';
    const actionBadge = isAdd
      ? `<span class="badge" style="background:#dbeafe;color:#2563eb;">➕ Added</span>`
      : `<span class="badge" style="background:#fef9c3;color:#92400e;">✏️ Edited</span>`;

    const changesHtml = (log.changes && log.changes.length > 0)
      ? log.changes.map(c =>
          `<div class="prod-change-row">
            <span class="prod-change-field">${c.field}</span>
            <span class="prod-change-from">${c.from}</span>
            <span class="prod-change-arrow">→</span>
            <span class="prod-change-to">${c.to}</span>
          </div>`
        ).join('')
      : `<span style="color:var(--muted);font-size:12px;">${isAdd ? 'New product' : '—'}</span>`;

    const cashierDisplay = (window._cashierNameMap && log.cashierEmail && window._cashierNameMap[log.cashierEmail.toLowerCase()])
      ? window._cashierNameMap[log.cashierEmail.toLowerCase()]
      : (log.cashierName || log.cashierEmail || 'Unknown');

    return `
    <div class="list-row" style="grid-template-columns:1fr 1.5fr 1fr 2fr 1fr;align-items:start;">
      <div>${actionBadge}</div>
      <div class="row-customer">${log.productName || '—'}</div>
      <div><span class="cashier-chip"><span class="cashier-dot"></span>${cashierDisplay}</span></div>
      <div class="prod-changes-wrap">${changesHtml}</div>
      <div class="row-date">${date}</div>
    </div>`;
  }).join('');
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
