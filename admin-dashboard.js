// admin-dashboard.js — Dashboard stats, cashier profile, low-stock alerts
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  getFirestore, collection, getDocs, doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { customerConfig, adminConfig, headAdminConfig, storeCol, storeDoc, STORE_LABELS } from "./firebase-config.js";

//  Firebase 
const adminApp  = getApps().find(a => a.name === 'admin-guard')
  || initializeApp(adminConfig, 'admin-guard');
const adminAuth = getAuth(adminApp);

const customerApp = getApps().find(a => a.name === 'cardstorage')
  || initializeApp(customerConfig, 'cardstorage');
const customerDb = getFirestore(customerApp);

const adminDb = getFirestore(adminApp);

// Head-admin project — used only to read storeConfig/list for live store names
const headAdminApp = getApps().find(a => a.name === 'head-admin-guard')
  || initializeApp(headAdminConfig, 'head-admin-guard');
const headAdminDb = getFirestore(headAdminApp);

const LOW_STOCK_THRESHOLD = 5;
let cashierProfile = {};
let currentAdminUser = null;
let _cashierStoreId = 'store1'; // set after loading cashier profile

// Live purchases cache — kept up to date by the onSnapshot listener
let _dashPurchases = [];
let _dashPurchasesUnsub = null; // unsubscribe handle so we can restart if storeId changes

// Store-aware Firestore helpers
function custCol(name) { return collection(customerDb, storeCol(_cashierStoreId, name)); }

//  Security: escape HTML to prevent XSS when injecting user-controlled data 
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

//  Auth 
onAuthStateChanged(adminAuth, async (user) => {
    if (!user) return;
    currentAdminUser = user;
    await loadCashierProfile(user);
});

async function loadCashierProfile(user) {
    try {
        const snap = await getDoc(doc(adminDb, 'cashiers', user.uid));
        cashierProfile = snap.exists() ? snap.data() : {};
        window.cashierProfile = cashierProfile;

        // Set the active store for this cashier
        _cashierStoreId = cashierProfile.storeId || 'store1';
        window.cashierStoreId = _cashierStoreId;
        sessionStorage.setItem('cashierStoreId', _cashierStoreId);
    } catch (e) {
        console.warn('Could not load cashier profile:', e.message);
        if (typeof notify !== 'undefined') {
            notify.warning(
                'Cashier profile could not be loaded. ' +
                'Make sure Firestore is enabled in the admin Firebase project.',
                7000
            );
        }
        cashierProfile = {};
    }
    window.cashierProfile = cashierProfile;

    const displayName = cashierProfile.name || user.email.split('@')[0];
    const initials    = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    // Fetch live store label from Firestore storeConfig/list so renamed stores
    // display their current name instead of the hardcoded firebase-config.js fallback.
    let storeLabel = STORE_LABELS[_cashierStoreId] || _cashierStoreId;
    try {
        const cfgSnap = await getDoc(doc(headAdminDb, 'storeConfig', 'list'));
        if (cfgSnap.exists() && Array.isArray(cfgSnap.data().stores)) {
            const found = cfgSnap.data().stores.find(s => s.id === _cashierStoreId);
            if (found && found.label) storeLabel = found.label;
        }
    } catch (e) {
        console.warn('Could not load live store label, using default:', e.message);
    }

    const navAvatar = document.getElementById('cashier-avatar');
    const navName   = document.getElementById('cashier-name');
    if (navAvatar) navAvatar.textContent = initials;
    if (navName)   navName.textContent   = displayName;

    // Show store badge in nav if element exists
    const storeEl = document.getElementById('nav-store-label');
    if (storeEl) storeEl.textContent = storeLabel;

    const dashAvatar = document.getElementById('dash-avatar');
    const dashName   = document.getElementById('dash-cashier-name');
    const dashEmail  = document.getElementById('dash-cashier-email');
    if (dashAvatar) dashAvatar.textContent = initials;
    if (dashName)   dashName.textContent   = cashierProfile.name  || 'No name set';
    if (dashEmail)  dashEmail.textContent  = cashierProfile.role
        ? `${cashierProfile.role} · ${user.email} · ${storeLabel}`
        : `${user.email} · ${storeLabel}`;
}

