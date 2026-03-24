// head-admin.js — Per-store & General Head Admin dashboard (multi-store)
import { initializeApp, getApps }              from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, collection, onSnapshot, getDocs, doc, getDoc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { headAdminConfig, adminConfig, customerConfig, storeCol, storeDoc, STORE_IDS, STORE_LABELS } from "./firebase-config.js";
import { escapeHtml } from "./utils.js";


//  Firebase 
const adminApp    = getApps().find(a => a.name === 'head-admin-guard') || initializeApp(headAdminConfig, 'head-admin-guard');
const adminAuth   = getAuth(adminApp);
const headAdminDb = getFirestore(adminApp);

const cashierApp = getApps().find(a => a.name === 'admin-guard') || initializeApp(adminConfig, 'admin-guard');
const cashierDb  = getFirestore(cashierApp);

const custApp = getApps().find(a => a.name === 'cardstorage') || initializeApp(customerConfig, 'cardstorage');
const custDb  = getFirestore(custApp);

// ── Dynamic store map ────────────────────────────────────────────────────────
// Loaded from Firestore (storeConfig/list) at startup. Falls back to the
// hardcoded STORE_IDS/STORE_LABELS from firebase-config.js on first run.
// Map<storeId, label>
let _storeMap = new Map(STORE_IDS.map(id => [id, STORE_LABELS[id] || id]));

function getStoreIds()      { return [..._storeMap.keys()]; }
function getStoreLabel(id)  { return _storeMap.get(id) || id; }

async function loadStoreConfig() {
  try {
    const snap = await getDoc(doc(headAdminDb, 'storeConfig', 'list'));
    if (snap.exists() && Array.isArray(snap.data().stores) && snap.data().stores.length > 0) {
      _storeMap = new Map(snap.data().stores.map(s => [s.id, s.label]));
    } else {
      // First run — seed Firestore from firebase-config.js defaults
      await saveStoreConfig();
    }
  } catch (e) { console.warn('Could not load store config:', e.message); }
}

async function saveStoreConfig() {
  const stores = [..._storeMap.entries()].map(([id, label]) => ({ id, label }));
  await setDoc(doc(headAdminDb, 'storeConfig', 'list'), { stores });
}

// Refresh every UI element that depends on the store list
function refreshStoreUI() {
  injectStoreTabs();
  refreshStoreDropdowns();
  loadSubaccountSettingsUI();
  loadAccounts();
}

// Re-populate every <select> that lists stores
function refreshStoreDropdowns() {
  const ids = getStoreIds();
  ['new-store', 'ha-new-store'].forEach(elId => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(getStoreLabel(id))}</option>`).join('');
    if (ids.includes(prev)) sel.value = prev;
  });
}

//  State 
let _currentRole  = null;   // 'general' | 'store-head'
let _adminStores  = [];     // stores this admin can see
let _allPurchases = {};     // { store1: [...], store2: [...] }
let _purchFilter  = 'all';
let _purchPeriod  = 'all'; // 'day' | 'week' | 'month' | 'year' | 'all'
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

  // Load dynamic store config first so everything else uses up-to-date labels
  await loadStoreConfig();

  // Determine role from headAdminDb /admins/{uid}
  try {
    const snap = await getDoc(doc(headAdminDb, 'admins', user.uid));
    if (snap.exists()) {
      const data = snap.data();
      _currentRole  = data.role || 'store-head';
      _adminStores  = _currentRole === 'general'
        ? getStoreIds()
        : [data.storeId || getStoreIds()[0] || 'store1'];
    } else {
      _currentRole = 'store-head';
      _adminStores = [getStoreIds()[0] || 'store1'];
    }
  } catch (e) {
    console.warn('Could not load admin role:', e.message);
    _currentRole = 'store-head';
    _adminStores = [getStoreIds()[0] || 'store1'];
  }

  // Update nav
  try {
    const snap = await getDoc(doc(headAdminDb, 'headAdmins', user.uid));
    const data  = snap.exists() ? snap.data() : {};
    const name  = data.name || user.email.split('@')[0];
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const el = document.getElementById('ha-avatar'); if (el) el.textContent = initials;
    const ne = document.getElementById('ha-name');   if (ne) ne.textContent = name;
    const re = document.getElementById('ha-role-badge');
    if (re) re.textContent = _currentRole === 'general' ? 'General Admin' : `Head Admin · ${getStoreLabel(_adminStores[0])}`;
  } catch (e) { /* non-fatal */ }

  // Show general-admin-only buttons and the service charge revenue card
  if (_currentRole === 'general') {
    document.querySelectorAll('.general-admin-only').forEach(el => el.style.display = '');
    // Expand stat strip to 5 columns and reveal the service charge card
    const strip = document.querySelector('.stat-strip');
    if (strip) strip.classList.add('general-admin');
    const chargeCard = document.getElementById('s-charge-card');
    if (chargeCard) chargeCard.style.display = '';
  }

  injectStoreTabs();
  refreshStoreDropdowns();

  await loadCashierNameMap();
  startPurchasesListeners();
  startProductLogsListener();
  loadAccounts();
  loadSubaccountSettingsUI();
});

//  Store filter tabs (general admin only) 
let _storeFilter = 'all';  // 'all' | storeId

function injectStoreTabs() {
  const wrap = document.getElementById('store-filter-wrap');
  const bar  = document.getElementById('store-picker-bar');
  if (!wrap) return;

  if (_currentRole !== 'general') {
    if (bar) bar.style.display = 'none';
    return;
  }

  if (bar) bar.style.display = 'block';
  wrap.innerHTML = `
    <button class="filter-pill active" data-sf="all" onclick="setStoreFilter(this)">All Stores</button>
    ${getStoreIds().map(id =>
      `<button class="filter-pill" data-sf="${escapeHtml(id)}" onclick="setStoreFilter(this)">${escapeHtml(getStoreLabel(id))}</button>`
    ).join('')}`;
}

window.setStoreFilter = function(btn) {
  document.querySelectorAll('#store-filter-wrap .filter-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _storeFilter = btn.dataset.sf;
  // Refresh all four tabs so the selection is consistent everywhere
  applyPurchaseFilters();
  buildCashierData();
  applyProductFilters();
  loadAccounts();
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
        applyPurchaseFilters();
        buildCashierData();
      },
      (e) => { console.error('Purchases listener error:', e); notify.error('Could not load purchases: ' + e.message); }
    );
  });
}

//  Stats 
function updateStats(filteredList) {
  const all      = filteredList != null ? filteredList : getAllPurchases();
  const total    = all.length;
  const verified = all.filter(p => p.verified).length;
  const pending  = total - verified;

  const verifiedPurchases = all.filter(p => p.verified);
  const goodsRevenue  = verifiedPurchases.reduce((s, p) => {
    const sc = p.serviceCharge || 0;
    return s + (p.cartSubtotal != null ? p.cartSubtotal : (p.total || 0) - sc);
  }, 0);
  const chargeRevenue = verifiedPurchases.reduce((s, p) => s + (p.serviceCharge || 0), 0);

  setText('s-total',    total);
  setText('s-verified', verified);
  setText('s-pending',  pending);
  setText('s-revenue', '₦' + goodsRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }));
  if (_currentRole === 'general') {
    setText('s-charge-revenue', '₦' + chargeRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }));
  }

  const periodLabels = { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year', all: 'All Time' };
  const dateVal = document.getElementById('purch-date')?.value;
  const periodLabel = dateVal
    ? new Date(dateVal + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })
    : (periodLabels[_purchPeriod] || 'All Time');

  const sub = document.getElementById('purch-subtitle');
  if (sub) sub.textContent = `${total} purchase${total !== 1 ? 's' : ''} · ${periodLabel} · live updates on`;
}

//  Purchase list 
window.setPurchFilter = function(btn) {
  document.querySelectorAll('#tab-purchases .filter-pill[data-f]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _purchFilter = btn.dataset.f;
  applyPurchaseFilters();
};

window.setPurchPeriod = function(btn) {
  document.querySelectorAll('#tab-purchases .filter-pill[data-p]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _purchPeriod = btn.dataset.p;
  // Clear the date picker when a period button is used
  const datePick = document.getElementById('purch-date');
  if (datePick) datePick.value = '';
  applyPurchaseFilters();
};

window.applyPurchaseFilters = function() {
  const search  = (document.getElementById('purch-search')?.value || '').toLowerCase().trim();
  const dateVal = document.getElementById('purch-date')?.value;
  let list      = getAllPurchases();

  // Status filter
  if (_purchFilter === 'verified') list = list.filter(p => p.verified);
  if (_purchFilter === 'pending')  list = list.filter(p => !p.verified);

  // Date picker overrides period buttons
  if (dateVal) {
    const picked = new Date(dateVal + 'T00:00:00').toDateString();
    list = list.filter(p => p.date && new Date(p.date).toDateString() === picked);
  } else if (_purchPeriod !== 'all') {
    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart  = new Date(todayStart);
    weekStart.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7)); // Monday
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart  = new Date(now.getFullYear(), 0, 1);

    list = list.filter(p => {
      if (!p.date) return false;
      const d = new Date(p.date);
      switch (_purchPeriod) {
        case 'day':   return d >= todayStart;
        case 'week':  return d >= weekStart;
        case 'month': return d >= monthStart;
        case 'year':  return d >= yearStart;
        default:      return true;
      }
    });
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
  return getStoreLabel(storeId);
}

function renderPurchaseList(list) {
  if (!list) list = getAllPurchases();
  updateStats(list);
  const container = document.getElementById('purch-list');
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<div class="list-empty"><span class="list-empty-icon"></span>No purchases match your filters.</div>`;
    return;
  }
  container.innerHTML = list.map(p => {
    const date   = p.date ? new Date(p.date).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const amount = '₦' + (p.total ? p.total.toLocaleString('en-NG',{minimumFractionDigits:2}) : '0.00');
    const items  = (p.items||[]).map(i=>`${escapeHtml(String(i.quantity))}× ${escapeHtml(i.name)}`).join(', ') || '—';
    const badge  = p.verified
      ? `<span class="badge badge-verified">Verified</span>`
      : `<span class="badge badge-pending">Pending</span>`;
    const cashierCol = p.verified
      ? `<span class="cashier-chip"><span class="cashier-dot"></span>${escapeHtml(resolveCashierName(p))}</span>`
      : `<span style="color:var(--muted);font-size:12px;">—</span>`;
    const storePill  = _currentRole === 'general'
      ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#7A6050;margin-left:4px;">${escapeHtml(storeLabel(p._storeId))}</span>` : '';
    // Use data attributes instead of building onclick strings from DB values — prevents injection
    const actionBtn = p.verified
      ? `<button class="btn-reprint ha-btn-action" data-id="${escapeHtml(p.id||'')}" data-store="${escapeHtml(p._storeId||'store1')}">Print</button>`
      : `<div style="display:flex;flex-direction:column;gap:4px;">
           <button class="btn-verify-ha ha-btn-action" data-docid="${escapeHtml(p._docId||'')}" data-id="${escapeHtml(p.id||'')}" data-store="${escapeHtml(p._storeId||'store1')}">Verify</button>
           <button class="btn-reprint ha-btn-action" data-id="${escapeHtml(p.id||'')}" data-store="${escapeHtml(p._storeId||'store1')}">Print</button>
         </div>`;
    return `
    <div class="list-row lr-purchases" id="ha-row-${escapeHtml(p._docId||'')}">
      <div><div class="row-id">${escapeHtml(p.id||'—')}${storePill}</div>${badge}</div>
      <div><div class="row-customer">${escapeHtml(p.customerName||p.email||'Unknown')}</div><div class="row-items">${items}</div></div>
      <div class="row-amount">${amount}</div>
      <div class="col-cashier">${cashierCol}</div>
      <div class="row-date">${date}</div>
      <div>${actionBtn}</div>
    </div>`;
  }).join('');
}

// Event delegation for purchase-list action buttons.
// Buttons are rebuilt on every render so we attach one listener to the
// stable parent container rather than per-button onclick attributes.
document.addEventListener('click', e => {
  const btn = e.target.closest('.ha-btn-action');
  if (!btn) return;
  if (btn.classList.contains('btn-verify-ha')) {
    verifyPurchaseHA(btn.dataset.docid, btn.dataset.id, btn.dataset.store);
  } else if (btn.classList.contains('btn-reprint')) {
    reprintReceipt(btn.dataset.id, btn.dataset.store);
  }
});


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
      ? [...c.storeIds].map(s => `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#7A6050;">${escapeHtml(storeLabel(s))}</span>`).join('')
      : '';
    return `
    <div class="cashier-summary-card${isSelected?' selected':''}" data-cashier-key="${escapeHtml(key)}">
      <div class="cs-top">
        <div class="cs-avatar">${escapeHtml(initials)}</div>
        <div>
          <div class="cs-name">${escapeHtml(c.name)}</div>
          <div class="cs-email">${c.email !== 'unknown' ? escapeHtml(c.email) : '—'}</div>
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

// Use event delegation so cashier cards don't need onclick strings with raw DB keys
document.addEventListener('click', e => {
  const card = e.target.closest('.cashier-summary-card[data-cashier-key]');
  if (!card) return;
  _selectedCashier = card.dataset.cashierKey;
  renderCashierGrid();
  renderCashierDetail(_selectedCashier);
});

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
    const items  = (p.items||[]).map(i=>`${escapeHtml(String(i.quantity))}× ${escapeHtml(i.name)}`).join(', ') || '—';
    const storePill = _currentRole === 'general' && p._storeId
      ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#7A6050;margin-left:6px;">${escapeHtml(storeLabel(p._storeId))}</span>` : '';
    return `
    <div class="list-row lr-cashier">
      <div class="row-id">${escapeHtml(p.id||'—')}${storePill}</div>
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
    // Apply store filter: general admin filtered to a specific store sees only that store's cashiers
    const visible = _currentRole === 'general'
      ? (_storeFilter === 'all'
          ? accounts
          : accounts.filter(a => (a.storeId || 'store1') === _storeFilter))
      : accounts.filter(a => !a.storeId || a.storeId === _adminStores[0]);

    listEl.innerHTML = visible.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(a => {
      const isHead = a.role === 'Head Cashier' || a.role === 'Supervisor';
      const storePill = _currentRole === 'general' && a.storeId
        ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#7A6050;margin-left:6px;">${escapeHtml(storeLabel(a.storeId))}</span>` : '';
      const canDelete = _currentRole === 'general' || _adminStores.includes(a.storeId || 'store1');
      return `
      <div class="account-row" id="acc-row-${escapeHtml(a.uid)}">
        <div class="acc-info">
          <div class="acc-name">${escapeHtml(a.name||'—')}${storePill}</div>
          <div class="acc-email">${escapeHtml(a.email||'—')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span class="acc-role-badge${isHead?' head':''}">${escapeHtml(a.role||'Cashier')}</span>
          ${canDelete ? `<button class="btn-delete-acc ha-btn-del-acc" data-uid="${escapeHtml(a.uid||'')}" data-name="${escapeHtml(a.name||'this account')}" title="Delete account">&#128465;</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    console.error('Could not load accounts:', e);
    listEl.innerHTML = `<div class="list-empty" style="padding:28px;">Could not load accounts.</div>`;
  }
}

// Event delegation for account delete buttons
document.addEventListener('click', e => {
  const btn = e.target.closest('.ha-btn-del-acc');
  if (!btn) return;
  deleteAccount(btn.dataset.uid, btn.dataset.name);
});

//  Delete Account
window.deleteAccount = function(uid, name) {
  if (!uid) { notify.error('Cannot delete: account ID missing.'); return; }

  notify.confirm(`Delete account for "${name}"? This permanently removes their login and cannot be undone.`, async () => {
    const row = document.getElementById(`acc-row-${uid}`);
    if (row) { row.style.opacity = '0.4'; row.style.pointerEvents = 'none'; }

    try {
      const res  = await fetch('/api/delete-cashier', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete account.');

      const deletedEmail = Object.keys(_cashierNameMap).find(k => _cashierNameMap[k] === name);
      if (deletedEmail) delete _cashierNameMap[deletedEmail];

      notify.success(`Account for "${name}" deleted — login and profile both removed.`);
      await loadCashierNameMap();
      loadAccounts();
    } catch (e) {
      console.error('Delete account error:', e);
      notify.error('Could not delete account: ' + e.message);
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
    notify.success(`Account created for ${first} ${last} (${getStoreLabel(storeId)})!`);
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

  const customerName  = escapeHtml(purchase.customerName  || purchase.email || 'Unknown');
  const customerPhone = escapeHtml(purchase.customerPhone || '—');
  const customerEmail = escapeHtml(purchase.email         || '—');
  const cashierName   = escapeHtml(resolveCashierName(purchase));
  const purchaseId_s  = escapeHtml(purchase.id            || '—');
  const storeInfo     = escapeHtml(getStoreLabel(purchase._storeId) || '');

  const dateStr = purchase.date
    ? new Date(purchase.date).toLocaleDateString('en-NG', {
        day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }).toUpperCase()
    : '—';

  const items    = Array.isArray(purchase.items) ? purchase.items : [];
  const charge   = purchase.serviceCharge || 0;
  const subTotal = purchase.cartSubtotal  || (Number(purchase.total||0) - charge);

  const itemRows = items.map(i => {
    const price = Number(i.price)||0, qty = Number(i.quantity)||0;
    return `<tr>
      <td>${escapeHtml(i.name)}</td>
      <td style="text-align:center;">${qty}</td>
      <td style="text-align:right;">₦${price.toFixed(2)}</td>
      <td style="text-align:right;">₦${(price*qty).toFixed(2)}</td>
    </tr>`;
  }).join('');

  const chargeRows = charge > 0 ? `
    <tr class="subtotal-row">
      <td colspan="3" style="text-align:right;color:#7A6050;">Subtotal</td>
      <td style="text-align:right;color:#7A6050;">₦${subTotal.toFixed(2)}</td>
    </tr>
    <tr class="subtotal-row">
      <td colspan="3" style="text-align:right;color:#7A6050;">Convenience Fee</td>
      <td style="text-align:right;color:#7A6050;">₦${charge.toFixed(2)}</td>
    </tr>` : '';

  const verifiedRow = purchase.verified ? `
    <div class="info-row">
      <span class="info-label">Verified At</span>
      <span class="info-value">${escapeHtml(new Date(purchase.verifiedDate).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}))}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Verified By</span>
      <span class="info-value">${cashierName}</span>
    </div>` : '';

  const printWindow = window.open('', '', 'width=800,height=950');
  printWindow.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CGrocs Receipt — ${purchaseId_s}</title>
  <style>
    *  { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #fff; color: #2D1A0A;
      padding: 40px 48px; max-width: 640px; margin: 0 auto;
    }

    /* ── Header ── */
    .header {
      display: flex; justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 28px; padding-bottom: 20px;
      border-bottom: 2px solid #2D1A0A;
    }
    .brand-name  { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; color: #2D1A0A; }
    .brand-store { font-size: 13px; color: #7A6050; margin-top: 4px; }
    .receipt-label {
      text-align: right;
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .1em; color: #7A6050;
    }
    .receipt-date { font-size: 13px; color: #2D1A0A; margin-top: 4px; }

    /* ── Customer card ── */
    .customer-card {
      background: #f5ede4; border-radius: 12px;
      padding: 20px 24px; margin-bottom: 28px;
    }
    .customer-card-label {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #7A6050; margin-bottom: 12px;
    }
    .info-row {
      display: flex; justify-content: space-between;
      align-items: baseline; padding: 6px 0;
      border-bottom: 1px solid rgba(107,63,31,0.12); font-size: 14px;
    }
    .info-row:last-child { border-bottom: none; }
    .info-label  { color: #7A6050; }
    .info-value  { font-weight: 600; text-align: right; font-family: inherit; }
    .info-value.mono { font-family: 'Courier New', monospace; font-size: 13px; }

    /* ── Order info ── */
    .order-card {
      margin-bottom: 28px;
      border: 1.5px solid #e4e4e7; border-radius: 12px;
      overflow: hidden;
    }
    .order-card-head {
      background: #2D1A0A; color: white;
      padding: 12px 20px;
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .08em;
    }
    .order-card-body { padding: 4px 20px 12px; }

    /* ── Items table ── */
    .items-label {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #7A6050; margin-bottom: 10px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    thead tr { background: #2D1A0A; color: white; }
    thead th {
      padding: 10px 12px; font-weight: 700;
      font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    }
    thead th:first-child { text-align: left; border-radius: 6px 0 0 6px; }
    thead th:last-child  { text-align: right; border-radius: 0 6px 6px 0; }
    thead th:nth-child(2),
    thead th:nth-child(3) { text-align: center; }
    tbody tr td {
      padding: 11px 12px; border-bottom: 1px solid #e4e4e7;
      vertical-align: middle;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody td:nth-child(2) { text-align: center; }
    tbody td:nth-child(3),
    tbody td:nth-child(4) { text-align: right; }
    .subtotal-row td { padding: 8px 12px; font-size: 13px; }
    .total-row td {
      padding: 13px 12px; font-size: 16px; font-weight: 800;
      border-top: 2px solid #2D1A0A !important;
      color: #6B3F1F;
    }

    /* ── Footer ── */
    .footer {
      margin-top: 32px; padding-top: 18px;
      border-top: 1px solid #e4e4e7;
      text-align: center; font-size: 12px; color: #7A6050; line-height: 1.8;
    }

    @media print {
      body { padding: 20px; }
      @page { margin: 12mm; size: A5 portrait; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div>
      <div class="brand-name">CGrocs</div>
      <div class="brand-store">${storeInfo}</div>
    </div>
    <div class="receipt-label">
      Purchase Receipt
      <div class="receipt-date">${dateStr}</div>
    </div>
  </div>

  <!-- Customer -->
  <div class="customer-card">
    <div class="customer-card-label">Customer</div>
    <div class="info-row">
      <span class="info-label">Name</span>
      <span class="info-value">${customerName}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Phone</span>
      <span class="info-value">${customerPhone}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Email</span>
      <span class="info-value">${customerEmail}</span>
    </div>
  </div>

  <!-- Order info -->
  <div class="order-card">
    <div class="order-card-head">Order Info</div>
    <div class="order-card-body">
      <div class="info-row" style="margin-top:8px;">
        <span class="info-label">Purchase ID</span>
        <span class="info-value mono">${purchaseId_s}</span>
      </div>
      ${verifiedRow}
    </div>
  </div>

  <!-- Items -->
  <div class="items-label">Items Purchased</div>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Qty</th>
        <th>Unit Price</th>
        <th style="text-align:right;">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      ${chargeRows}
      <tr class="total-row">
        <td colspan="3" style="text-align:right;">Total Paid</td>
        <td style="text-align:right;">₦${Number(purchase.total||0).toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <div class="footer">
    Thank you for shopping at CGrocs · ${storeInfo}<br>
    Reprinted at ${new Date().toLocaleString('en-NG', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}
  </div>

  <script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`);
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
  // Apply shared store filter
  if (_storeFilter !== 'all') list = list.filter(l => (l._storeId || 'store1') === _storeFilter);
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
      ? `<span style="font-size:11px;background:#f4f4f5;border-radius:20px;padding:2px 8px;color:#7A6050;margin-top:4px;display:inline-block;">${escapeHtml(storeLabel(log._storeId))}</span>` : '';
    const changesHtml = (log.changes && log.changes.length > 0)
      ? log.changes.map(c=>`<div class="prod-change-row"><span class="prod-change-field">${escapeHtml(c.field)}</span><span class="prod-change-from">${escapeHtml(String(c.from))}</span><span class="prod-change-arrow">→</span><span class="prod-change-to">${escapeHtml(String(c.to))}</span></div>`).join('')
      : `<span style="color:var(--muted);font-size:12px;">${isAdd ? 'New product' : isDelete ? 'Product removed' : '—'}</span>`;
    const cashierDisplay = (log.cashierEmail && _cashierNameMap[log.cashierEmail.toLowerCase()])
      ? _cashierNameMap[log.cashierEmail.toLowerCase()]
      : (log.cashierName || log.cashierEmail || 'Unknown');
    return `
    <div class="list-row" style="grid-template-columns:1fr 1.5fr 1fr 2fr 1fr;align-items:start;">
      <div>${actionBadge}${storePill}</div>
      <div class="row-customer">${escapeHtml(log.productName||'—')}</div>
      <div><span class="cashier-chip"><span class="cashier-dot"></span>${escapeHtml(cashierDisplay)}</span></div>
      <div class="prod-changes-wrap">${changesHtml}</div>
      <div class="row-date">${date}</div>
    </div>`;
  }).join('');
}

function setText(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }

// ══════════════════════════════════════════════════════════════
//  STORE BANK ACCOUNT (SUBACCOUNT) SETTINGS
// ══════════════════════════════════════════════════════════════

// Cached bank list so we only fetch once per session
let _banksList = [];

// Load saved subaccount settings into the status badges in the Accounts tab
window.loadSubaccountSettingsUI = async function loadSubaccountSettingsUI() {
  const section = document.getElementById('subaccount-status-section');

  // Store-head sees only their store; general admin sees all stores
  const visibleStores = (_adminStores && _adminStores.length > 0)
    ? _adminStores
    : getStoreIds();

  if (section) {
    const rows = visibleStores.map(storeId => `
      <div class="subaccount-status-row">
        <span class="subaccount-store-name">${escapeHtml(getStoreLabel(storeId))}</span>
        <span id="subaccount-status-${escapeHtml(storeId)}" class="subaccount-status-value">Not configured — click Store Bank Accounts</span>
      </div>`).join('');
    section.innerHTML = `<div class="subaccount-status-title">Account Status</div>${rows}`;
  }

  try {
    const snap = await getDoc(doc(headAdminDb, 'transferSettings', 'stores'));
    if (!snap.exists()) return;
    const data = snap.data();
    visibleStores.forEach(storeId => {
      const s  = data[storeId];
      const el = document.getElementById(`subaccount-status-${storeId}`);
      if (el && s?.subaccount_code) {
        el.textContent = `${s.business_name} · ${s.account_number}`;
        el.style.color = '#16a34a';
      }
    });
  } catch (e) { console.warn('Could not load subaccount settings:', e.message); }
}

// Open the Store Bank Accounts modal
window.openStoreBankSettings = async function() {
  const existing = document.getElementById('store-bank-modal');
  if (existing) existing.remove();

  // Fetch banks list once per session via Vercel API
  if (_banksList.length === 0) {
    try {
      const res  = await fetch('/api/get-banks');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not fetch banks');
      _banksList = data.banks || [];
    } catch (e) {
      notify.error('Could not load banks list: ' + e.message);
      return;
    }
  }

  const bankOptions  = _banksList.map(b => `<option value="${b.code}">${b.name}</option>`).join('');
  const storesToShow = _currentRole === 'general' ? getStoreIds() : _adminStores;

  const modal = document.createElement('div');
  modal.id = 'store-bank-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;z-index:99999;padding:16px;overflow-y:auto;';

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:580px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;margin:auto;align-self:flex-start;">
      <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <h2 style="margin:0;font-size:18px;font-weight:700;">Store Bank Accounts</h2>
        </div>
        <button onclick="document.getElementById('store-bank-modal').remove()"
          style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">&#215;</button>
      </div>

      <div style="padding:28px 24px;display:flex;flex-direction:column;gap:32px;">
        ${storesToShow.map(storeId => `
        <div>
          <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#7A6050;margin-bottom:6px;padding-bottom:8px;border-bottom:1.5px solid #e4e4e7;">
            ${escapeHtml(getStoreLabel(storeId))}
          </div>
          <div id="sbs-status-${storeId}" style="font-size:13px;color:#7A6050;margin-bottom:14px;min-height:18px;"></div>

          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Business / Account Name</label>
            <input type="text" id="sbs-biz-${storeId}" placeholder="e.g. CGrocs Store One"
              style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;"
              onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Bank</label>
              <select id="sbs-bank-${storeId}"
                style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;"
                onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
                <option value="">— Select bank —</option>
                ${bankOptions}
              </select>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Account Number</label>
              <input type="text" id="sbs-acct-${storeId}" maxlength="10" placeholder="0123456789"
                style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:'DM Mono','Courier New',monospace;outline:none;"
                onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
            </div>
          </div>

          <div style="display:flex;gap:10px;align-items:flex-end;">
            <div style="flex:1;">
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Verified Account Name</label>
              <input type="text" id="sbs-name-${storeId}" placeholder="Tap Verify &amp; Save to confirm"
                style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:#fafafa;" readonly>
            </div>
            <button id="sbs-btn-${storeId}" onclick="verifyAndSaveStoreSubaccount('${storeId}')"
              style="padding:10px 18px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;">
              Verify &amp; Save
            </button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Pre-populate with saved settings
  try {
    const snap = await getDoc(doc(headAdminDb, 'transferSettings', 'stores'));
    if (snap.exists()) {
      const data = snap.data();
      storesToShow.forEach(storeId => {
        const s = data[storeId];
        if (!s) return;
        const bizEl  = document.getElementById(`sbs-biz-${storeId}`);
        const bankEl = document.getElementById(`sbs-bank-${storeId}`);
        const acctEl = document.getElementById(`sbs-acct-${storeId}`);
        const nameEl = document.getElementById(`sbs-name-${storeId}`);
        const stEl   = document.getElementById(`sbs-status-${storeId}`);
        if (bizEl)  bizEl.value  = s.business_name  || '';
        if (bankEl) bankEl.value = s.bank_code       || '';
        if (acctEl) acctEl.value = s.account_number  || '';
        if (nameEl) nameEl.value = s.business_name   || '';
        if (stEl && s.subaccount_code) {
          stEl.textContent = `Subaccount active: ${s.business_name} (${s.account_number})`;
          stEl.style.color = '#16a34a';
        }
      });
    }
  } catch (e) { /* non-fatal */ }
};

// Verify account then create/update the subaccount on Paystack
window.verifyAndSaveStoreSubaccount = async function(storeId) {
  const bizEl  = document.getElementById(`sbs-biz-${storeId}`);
  const bankEl = document.getElementById(`sbs-bank-${storeId}`);
  const acctEl = document.getElementById(`sbs-acct-${storeId}`);
  const nameEl = document.getElementById(`sbs-name-${storeId}`);
  const btn    = document.getElementById(`sbs-btn-${storeId}`);
  const stEl   = document.getElementById(`sbs-status-${storeId}`);

  const business_name  = bizEl?.value?.trim();
  const bank_code      = bankEl?.value;
  const account_number = acctEl?.value?.trim();

  if (!business_name)                         { notify.warning('Please enter a business name.'); return; }
  if (!bank_code)                             { notify.warning('Please select a bank.'); return; }
  if (!account_number || account_number.length < 10) { notify.warning('Please enter a valid 10-digit account number.'); return; }

  btn.disabled = true; btn.textContent = 'Verifying…';
  if (stEl) { stEl.textContent = 'Verifying account number…'; stEl.style.color = '#7A6050'; }

  try {
    // Step 1: Confirm the account number is real
    const verifyResp = await fetch('/api/verify-account', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ account_number, bank_code })
    });
    const verifyData = await verifyResp.json();
    if (!verifyResp.ok) throw new Error(verifyData.error || 'Account verification failed');
    const account_name = verifyData.account_name;
    if (nameEl) nameEl.value = account_name;
    if (stEl)   { stEl.textContent = `Verified: ${account_name}. Creating subaccount…`; stEl.style.color = '#d97706'; }

    // Step 2: Create / update the Paystack subaccount
    btn.textContent = 'Saving…';
    const saveResp = await fetch('/api/save-subaccount', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ storeId, business_name, bank_code, account_number })
    });
    const res = await saveResp.json();
    if (!saveResp.ok) throw new Error(res.error || 'Could not save subaccount');

    // Step 3: Persist to Firestore so data survives tab changes and page reloads
    await setDoc(
      doc(headAdminDb, 'transferSettings', 'stores'),
      {
        [storeId]: {
          subaccount_code: res.subaccount_code,
          business_name:   res.business_name,
          bank_code,
          account_number
        }
      },
      { merge: true }   // merge:true preserves other stores' data
    );

    if (stEl) {
      stEl.textContent = `Subaccount active: ${res.business_name} (${account_number})`;
      stEl.style.color = '#16a34a';
    }

    // Update the badge in the Accounts tab
    const badge = document.getElementById(`subaccount-status-${storeId}`);
    if (badge) { badge.textContent = `${res.business_name} · ${account_number}`; badge.style.color = '#16a34a'; }

    notify.success(`${getStoreLabel(storeId)} bank account saved! Payments will now split automatically.`);

  } catch (e) {
    console.error('Save subaccount error:', e);
    if (stEl) { stEl.textContent = 'Error: ' + (e.message || 'Unknown error'); stEl.style.color = '#dc2626'; }
    notify.error(e.message || 'Could not save bank account. Please try again.', 7000);
  } finally {
    btn.disabled = false; btn.textContent = 'Verify & Save';
  }
};

// ══════════════════════════════════════════════════════════════
//  STORE MANAGEMENT  (general admin only)
//  Stores are persisted in headAdminDb/storeConfig/list
//  { stores: [{ id, label }, ...] }
// ══════════════════════════════════════════════════════════════

window.openStoreManagement = async function() {
  const existing = document.getElementById('store-mgmt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'store-mgmt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;z-index:99999;padding:16px;overflow-y:auto;';

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:520px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;margin:auto;align-self:flex-start;">
      <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <h2 style="margin:0;font-size:18px;font-weight:700;">Manage Stores</h2>
          <p style="margin:3px 0 0;font-size:12px;color:rgba(255,255,255,0.5);">Rename, add, or remove store locations</p>
        </div>
        <button onclick="document.getElementById('store-mgmt-modal').remove()"
          style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">&#215;</button>
      </div>
      <div style="padding:24px;">
        <div id="store-mgmt-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;"></div>
        <div style="border-top:1.5px solid #e4e4e7;padding-top:20px;">
          <div style="font-size:13px;font-weight:700;color:#2D1A0A;margin-bottom:12px;">Add New Store</div>
          <div style="display:flex;gap:8px;">
            <input id="new-store-name" type="text" placeholder="e.g. Store 3 — Third Branch"
              style="flex:1;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;"
              onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'"
              onkeydown="if(event.key==='Enter')window._addStore()">
            <button onclick="window._addStore()"
              style="padding:10px 18px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">
              Add Store
            </button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  _renderStoreMgmtList();
};

function _renderStoreMgmtList() {
  const el = document.getElementById('store-mgmt-list');
  if (!el) return;
  const ids = getStoreIds();
  if (ids.length === 0) {
    el.innerHTML = '<p style="font-size:13px;color:#7A6050;text-align:center;">No stores yet.</p>';
    return;
  }
  el.innerHTML = ids.map(id => `
    <div id="store-row-${escapeHtml(id)}" style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:#f9fafb;border-radius:10px;border:1.5px solid #e4e4e7;">
      <span style="font-size:13px;font-weight:600;color:#2D1A0A;flex:1;" id="store-lbl-${escapeHtml(id)}">${escapeHtml(getStoreLabel(id))}</span>
      <span style="font-size:11px;color:#9ca3af;font-family:monospace;">${escapeHtml(id)}</span>
      <button class="ha-btn-store-edit" data-storeid="${escapeHtml(id)}"
        style="padding:5px 12px;background:white;border:1.5px solid #e4e4e7;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;color:#374151;">
        Rename
      </button>
      <button class="ha-btn-store-del" data-storeid="${escapeHtml(id)}"
        style="padding:5px 10px;background:#fff5f5;border:1.5px solid #fee2e2;border-radius:6px;font-size:12px;cursor:pointer;color:#dc2626;">
        &#215;
      </button>
    </div>`).join('');
}

// Event delegation for store management list buttons
document.addEventListener('click', e => {
  const editBtn = e.target.closest('.ha-btn-store-edit');
  if (editBtn) { window._editStoreInline(editBtn.dataset.storeid); return; }
  const delBtn = e.target.closest('.ha-btn-store-del');
  if (delBtn) { window._deleteStore(delBtn.dataset.storeid); }
});

window._editStoreInline = function(id) {
  const row = document.getElementById(`store-row-${id}`);
  if (!row) return;
  const current = getStoreLabel(id);
  const safeId  = escapeHtml(id);
  row.innerHTML = `
    <input id="edit-store-input-${safeId}" type="text" value="${escapeHtml(current)}"
      style="flex:1;padding:8px 12px;border:1.5px solid #0a0a0a;border-radius:6px;font-size:13px;font-family:inherit;outline:none;">
    <span style="font-size:11px;color:#9ca3af;font-family:monospace;">${safeId}</span>
    <button class="ha-btn-store-save" data-storeid="${safeId}"
      style="padding:5px 14px;background:#0a0a0a;color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">
      Save
    </button>
    <button class="ha-btn-store-cancel"
      style="padding:5px 10px;background:white;border:1.5px solid #e4e4e7;border-radius:6px;font-size:12px;cursor:pointer;">
      Cancel
    </button>`;
  const input = document.getElementById(`edit-store-input-${safeId}`);
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  window._saveStoreRename(id);
      if (e.key === 'Escape') window._renderStoreMgmtList();
    });
    input.focus();
  }
};
// Event delegation for store inline-edit save/cancel buttons
document.addEventListener('click', e => {
  const saveBtn = e.target.closest('.ha-btn-store-save');
  if (saveBtn) { window._saveStoreRename(saveBtn.dataset.storeid); return; }
  const cancelBtn = e.target.closest('.ha-btn-store-cancel');
  if (cancelBtn) { window._renderStoreMgmtList(); }
});

window._renderStoreMgmtList = _renderStoreMgmtList;

window._saveStoreRename = async function(id) {
  const input = document.getElementById(`edit-store-input-${id}`);
  const label = input?.value.trim();
  if (!label) { notify.warning('Store name cannot be empty.'); return; }

  _storeMap.set(id, label);
  try {
    await saveStoreConfig();
    _renderStoreMgmtList();
    refreshStoreUI();
    notify.success(`Store renamed to "${label}"`);
  } catch (e) {
    notify.error('Could not save: ' + e.message);
    _renderStoreMgmtList();
  }
};

window._addStore = async function() {
  const input = document.getElementById('new-store-name');
  const label = input?.value.trim();
  if (!label) { notify.warning('Please enter a store name.'); return; }

  // Auto-generate a sequential ID
  const newId = `store${_storeMap.size + 1}`;
  if (_storeMap.has(newId)) {
    // Fallback if auto-id already taken
    notify.error('Could not generate a unique store ID. Please rename an existing store first.');
    return;
  }

  _storeMap.set(newId, label);
  try {
    await saveStoreConfig();
    if (input) input.value = '';
    _renderStoreMgmtList();
    refreshStoreUI();
    notify.success(`"${label}" added as ${newId}!`);
  } catch (e) {
    _storeMap.delete(newId);
    notify.error('Could not save: ' + e.message);
  }
};

window._deleteStore = function(id) {
  const label = getStoreLabel(id);

  // Two-step confirm — first warn, then a second harder confirm with the store name
  notify.confirm(
    `Permanently delete "${label}"?\n\nThis will erase ALL products, purchases, categories and logs for this store from Firestore. This cannot be undone.`,
    () => {
      notify.prompt(
        `Type the store ID "${id}" to confirm permanent deletion:`,
        '',
        async (typed) => {
          if (typed.trim() !== id) {
            notify.error(`Cancelled — "${typed}" does not match "${id}".`);
            return;
          }

          // Show a progress indicator in the store row while deleting
          const row = document.getElementById(`store-row-${id}`);
          if (row) {
            row.innerHTML = `<span style="font-size:13px;color:#7A6050;padding:4px 0;">Deleting all data for ${label}…</span>`;
          }

          try {
            const res  = await fetch('/api/delete-store', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ storeId: id })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Server error during deletion.');

            // Remove from the in-memory map (storeConfig already updated by the API)
            _storeMap.delete(id);
            _renderStoreMgmtList();
            refreshStoreUI();
            notify.success(`"${label}" and all its data have been permanently deleted.`);

          } catch (e) {
            console.error('[delete-store]', e);
            notify.error('Deletion failed: ' + e.message);
            // Re-render the list so the row comes back
            _renderStoreMgmtList();
          }
        }
      );
    }
  );
};

// ══════════════════════════════════════════════════════════════
//  HEAD ADMIN MANAGEMENT  (general admin only)
//  Create, edit, and delete store-head and general admin accounts
// ══════════════════════════════════════════════════════════════

window.openHeadAdminManagement = async function() {
  const existing = document.getElementById('ha-mgmt-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'ha-mgmt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;z-index:99999;padding:16px;overflow-y:auto;';

  const storeOptions = getStoreIds().map(id => `<option value="${id}">${getStoreLabel(id)}</option>`).join('');

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:620px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;margin:auto;align-self:flex-start;">
      <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <h2 style="margin:0;font-size:18px;font-weight:700;">Head Admin Accounts</h2>
          <p style="margin:3px 0 0;font-size:12px;color:rgba(255,255,255,0.5);">Create and manage store head admin logins</p>
        </div>
        <button onclick="document.getElementById('ha-mgmt-modal').remove()"
          style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">&#215;</button>
      </div>

      <!-- Create form -->
      <div style="padding:22px 24px 0;">
        <div style="font-size:13px;font-weight:700;color:#2D1A0A;margin-bottom:14px;">Create New Head Admin</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Full Name</label>
            <input id="ha-new-name" type="text" placeholder="Jane Doe" autocomplete="off"
              style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;"
              onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Role</label>
            <select id="ha-new-role" onchange="window._toggleHaStoreField()"
              style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;box-sizing:border-box;"
              onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
              <option value="store-head">Store Head Admin</option>
              <option value="general">General Admin (all stores)</option>
            </select>
          </div>
        </div>
        <div id="ha-store-field" style="margin-bottom:12px;">
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Assigned Store</label>
          <select id="ha-new-store"
            style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;box-sizing:border-box;"
            onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
            ${storeOptions}
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Email</label>
            <input id="ha-new-email" type="email" placeholder="jane@cloexstore.com" autocomplete="off"
              style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;"
              onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Password</label>
            <div style="position:relative;">
              <input id="ha-new-password" type="password" placeholder="At least 6 characters" autocomplete="new-password"
                style="width:100%;padding:10px 52px 10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;"
                onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
              <button type="button" id="ha-pw-toggle" onclick="(function(){var i=document.getElementById('ha-new-password'),b=document.getElementById('ha-pw-toggle'),s=i.type==='password';i.type=s?'text':'password';b.innerHTML=s?'<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;18&quot; height=&quot;18&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot;><path d=&quot;M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z&quot;/><circle cx=&quot;12&quot; cy=&quot;12&quot; r=&quot;3&quot;/></svg>':'<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;18&quot; height=&quot;18&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot;><path d=&quot;M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94&quot;/><path d=&quot;M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19&quot;/><line x1=&quot;1&quot; y1=&quot;1&quot; x2=&quot;23&quot; y2=&quot;23&quot;/></svg>';b.setAttribute('aria-label',s?'Hide password':'Show password');})()"
                aria-label="Show password"
                style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;padding:2px;display:flex;align-items:center;justify-content:center;color:#7A6050;cursor:pointer;line-height:0;transition:color .2s;"
                onmouseover="this.style.color='#0a0a0a'" onmouseout="this.style.color='#7A6050'">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              </button>
            </div>
          </div>
        </div>
        <button id="ha-create-btn" onclick="window._createHeadAdmin()"
          style="width:100%;padding:11px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:22px;">
          Create Head Admin Account
        </button>
      </div>

      <!-- Existing head admins list -->
      <div style="border-top:1.5px solid #e4e4e7;padding:18px 24px 24px;">
        <div style="font-size:13px;font-weight:700;color:#2D1A0A;margin-bottom:14px;">Existing Head Admins</div>
        <div id="ha-list" style="display:flex;flex-direction:column;gap:8px;">
          <p style="font-size:13px;color:#7A6050;">Loading…</p>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  window._loadHeadAdminList();
};

window._toggleHaStoreField = function() {
  const role = document.getElementById('ha-new-role')?.value;
  const field = document.getElementById('ha-store-field');
  if (field) field.style.display = role === 'general' ? 'none' : '';
};

window._loadHeadAdminList = async function() {
  const listEl = document.getElementById('ha-list');
  if (!listEl) return;
  try {
    const [adminsSnap, profilesSnap] = await Promise.all([
      getDocs(collection(headAdminDb, 'admins')),
      getDocs(collection(headAdminDb, 'headAdmins'))
    ]);

    const profiles = {};
    profilesSnap.forEach(d => { profiles[d.id] = d.data(); });

    const admins = [];
    adminsSnap.forEach(d => {
      const role = d.data().role;
      if (role === 'general' || role === 'store-head') {
        admins.push({ uid: d.id, ...d.data(), ...profiles[d.id] });
      }
    });

    if (admins.length === 0) {
      listEl.innerHTML = '<p style="font-size:13px;color:#7A6050;">No head admins yet.</p>';
      return;
    }

    listEl.innerHTML = admins.sort((a,b) => (a.name||'').localeCompare(b.name||'')).map(a => {
      const rolePill = a.role === 'general'
        ? `<span style="font-size:11px;background:#dbeafe;color:#1d4ed8;border-radius:20px;padding:2px 8px;font-weight:700;">General</span>`
        : `<span style="font-size:11px;background:#f4f4f5;color:#374151;border-radius:20px;padding:2px 8px;font-weight:600;">${escapeHtml(getStoreLabel(a.storeId||''))}</span>`;
      return `
      <div id="ha-row-${escapeHtml(a.uid)}" style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f9fafb;border-radius:10px;border:1.5px solid #e4e4e7;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:#2D1A0A;">${escapeHtml(a.name||'—')}</div>
          <div style="font-size:12px;color:#7A6050;">${escapeHtml(a.email||'—')}</div>
        </div>
        ${rolePill}
        <button class="ha-btn-edit-ha" data-uid="${escapeHtml(a.uid||'')}"
          style="padding:5px 12px;background:white;border:1.5px solid #e4e4e7;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;color:#374151;flex-shrink:0;">
          Edit
        </button>
        <button class="ha-btn-del-ha" data-uid="${escapeHtml(a.uid||'')}" data-name="${escapeHtml(a.name||'Head Admin')}"
          style="padding:5px 10px;background:#fff5f5;border:1.5px solid #fee2e2;border-radius:6px;font-size:12px;cursor:pointer;color:#dc2626;flex-shrink:0;">
          &#215;
        </button>
      </div>`;
    }).join('');
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p style="font-size:13px;color:#dc2626;">Could not load accounts: ${e.message}</p>`;
  }
};

// Event delegation for head admin list edit/delete buttons
document.addEventListener('click', e => {
  const editBtn = e.target.closest('.ha-btn-edit-ha');
  if (editBtn) { window._openEditHeadAdmin(editBtn.dataset.uid); return; }
  const delBtn = e.target.closest('.ha-btn-del-ha');
  if (delBtn) { window._deleteHeadAdmin(delBtn.dataset.uid, delBtn.dataset.name); }
});

window._createHeadAdmin = async function() {
  const name     = document.getElementById('ha-new-name')?.value.trim();
  const role     = document.getElementById('ha-new-role')?.value;
  const storeId  = document.getElementById('ha-new-store')?.value;
  const email    = document.getElementById('ha-new-email')?.value.trim();
  const password = document.getElementById('ha-new-password')?.value;

  if (!name)                       { notify.warning('Please enter a name.'); return; }
  if (!email)                      { notify.warning('Please enter an email address.'); return; }
  if (!password || password.length < 6) { notify.warning('Password must be at least 6 characters.'); return; }

  const btn = document.getElementById('ha-create-btn');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const res  = await fetch('/api/create-head-admin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password, role, storeId: role === 'general' ? null : storeId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create account.');

    notify.success(`Head admin account created for ${name}!`);
    ['ha-new-name','ha-new-email','ha-new-password'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    window._loadHeadAdminList();
  } catch (e) {
    notify.error(e.message || 'Could not create account.');
  } finally {
    btn.disabled = false; btn.textContent = 'Create Head Admin Account';
  }
};

window._deleteHeadAdmin = function(uid, name) {
  notify.confirm(`Delete head admin account for "${name}"? This cannot be undone.`, async () => {
    const row = document.getElementById(`ha-row-${uid}`);
    if (row) { row.style.opacity = '0.4'; row.style.pointerEvents = 'none'; }
    try {
      const res  = await fetch('/api/delete-head-admin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uid })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete account.');
      notify.success(`"${name}" deleted.`);
      window._loadHeadAdminList();
    } catch (e) {
      notify.error('Could not delete: ' + e.message);
      if (row) { row.style.opacity = ''; row.style.pointerEvents = ''; }
    }
  });
};

window._openEditHeadAdmin = async function(uid) {
  // Load current data
  let adminData = {}, profileData = {};
  try {
    const [adminSnap, profileSnap] = await Promise.all([
      getDoc(doc(headAdminDb, 'admins', uid)),
      getDoc(doc(headAdminDb, 'headAdmins', uid))
    ]);
    if (adminSnap.exists())   adminData   = adminSnap.data();
    if (profileSnap.exists()) profileData = profileSnap.data();
  } catch (e) { notify.error('Could not load admin details.'); return; }

  const existing = document.getElementById('ha-edit-modal');
  if (existing) existing.remove();

  const storeOptions = getStoreIds().map(id =>
    `<option value="${id}"${id === adminData.storeId ? ' selected' : ''}>${getStoreLabel(id)}</option>`
  ).join('');

  const modal = document.createElement('div');
  modal.id = 'ha-edit-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;z-index:100000;padding:16px;overflow-y:auto;';

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:440px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;margin:auto;align-self:flex-start;">
      <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;font-size:17px;font-weight:700;">Edit Head Admin</h2>
        <button onclick="document.getElementById('ha-edit-modal').remove()"
          style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">&#215;</button>
      </div>
      <div style="padding:24px;display:flex;flex-direction:column;gap:14px;">
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Full Name</label>
          <input id="hae-name" type="text" value="${escapeHtml(profileData.name||'')}"
            style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box;"
            onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Role</label>
          <select id="hae-role" onchange="window._toggleHaeStoreField()"
            style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;box-sizing:border-box;"
            onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
            <option value="store-head"${adminData.role === 'store-head' ? ' selected' : ''}>Store Head Admin</option>
            <option value="general"${adminData.role === 'general' ? ' selected' : ''}>General Admin (all stores)</option>
          </select>
        </div>
        <div id="hae-store-field" style="${adminData.role === 'general' ? 'display:none' : ''}">
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Assigned Store</label>
          <select id="hae-store"
            style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;box-sizing:border-box;"
            onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
            ${storeOptions}
          </select>
        </div>
        <div style="display:flex;gap:10px;margin-top:4px;">
          <button onclick="document.getElementById('ha-edit-modal').remove()"
            style="flex:1;padding:11px;background:white;color:#2D1A0A;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">
            Cancel
          </button>
          <button id="hae-save-btn" onclick="window._saveEditHeadAdmin('${uid}')"
            style="flex:1;padding:11px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">
            Save Changes
          </button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

window._toggleHaeStoreField = function() {
  const role = document.getElementById('hae-role')?.value;
  const field = document.getElementById('hae-store-field');
  if (field) field.style.display = role === 'general' ? 'none' : '';
};

window._saveEditHeadAdmin = async function(uid) {
  const name    = document.getElementById('hae-name')?.value.trim();
  const role    = document.getElementById('hae-role')?.value;
  const storeId = document.getElementById('hae-store')?.value;

  if (!name) { notify.warning('Name cannot be empty.'); return; }

  const btn = document.getElementById('hae-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const roleData    = { role, email: (await getDoc(doc(headAdminDb, 'headAdmins', uid))).data()?.email || '' };
    if (role === 'store-head') roleData.storeId = storeId;

    await Promise.all([
      setDoc(doc(headAdminDb, 'admins', uid),     roleData,          { merge: true }),
      setDoc(doc(headAdminDb, 'headAdmins', uid), { name },          { merge: true })
    ]);

    document.getElementById('ha-edit-modal')?.remove();
    notify.success('Head admin updated.');
    window._loadHeadAdminList();
  } catch (e) {
    notify.error('Could not save: ' + e.message);
    btn.disabled = false; btn.textContent = 'Save Changes';
  }
};

// ── COPY PRODUCTS (general admin only) ───────────────────────────────────────

window.openCopyProductsModal = function() {
  const existing = document.getElementById('copy-products-modal');
  if (existing) existing.remove();

  const storeIds    = getStoreIds();
  const storeOptions = storeIds.map(id =>
    `<option value="${escapeHtml(id)}">${escapeHtml(getStoreLabel(id))}</option>`
  ).join('');

  const modal = document.createElement('div');
  modal.id = 'copy-products-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;z-index:99999;padding:16px;overflow-y:auto;';

  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:480px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;margin:auto;align-self:flex-start;">

      <!-- Header -->
      <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <h2 style="margin:0;font-size:18px;font-weight:700;">Copy Products</h2>
          <p style="margin:3px 0 0;font-size:12px;color:rgba(255,255,255,0.5);">Copy all products from one store to another</p>
        </div>
        <button onclick="document.getElementById('copy-products-modal').remove()"
          style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">&#215;</button>
      </div>

      <!-- Body -->
      <div style="padding:28px 24px 24px;display:flex;flex-direction:column;gap:18px;">

        <div style="background:#f4f4f5;border-radius:10px;padding:14px 16px;font-size:13px;color:#7A6050;line-height:1.6;">
          ⚠️ This will <strong style="color:#0a0a0a;">add</strong> all products from the source store into the destination store.
          Existing products in the destination store will <strong style="color:#0a0a0a;">not</strong> be deleted or overwritten.
        </div>

        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Copy From (Source)</label>
          <select id="copy-from-store"
            style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;"
            onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
            ${storeOptions}
          </select>
        </div>

        <div style="display:flex;align-items:center;justify-content:center;color:#7A6050;font-size:20px;">↓</div>

        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Copy To (Destination)</label>
          <select id="copy-to-store"
            style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;background:white;"
            onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
            ${storeOptions}
          </select>
        </div>

        <div id="copy-products-result" style="display:none;"></div>

        <div style="display:flex;gap:10px;margin-top:4px;">
          <button onclick="document.getElementById('copy-products-modal').remove()"
            style="flex:1;padding:12px;background:white;color:#111;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">
            Cancel
          </button>
          <button id="copy-products-btn" onclick="window._executeCopyProducts()"
            style="flex:2;padding:12px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">
            Copy Products
          </button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Default second store to a different option if possible
  const toSelect = document.getElementById('copy-to-store');
  if (storeIds.length > 1) toSelect.value = storeIds[1];
};

window._executeCopyProducts = async function() {
  const fromId  = document.getElementById('copy-from-store')?.value;
  const toId    = document.getElementById('copy-to-store')?.value;
  const btn     = document.getElementById('copy-products-btn');
  const result  = document.getElementById('copy-products-result');

  if (!fromId || !toId) {
    notify.error('Please select both stores.'); return;
  }
  if (fromId === toId) {
    notify.error('Source and destination stores must be different.'); return;
  }

  btn.disabled    = true;
  btn.textContent = 'Copying…';
  result.style.display = 'none';

  try {
    // Read all products from source store
    const sourceSnap = await getDocs(collection(custDb, storeCol(fromId, 'products')));

    if (sourceSnap.empty) {
      notify.warning(`No products found in ${getStoreLabel(fromId)}.`);
      btn.disabled    = false;
      btn.textContent = 'Copy Products';
      return;
    }

    // Write each product to destination store using its original document ID
    // so re-running this is safe — same doc ID = overwrite, not duplicate
    const writes = sourceSnap.docs.map(d =>
      setDoc(
        doc(custDb, storeCol(toId, 'products'), d.id),
        { ...d.data(), _copiedFrom: fromId, _copiedAt: new Date().toISOString() },
        { merge: false }
      )
    );

    await Promise.all(writes);

    const count = sourceSnap.docs.length;
    result.style.display = '';
    result.innerHTML = `
      <div style="background:#dcfce7;border-radius:8px;padding:12px 16px;font-size:13px;color:#16a34a;font-weight:600;">
        ✓ Successfully copied ${count} product${count !== 1 ? 's' : ''} from
        <strong>${escapeHtml(getStoreLabel(fromId))}</strong> to
        <strong>${escapeHtml(getStoreLabel(toId))}</strong>.
      </div>`;

    btn.textContent = 'Done';
    notify.success(`${count} product${count !== 1 ? 's' : ''} copied to ${getStoreLabel(toId)}!`);

  } catch (e) {
    console.error('[copy-products]', e);
    result.style.display = '';
    result.innerHTML = `
      <div style="background:#fee2e2;border-radius:8px;padding:12px 16px;font-size:13px;color:#dc2626;font-weight:600;">
        ✗ Copy failed: ${escapeHtml(e.message)}
      </div>`;
    btn.disabled    = false;
    btn.textContent = 'Try Again';
  }
};
