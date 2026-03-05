// head-admin.js — Per-store & General Head Admin dashboard (multi-store)
import { initializeApp, getApps }              from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, collection, onSnapshot, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { headAdminConfig, adminConfig, customerConfig, storeCol, storeDoc, STORE_IDS, STORE_LABELS } from "./firebase-config.js";

//  Firebase 
const adminApp  = getApps().find(a => a.name === 'head-admin-guard') || initializeApp(headAdminConfig, 'head-admin-guard');
const adminAuth = getAuth(adminApp);
const headAdminDb = getFirestore(adminApp);   // stores admin roles

const cashierApp = getApps().find(a => a.name === 'admin-guard') || initializeApp(adminConfig, 'admin-guard');
const cashierDb  = getFirestore(cashierApp);

const custApp = getApps().find(a => a.name === 'cardstorage') || initializeApp(customerConfig, 'cardstorage');
const custDb  = getFirestore(custApp);

//  State 
let _currentRole  = null;   // 'general' | 'store-head'
let _adminStores  = [];     // stores this admin can see: ['store1'] or ['store1','store2']
let _allPurchases = {};     // { store1: [...], store2: [...] }
let _purchFilter  = 'all';
let _allCashiers  = {};
let _selectedCashier = null;
let _purchUnsubs  = {};     // { store1: unsub, store2: unsub }
let _cashierNameMap = {};
let _allProdLogs  = [];
let _prodFilter   = 'all';
let _prodUnsub    = null;

//  Auth 
onAuthStateChanged(adminAuth, async (user) => {
  if (!user) return;

  // Determine role from headAdminDb /admins/{uid}
  try {
    const snap = await getDoc(doc(headAdminDb, 'admins', user.uid));
    if (snap.exists()) {
      const data = snap.data();
      _currentRole  = data.role || 'store-head';
      _adminStores  = _currentRole === 'general'
        ? [...STORE_IDS]
        : [data.storeId || 'store1'];
    } else {
      // Default: per-store head for store1 if no record found
      _currentRole = 'store-head';
      _adminStores = ['store1'];
    }
  } catch (e) {
    console.warn('Could not load admin role:', e.message);
    _currentRole = 'store-head';
    _adminStores = ['store1'];
  }

  // Update nav — read display name from /headAdmins/{uid} in the head admin project
  try {
    const snap = await getDoc(doc(headAdminDb, 'headAdmins', user.uid));
    const data  = snap.exists() ? snap.data() : {};
    const name  = data.name || user.email.split('@')[0];
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const el = document.getElementById('ha-avatar'); if (el) el.textContent = initials;
    const ne = document.getElementById('ha-name');   if (ne) ne.textContent = name;
    const re = document.getElementById('ha-role-badge');
    if (re) re.textContent = _currentRole === 'general' ? 'General Admin' : `Head Admin · ${STORE_LABELS[_adminStores[0]] || _adminStores[0]}`;
  } catch (e) { /* non-fatal */ }

  // Inject store filter pills for multi-store general admin
  injectStoreTabs();

  // Lock the "Assigned Store" dropdown to only the stores this admin manages.
  // A store-head admin must not be able to create cashiers for another store.
  lockStoreDropdown();

  await loadCashierNameMap();
  startPurchasesListeners();
  startProductLogsListener();
  loadAccounts();
});

//  Store filter tabs (general admin only) 
let _storeFilter = 'all';  // 'all' | 'store1' | 'store2'