//  Dashboard data 

// Separated render function so it can be called both from the onSnapshot
// callback and on-demand (e.g. when the cashier switches back to this tab).
function _renderDashboard(purchases, products) {
    const todayStr      = new Date().toDateString();
    const todayOrders   = purchases.filter(p => p.date && new Date(p.date).toDateString() === todayStr);
    const pendingOrders = purchases.filter(p => !p.verified);
    const lowStockItems = products.filter(p => p.stock <= LOW_STOCK_THRESHOLD && p.stock >= 0);

    setText('stat-today',    todayOrders.length);
    setText('stat-pending',  pendingOrders.length);
    setText('stat-lowstock', lowStockItems.length);

    const pendingEl = document.getElementById('stat-pending');
    if (pendingEl) pendingEl.style.color = pendingOrders.length > 0 ? '#dc2626' : '#2D1A0A';

    const lowEl = document.getElementById('stat-lowstock');
    if (lowEl) lowEl.style.color = lowStockItems.length > 0 ? '#d97706' : '#2D1A0A';

    // Low-stock list
    const lowStockEl = document.getElementById('low-stock-list');
    if (lowStockEl) {
        if (lowStockItems.length === 0) {
            lowStockEl.innerHTML = '<p class="dash-empty">All products are well stocked.</p>';
        } else {
            lowStockEl.innerHTML = lowStockItems
                .sort((a, b) => a.stock - b.stock)
                .map(p => {
                    const pct   = Math.max(0, Math.min(100, (p.stock / LOW_STOCK_THRESHOLD) * 100));
                    const color = p.stock === 0 ? '#dc2626' : p.stock <= 2 ? '#d97706' : '#f59e0b';
                    return `
                    <div class="low-stock-row">
                      <div class="low-stock-info">
                        <span class="low-stock-name">${escapeHtml(p.name)}</span>
                        <span class="low-stock-badge" style="background:${color}">
                          ${p.stock === 0 ? 'Out of Stock' : p.stock + ' left'}
                        </span>
                      </div>
                      <div class="low-stock-bar-wrap">
                        <div class="low-stock-bar" style="width:${pct}%;background:${color};"></div>
                      </div>
                    </div>`;
                }).join('');
        }
    }

    // Recent orders (verified)
    const recentEl = document.getElementById('recent-orders-list');
    if (recentEl) {
        const verifiedPurchases = purchases.filter(p => p.verified);
        if (verifiedPurchases.length === 0) {
            recentEl.innerHTML = '<p class="dash-empty">No verified orders yet.</p>';
        } else {
            const recent = [...verifiedPurchases]
                .sort((a, b) => new Date(b.verifiedDate || b.date) - new Date(a.verifiedDate || a.date))
                .slice(0, 8);
            recentEl.innerHTML = recent.map(p => {
                const date        = p.date ? new Date(p.date).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '\u2014';
                const methodLabel = p.fulfillmentMethod === 'delivery' ? 'Delivery' : 'Pickup';
                const statusCls   = p.verified ? 'order-verified' : 'order-pending';
                const statusText  = p.verified ? 'Verified' : 'Pending';
                const items       = p.items ? p.items.map(i => `${i.quantity}\u00d7 ${escapeHtml(i.name)}`).join(', ') : '\u2014';
                return `
                <div class="order-row">
                  <div class="order-row-left">
                    <span class="order-method">${methodLabel}</span>
                    <div>
                      <div class="order-items">${items}</div>
                      <div class="order-date">${date}</div>
                    </div>
                  </div>
                  <div class="order-row-right">
                    <div class="order-amount">\u20a6${p.total ? p.total.toLocaleString('en-NG', { minimumFractionDigits: 2 }) : '0.00'}</div>
                    <span class="order-status ${statusCls}">${statusText}</span>
                  </div>
                </div>`;
            }).join('');
        }
    }
}

// Cached products — refreshed each time loadDashboard() is called so low-stock
// stays accurate after edits, but doesn't need a real-time listener.
let _dashProducts = [];

window.loadDashboard = async function() {
    // Start (or restart) the live purchases listener if not already running
    // for this store. If the storeId changes (shouldn't happen mid-session
    // but guards against it), tear down the old listener first.
    if (!_dashPurchasesUnsub) {
        _dashPurchasesUnsub = onSnapshot(
            custCol('purchases'),
            (snap) => {
                _dashPurchases = [];
                snap.forEach(d => _dashPurchases.push(d.data()));
                // Re-render every time Firestore pushes an update
                _renderDashboard(_dashPurchases, _dashProducts);
            },
            (e) => {
                console.error('Dashboard purchases listener error:', e);
                notify.error('Could not load live dashboard data.');
            }
        );
    }

    // Always refresh products on tab switch so low-stock reflects recent edits
    try {
        const productsSnap = await getDocs(custCol('products'));
        _dashProducts = [];
        productsSnap.forEach(d => _dashProducts.push({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Dashboard products load error:', e);
        notify.error('Could not load product data.');
    }

    // Render immediately with whatever purchases we already have cached
    // (the onSnapshot will also fire and re-render, but this avoids a blank
    // dashboard while waiting for the first snapshot event).
    _renderDashboard(_dashPurchases, _dashProducts);
};

//  Cashier profile modal 
window.openCashierProfileModal = function() {
    const existing = document.getElementById('cashier-profile-modal');
    if (existing) existing.remove();

    /* Security fix: escape profile values before injecting into innerHTML */
    const safeName = escapeHtml(cashierProfile.name || '');
    const safeRole = escapeHtml(cashierProfile.role || '');

    const modal = document.createElement('div');
    modal.id = 'cashier-profile-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;';
    modal.innerHTML = `
        <div style="background:white;border-radius:16px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;">
            <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
                <h2 style="margin:0;font-size:18px;font-weight:700;">Cashier Profile</h2>
                <button onclick="document.getElementById('cashier-profile-modal').remove()" style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">&#215;</button>
            </div>
            <div style="padding:28px 24px 24px;">
                <div style="margin-bottom:16px;">
                    <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Full Name</label>
                    <input id="cp-name" type="text" value="${safeName}" placeholder="e.g. John Adeyemi"
                        style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;transition:border-color .2s;"
                        onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
                </div>
                <div style="margin-bottom:24px;">
                    <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7A6050;margin-bottom:6px;">Role</label>
                    <input id="cp-role" type="text" value="${safeRole}" placeholder="e.g. Senior Cashier"
                        style="width:100%;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;transition:border-color .2s;"
                        onfocus="this.style.borderColor='#0a0a0a'" onblur="this.style.borderColor='#e4e4e7'">
                </div>
                <div style="display:flex;gap:10px;">
                    <button onclick="document.getElementById('cashier-profile-modal').remove()" style="flex:1;padding:12px;background:white;color:#2D1A0A;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button>
                    <button onclick="window.saveCashierProfile()" style="flex:1;padding:12px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">Save</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('cp-name').focus();
};

window.saveCashierProfile = async function() {
    if (!currentAdminUser) { notify.error('Not authenticated.'); return; }
    const name = document.getElementById('cp-name').value.trim();
    const role = document.getElementById('cp-role').value.trim();
    if (!name) { notify.warning('Please enter a name.'); return; }

    try {
        const data = { name, role, email: currentAdminUser.email, updatedAt: new Date().toISOString() };
        await setDoc(doc(adminDb, 'cashiers', currentAdminUser.uid), data, { merge: true });
        cashierProfile = data;
        window.cashierProfile = cashierProfile;

        const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        ['cashier-avatar', 'dash-avatar'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = initials;
        });
        setText('cashier-name',       name);
        setText('dash-cashier-name',  name);
        setText('dash-cashier-email', role ? `${role} \u00b7 ${currentAdminUser.email}` : currentAdminUser.email);

        document.getElementById('cashier-profile-modal').remove();
        notify.success('Profile saved!');
    } catch (e) {
        console.error('Save error:', e);
        notify.error('Could not save profile: ' + e.message);
    }
};

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