function injectStoreTabs() {
  const wrap = document.getElementById('store-filter-wrap');
  if (!wrap) return;

  if (_currentRole !== 'general') {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <button class="filter-pill active" data-sf="all"    onclick="setStoreFilter(this)">All Stores</button>
    <button class="filter-pill"        data-sf="store1" onclick="setStoreFilter(this)">${STORE_LABELS['store1']}</button>
    <button class="filter-pill"        data-sf="store2" onclick="setStoreFilter(this)">${STORE_LABELS['store2']}</button>`;
}

// Restrict the "Assigned Store" <select> in the Create Account form so that
// a store-head admin only sees (and can only submit) their own store.
// A general admin keeps both options visible.
function lockStoreDropdown() {
  const sel = document.getElementById('new-store');
  if (!sel) return;

  if (_currentRole === 'general') {
    // General admin: make sure both options are present and enabled
    sel.querySelectorAll('option').forEach(o => { o.disabled = false; });
    return;
  }

  // Store-head: remove options that don't belong to this admin's store,
  // then disable the dropdown so it can't be changed via DevTools either.
  const allowedStore = _adminStores[0];
  Array.from(sel.options).forEach(o => {
    if (o.value !== allowedStore) {
      o.remove();
    }
  });
  sel.value = allowedStore;
  sel.disabled = true;
  sel.title = 'You can only create accounts for your assigned store.';
}

window.setStoreFilter = function(btn) {
  document.querySelectorAll('#store-filter-wrap .filter-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _storeFilter = btn.dataset.sf;
  applyPurchaseFilters();
  buildCashierData();
};

//  Combined purchases across stores 
function getAllPurchases() {
  const storesToShow = _storeFilter === 'all' ? _adminStores : [_storeFilter].filter(s => _adminStores.includes(s));
  const combined = [];
  storesToShow.forEach(s => {
    (_allPurchases[s] || []).forEach(p => combined.push({ ...p, _storeId: s }));
  });
  return combined.sort((a, b) => new Date(b.date) - new Date(a.date));
}

//  Cashier name map 
async function loadCashierNameMap() {
  try {
    const snap = await getDocs(collection(cashierDb, 'cashiers'));
    snap.forEach(d => {
      const data = d.data();
      if (data.email) _cashierNameMap[data.email.toLowerCase()] = data.name || data.email;
    });
    window._cashierNameMap = _cashierNameMap;
  } catch (e) { console.warn('Could not load cashier name map:', e.message); }
}

function resolveCashierName(p) {
  if (p.verifiedByName) return p.verifiedByName;
  const email = (p.verifiedBy || '').toLowerCase();
  return (email && _cashierNameMap[email]) ? _cashierNameMap[email] : (p.verifiedBy || 'Unknown');
}

//  Real-time listeners 
function startPurchasesListeners() {
  _adminStores.forEach(storeId => {
    if (_purchUnsubs[storeId]) return;
    _allPurchases[storeId] = [];

    _purchUnsubs[storeId] = onSnapshot(
      collection(custDb, storeCol(storeId, 'purchases')),
      (snap) => {
        _allPurchases[storeId] = [];
        snap.forEach(d => _allPurchases[storeId].push({ ...d.data(), _docId: d.id, _storeId: storeId }));
        _allPurchases[storeId].sort((a, b) => new Date(b.date) - new Date(a.date));
        updateStats();
        applyPurchaseFilters();
        buildCashierData();
      },
      (e) => { console.error('Purchases listener error:', e); notify.error('Could not load purchases: ' + e.message); }
    );
  });
}

//  Stats 
function updateStats() {
  const all      = getAllPurchases();
  const total    = all.length;
  const verified = all.filter(p => p.verified).length;
  const pending  = total - verified;
  const revenue  = all.filter(p => p.verified).reduce((s, p) => s + (p.total || 0), 0);
  setText('s-total',    total);
  setText('s-verified', verified);
  setText('s-pending',  pending);
  setText('s-revenue',  '₦' + revenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }));
  const sub = document.getElementById('purch-subtitle');
  if (sub) sub.textContent = `${total} purchase${total !== 1 ? 's' : ''} · live updates on`;
}

//  Purchase list 
window.setPurchFilter = function(btn) {
  document.querySelectorAll('#tab-purchases .filter-pill[data-f]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _purchFilter = btn.dataset.f;
  applyPurchaseFilters();
};

window.applyPurchaseFilters = function() {
  const search  = (document.getElementById('purch-search')?.value || '').toLowerCase().trim();
  const dateVal = document.getElementById('purch-date')?.value;
  let list      = getAllPurchases();

  if (_purchFilter === 'verified') list = list.filter(p => p.verified);
  if (_purchFilter === 'pending')  list = list.filter(p => !p.verified);
  if (dateVal) {
    const picked = new Date(dateVal + 'T00:00:00').toDateString();
    list = list.filter(p => p.date && new Date(p.date).toDateString() === picked);
  }
  if (search) {
    list = list.filter(p => {
      return [p.id, p.customerName, p.email, (p.items||[]).map(i=>i.name).join(' '), p.verifiedByName, p.verifiedBy]
        .join(' ').toLowerCase().includes(search);
    });
  }
  renderPurchaseList(list);
};

function storeLabel(storeId) {
  return storeId === 'store1' ? ' Store 1' : ' Store 2';
}

function renderPurchaseList(list) {
  if (!list) list = getAllPurchases();
  const container = document.getElementById('purch-list');
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<div class="list-empty"><span class="list-empty-icon"></span>No purchases match your filters.</div>`;
    return;
  }
  container.innerHTML = list.map(p => {
    const date   = p.date ? new Date(p.date).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const amount = '₦' + (p.total ? p.total.toLocaleString('en-NG',{minimumFractionDigits:2}) : '0.00');
    const items  = (p.items||[]).map(i=>`${i.quantity}× ${i.name}`).join(', ') || '—';
    const badge  = p.verified
      ? `<span class="badge badge-verified">Verified</span>`
      : `<span class="badge badge-pending">Pending</span>`;
    const cashierCol = p.verified
      ? `<span class="cashier-chip"><span class="cashier-dot"></span>${resolveCashierName(p)}</span>`
      : `<span style="color:var(--muted);font-size:12px;">—</span>`;
    const storePill  = _currentRole === 'general'
      ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#6b7280;margin-left:4px;">${storeLabel(p._storeId)}</span>` : '';
    const safeId = (p.id||'').replace(/'/g,"\\'");
    const safeDocId = (p._docId||'').replace(/'/g,"\\'");
    const safeStore = p._storeId || 'store1';
    const actionBtn = p.verified
      ? `<button class="btn-reprint" onclick="reprintReceipt('${safeId}','${safeStore}')">Print</button>`
      : `<div style="display:flex;flex-direction:column;gap:4px;">
           <button class="btn-verify-ha" onclick="verifyPurchaseHA('${safeDocId}','${safeId}','${safeStore}')">Verify</button>
           <button class="btn-reprint" onclick="reprintReceipt('${safeId}','${safeStore}')">Print</button>
         </div>`;
    return `
    <div class="list-row lr-purchases" id="ha-row-${p._docId}">
      <div><div class="row-id">${p.id||'—'}${storePill}</div>${badge}</div>
      <div><div class="row-customer">${p.customerName||p.email||'Unknown'}</div><div class="row-items">${items}</div></div>
      <div class="row-amount">${amount}</div>
      <div class="col-cashier">${cashierCol}</div>
      <div class="row-date">${date}</div>
      <div>${actionBtn}</div>
    </div>`;
  }).join('');
}

//  By Cashier tab 
function buildCashierData() {
  _allCashiers = {};
  getAllPurchases().filter(p => p.verified).forEach(p => {
    const key  = p.verifiedBy || 'unknown';
    const name = resolveCashierName(p);
    if (!_allCashiers[key]) _allCashiers[key] = { name, email: key, count: 0, total: 0, purchases: [], storeIds: new Set() };
    _allCashiers[key].count++;
    _allCashiers[key].total += (p.total || 0);
    _allCashiers[key].purchases.push(p);
    if (p._storeId) _allCashiers[key].storeIds.add(p._storeId);
  });
  renderCashierGrid();
  if (_selectedCashier && _allCashiers[_selectedCashier]) renderCashierDetail(_selectedCashier);
}

function renderCashierGrid() {
  const grid = document.getElementById('cashier-grid');
  if (!grid) return;
  const entries = Object.entries(_allCashiers);
  if (entries.length === 0) {
    grid.innerHTML = `<div class="list-empty"><span class="list-empty-icon"></span>No verified purchases yet.</div>`;
    return;
  }
  grid.innerHTML = entries.sort(([,a],[,b]) => b.count - a.count).map(([key, c]) => {
    const initials  = c.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?';
    const isSelected = _selectedCashier === key;
    const storePills = _currentRole === 'general'
      ? [...c.storeIds].map(s => `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#6b7280;">${storeLabel(s)}</span>`).join('')
      : '';
    return `
    <div class="cashier-summary-card${isSelected?' selected':''}" onclick="selectCashier('${key}')">
      <div class="cs-top">
        <div class="cs-avatar">${initials}</div>
        <div>
          <div class="cs-name">${c.name}</div>
          <div class="cs-email">${c.email !== 'unknown' ? c.email : '—'}</div>
          <div style="margin-top:4px;">${storePills}</div>
        </div>
      </div>
      <div class="cs-stats">
        <div><div class="cs-stat-val">${c.count}</div><div class="cs-stat-lbl">Verified</div></div>
        <div><div class="cs-stat-val">₦${c.total.toLocaleString('en-NG',{minimumFractionDigits:0})}</div><div class="cs-stat-lbl">Total Value</div></div>
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
  const cashier = _allCashiers[key];
  const detailWrap = document.getElementById('cashier-detail');
  const titleEl    = document.getElementById('cashier-detail-title');
  const listEl     = document.getElementById('cashier-detail-list');
  if (!detailWrap || !cashier) return;
  detailWrap.style.display = 'block';
  titleEl.textContent = `Verified by ${cashier.name}`;
  const sorted = [...cashier.purchases].sort((a,b)=>new Date(b.verifiedDate||b.date)-new Date(a.verifiedDate||a.date));
  listEl.innerHTML = sorted.map(p => {
    const verifiedAt = p.verifiedDate ? new Date(p.verifiedDate).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const amount = '₦' + (p.total ? p.total.toLocaleString('en-NG',{minimumFractionDigits:2}) : '0.00');
    const items  = (p.items||[]).map(i=>`${i.quantity}× ${i.name}`).join(', ') || '—';
    const storePill = _currentRole === 'general' && p._storeId
      ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#6b7280;margin-left:6px;">${storeLabel(p._storeId)}</span>` : '';
    return `
    <div class="list-row lr-cashier">
      <div class="row-id">${p.id||'—'}${storePill}</div>
      <div class="row-amount">${amount}</div>
      <div class="row-items col-purchases">${items}</div>
      <div class="row-date">${verifiedAt}</div>
    </div>`;
  }).join('');
}

//  Manage Accounts 
async function loadAccounts() {
  const listEl = document.getElementById('accounts-list-body');
  if (!listEl) return;
  try {
    const snap = await getDocs(collection(cashierDb, 'cashiers'));
    const accounts = [];
    snap.forEach(d => accounts.push({ uid: d.id, ...d.data() }));
    if (accounts.length === 0) {
      listEl.innerHTML = `<div class="list-empty" style="padding:28px;"><span class="list-empty-icon"></span>No accounts yet.</div>`;
      return;
    }
    // If store-head, only show their store's cashiers
    const visible = _currentRole === 'general'
      ? accounts
      : accounts.filter(a => !a.storeId || a.storeId === _adminStores[0]);

    listEl.innerHTML = visible.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(a => {
      const isHead = a.role === 'Head Cashier' || a.role === 'Supervisor';
      const storePill = _currentRole === 'general' && a.storeId
        ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#6b7280;margin-left:6px;">${storeLabel(a.storeId)}</span>` : '';
      // Store-heads can only delete cashiers from their own store
      const canDelete = _currentRole === 'general' || _adminStores.includes(a.storeId || 'store1');
      const safeUid   = (a.uid || '').replace(/'/g, "\\'");
      const safeName  = (a.name || 'this account').replace(/'/g, "\\'");
      return `
      <div class="account-row" id="acc-row-${a.uid}">
        <div class="acc-info">
          <div class="acc-name">${a.name||'—'}${storePill}</div>
          <div class="acc-email">${a.email||'—'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span class="acc-role-badge${isHead?' head':''}">${a.role||'Cashier'}</span>
          ${canDelete ? `<button class="btn-delete-acc" onclick="deleteAccount('${safeUid}','${safeName}')" title="Delete account">&#128465;</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    console.error('Could not load accounts:', e);
    listEl.innerHTML = `<div class="list-empty" style="padding:28px;">Could not load accounts.</div>`;
  }
}

//  Delete Account 
window.deleteAccount = function(uid, name) {
  if (!uid) { notify.error('Cannot delete: account ID missing.'); return; }

  notify.confirm(`Delete account for "${name}"? This removes their login from the system and cannot be undone.`, async () => {
    // Optimistically remove the row from the UI immediately
    const row = document.getElementById(`acc-row-${uid}`);
    if (row) {
      row.style.opacity = '0.4';
      row.style.pointerEvents = 'none';
    }

    try {
      // Delete the Firestore cashier profile — this removes their access record.
      // Note: Firebase Auth user deletion requires the Admin SDK (server-side).
      // Deleting the Firestore doc is sufficient to block login since the
      // auth guard checks cashierDb for a valid profile on every login attempt.
      await deleteDoc(doc(cashierDb, 'cashiers', uid));

      // Remove from the cashier name map so stale names don't linger
      const deletedEmail = Object.keys(_cashierNameMap).find(k => _cashierNameMap[k] === name);
      if (deletedEmail) delete _cashierNameMap[deletedEmail];

      notify.success(`Account for "${name}" deleted successfully.`);

      // Refresh the accounts list and cashier name map
      await loadCashierNameMap();
      loadAccounts();
    } catch (e) {
      console.error('Delete account error:', e);
      notify.error('Could not delete account: ' + e.message);
      // Restore the row if deletion failed
      if (row) { row.style.opacity = ''; row.style.pointerEvents = ''; }
    }
  });
};

//  Create Account 
window.createAccount = async function() {
  const first    = document.getElementById('new-first').value.trim();
  const last     = document.getElementById('new-last').value.trim();
  const role     = document.getElementById('new-role').value;
  const email    = document.getElementById('new-email').value.trim();
  const password = document.getElementById('new-password').value;
  const storeId  = document.getElementById('new-store')?.value || _adminStores[0];

  if (!first || !last)     { notify.error('Please enter first and last name.'); return; }
  if (!email)              { notify.error('Please enter an email address.');    return; }
  if (!password)           { notify.error('Please enter a password.');          return; }
  if (password.length < 6) { notify.error('Password must be at least 6 characters.'); return; }

  // Security: enforce that the chosen store is one this admin is allowed to manage.
  // This catches both UI tampering (re-enabled disabled <select>) and direct
  // JS calls with an out-of-scope storeId.
  if (!_adminStores.includes(storeId)) {
    notify.error('You are not authorised to create accounts for that store.');
    console.warn(`createAccount blocked: admin manages ${_adminStores}, attempted storeId "${storeId}"`);
    return;
  }

  const btn = document.getElementById('btn-create-account');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const tempApp  = initializeApp(adminConfig, 'temp-create-' + Date.now());
    const tempAuth = getAuth(tempApp);
    const cred     = await createUserWithEmailAndPassword(tempAuth, email, password);
    const uid      = cred.user.uid;
    await signOut(tempAuth);

    const profileData = { name: `${first} ${last}`, role, email, uid, storeId, createdAt: new Date().toISOString() };
    await setDoc(doc(cashierDb, 'cashiers', uid), profileData);
    notify.success(`Account created for ${first} ${last} (${STORE_LABELS[storeId]||storeId})!`);
    ['new-first','new-last','new-email','new-password'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    loadAccounts();
  } catch (e) {
    const code = e.code || '';
    if (code === 'auth/email-already-in-use') notify.error('This email is already registered.');
    else if (code === 'auth/invalid-email')   notify.error('Please enter a valid email address.');
    else if (code === 'auth/weak-password')   notify.error('Password is too weak.');
    else notify.error('Could not create account: ' + e.message);
  } finally { btn.disabled = false; btn.textContent = 'Create Account'; }
};

//  Verify purchase (head admin) 
window.verifyPurchaseHA = async function(docId, purchaseId, storeId) {
  if (!docId) { notify.error('Cannot verify: document ID missing.'); return; }
  const verifiedDate    = new Date().toISOString();
  const headAdminEmail  = (window.currentHeadAdmin && window.currentHeadAdmin.email) || '';
  try {
    await updateDoc(doc(custDb, storeDoc(storeId, 'purchases', docId)), {
      verified: true, verifiedDate, verifiedBy: headAdminEmail, verifiedByName: 'Head Admin'
    });
    notify.success('Purchase verified successfully.');
  } catch (e) { console.error('Verify error:', e); notify.error('Could not verify: ' + e.message); }
};

//  Reprint receipt 
window.reprintReceipt = function(purchaseId, storeId) {
  const purchase = ((_allPurchases[storeId||'store1'])||[]).find(p => p.id === purchaseId)
    || getAllPurchases().find(p => p.id === purchaseId);
  if (!purchase) { notify.error('Purchase not found.'); return; }
  const customerName  = purchase.customerName  || purchase.email || 'Unknown';
  const customerPhone = purchase.customerPhone || '—';
  const customerEmail = purchase.email         || '—';
  const cashierName   = resolveCashierName(purchase);
  const storeInfo     = STORE_LABELS[purchase._storeId] || '';

  const printWindow = window.open('', '', 'width=800,height=700');
  printWindow.document.write(`<!DOCTYPE html><html><head><title>Receipt - ${purchase.id}</title>
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;padding:28px;max-width:620px;margin:0 auto}
    .rh{text-align:center;border-bottom:2px solid #111;padding-bottom:18px;margin-bottom:20px}
    .rh h1{font-size:28px;font-weight:900}.rh h2{font-size:15px;color:#555;margin-top:4px}
    .badge{display:inline-block;margin-top:10px;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700}
    .v-badge{background:#111;color:white}.p-badge{background:#f59e0b;color:white}
    .sec{margin:18px 0}.sec-t{font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:10px;border-bottom:1px solid #eee;padding-bottom:6px}
    .dr{display:flex;justify-content:space-between;padding:5px 0;font-size:14px}
    table{width:100%;border-collapse:collapse;margin-top:6px}
    th{background:#f5f5f5;padding:9px 10px;text-align:left;font-size:12px}
    td{padding:9px 10px;border-bottom:1px solid #f0f0f0;font-size:14px}
    .footer{text-align:center;margin-top:36px;color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:16px}
    </style></head><body>
    <div class="rh"><h1>ColEx</h1><h2>Purchase Receipt${storeInfo ? ` · ${storeInfo}` : ''}</h2>
    ${purchase.verified?'<div class="badge v-badge"> VERIFIED</div>':'<div class="badge p-badge"> PENDING</div>'}
    </div>
    <div class="sec"><div class="sec-t">Customer</div>
      <div class="dr"><span>Name</span><span>${customerName}</span></div>
      <div class="dr"><span>Phone</span><span>${customerPhone}</span></div>
      <div class="dr"><span>Email</span><span>${customerEmail}</span></div></div>
    <div class="sec"><div class="sec-t">Order Info</div>
      <div class="dr"><span>Purchase ID</span><span style="font-family:monospace">${purchase.id}</span></div>
      <div class="dr"><span>Date</span><span>${new Date(purchase.date).toLocaleString()}</span></div>
      <div class="dr"><span>Reference</span><span style="font-family:monospace">${purchase.reference||'—'}</span></div>
      ${purchase.verified?`<div class="dr"><span>Verified At</span><span>${new Date(purchase.verifiedDate).toLocaleString()}</span></div><div class="dr"><span>Verified By</span><span>${cashierName}</span></div>`:''}
    </div>
    <div class="sec"><div class="sec-t">Items</div>
      <table><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead><tbody>
        ${(purchase.items||[]).map(i=>`<tr><td>${i.name}</td><td>${i.quantity}</td><td>₦${Number(i.price).toFixed(2)}</td><td>₦${(i.quantity*Number(i.price)).toFixed(2)}</td></tr>`).join('')}
      </tbody></table>
      <table style="margin-top:8px"><tr style="font-size:18px;font-weight:800;border-top:2px solid #111">
        <td colspan="3" style="text-align:right;font-weight:700;padding:12px 10px">Total</td>
        <td style="padding:12px 10px">₦${Number(purchase.total||0).toFixed(2)}</td>
      </tr></table></div>
    <div class="footer"><p>Thank you for shopping with ColEx!</p><p style="margin-top:4px">Reprinted at ${new Date().toLocaleString()}</p></div>
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
  printWindow.document.close();
};

//  Product logs 
function startProductLogsListener() {
  if (_prodUnsub) return;
  // For general admin, listen to all stores; for store-head, listen to their store
  const storesToWatch = _adminStores;
  let _allLogsRaw = {};

  storesToWatch.forEach(storeId => {
    _allLogsRaw[storeId] = [];
    onSnapshot(
      collection(cashierDb, storeCol(storeId, 'product_logs')),
      (snap) => {
        _allLogsRaw[storeId] = [];
        snap.forEach(d => _allLogsRaw[storeId].push({ ...d.data(), _docId: d.id, _storeId: storeId }));
        // Merge all stores
        _allProdLogs = [];
        Object.values(_allLogsRaw).forEach(logs => _allProdLogs.push(...logs));
        _allProdLogs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
        applyProductFilters();
      },
      (e) => console.error('Product logs listener error:', e)
    );
  });
  _prodUnsub = true;
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
      (l.productName||'').toLowerCase().includes(search) ||
      (l.cashierName||'').toLowerCase().includes(search) ||
      (l.cashierEmail||'').toLowerCase().includes(search)
    );
  }
  renderProductLogs(list);
};

function renderProductLogs(list) {
  const el = document.getElementById('prod-log-list');
  if (!el) return;
  if (!list || list.length === 0) {
    el.innerHTML = `<div class="list-empty"><span class="list-empty-icon"></span>No product activity yet.</div>`;
    return;
  }
  el.innerHTML = list.map(log => {
    const isAdd    = log.action === 'add';
    const isDelete = log.action === 'delete';
    const date     = log.timestamp ? new Date(log.timestamp).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const actionBadge = isAdd
      ? `<span class="badge" style="background:#dbeafe;color:#2563eb;">Added</span>`
      : isDelete
        ? `<span class="badge" style="background:#fee2e2;color:#dc2626;">Deleted</span>`
        : `<span class="badge" style="background:#fef9c3;color:#92400e;">Edited</span>`;
    const storePill  = _currentRole === 'general' && log._storeId
      ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#6b7280;margin-top:4px;display:inline-block;">${storeLabel(log._storeId)}</span>` : '';
    const changesHtml = (log.changes && log.changes.length > 0)
      ? log.changes.map(c=>`<div class="prod-change-row"><span class="prod-change-field">${c.field}</span><span class="prod-change-from">${c.from}</span><span class="prod-change-arrow">→</span><span class="prod-change-to">${c.to}</span></div>`).join('')
      : `<span style="color:var(--muted);font-size:12px;">${isAdd ? 'New product' : isDelete ? 'Product removed' : '—'}</span>`;
    const cashierDisplay = (log.cashierEmail && _cashierNameMap[log.cashierEmail.toLowerCase()])
      ? _cashierNameMap[log.cashierEmail.toLowerCase()]
      : (log.cashierName || log.cashierEmail || 'Unknown');
    return `
    <div class="list-row" style="grid-template-columns:1fr 1.5fr 1fr 2fr 1fr;align-items:start;">
      <div>${actionBadge}${storePill}</div>
      <div class="row-customer">${log.productName||'—'}</div>
      <div><span class="cashier-chip"><span class="cashier-dot"></span>${cashierDisplay}</span></div>
      <div class="prod-changes-wrap">${changesHtml}</div>
      <div class="row-date">${date}</div>
    </div>`;
  }).join('');
}

function setText(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }
