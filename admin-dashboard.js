// admin-dashboard.js — Dashboard stats, cashier profile, low-stock alerts
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  getFirestore, collection, getDocs, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
// Fix #2: import from the single source of truth instead of copy-pasting configs
import { customerConfig, adminConfig } from "./firebase-config.js";

// ── Firebase: admin auth (for current user identity) ─────────────────────────
const adminApp  = getApps().find(a => a.name === 'admin-guard')
  || initializeApp(adminConfig, 'admin-guard');
const adminAuth = getAuth(adminApp);

// ── Firebase: customer project (purchases, products, AND cashier profiles) ───
// cloexadminlogin does not have Firestore enabled — store everything in the
// customer project which is already live.
const customerApp = getApps().find(a => a.name === 'cardstorage')
  || initializeApp(customerConfig, 'cardstorage');
const customerDb = getFirestore(customerApp);

// Cashier profiles live in the admin Firestore under "cashiers/{uid}".
// To use this, make sure Firestore is enabled in the cloexadminlogin Firebase project:
// Firebase Console → cloexadminlogin → Firestore Database → Create database
const adminDb = getFirestore(adminApp);

const LOW_STOCK_THRESHOLD = 5;
let cashierProfile = {};
let currentAdminUser = null;

// ── Auth: load cashier profile once admin is confirmed ───────────────────────
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
  } catch (e) {
    // Fix #8: surface a visible warning if the admin Firestore is not set up,
    // rather than silently failing. This most commonly means Firestore has not
    // been enabled in the cloexadminlogin Firebase project yet.
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

  // Nav avatar + name
  const navAvatar = document.getElementById('cashier-avatar');
  const navName   = document.getElementById('cashier-name');
  if (navAvatar) navAvatar.textContent = initials;
  if (navName)   navName.textContent   = displayName;

  // Dashboard profile card
  const dashAvatar = document.getElementById('dash-avatar');
  const dashName   = document.getElementById('dash-cashier-name');
  const dashEmail  = document.getElementById('dash-cashier-email');
  if (dashAvatar) dashAvatar.textContent = initials;
  if (dashName)   dashName.textContent   = cashierProfile.name  || 'No name set';
  if (dashEmail)  dashEmail.textContent  = cashierProfile.role  ? `${cashierProfile.role} · ${user.email}` : user.email;
}

// ── Load dashboard data ───────────────────────────────────────────────────────
window.loadDashboard = async function() {
  try {
    const [purchasesSnap, productsSnap] = await Promise.all([
      getDocs(collection(customerDb, 'purchases')),
      getDocs(collection(customerDb, 'products'))
    ]);

    const purchases = [];
    purchasesSnap.forEach(d => purchases.push(d.data()));

    const products = [];
    productsSnap.forEach(d => products.push({ id: d.id, ...d.data() }));

    // ── Stats ─────────────────────────────────────────────────────────────────
    const todayStr = new Date().toDateString();
    const todayOrders   = purchases.filter(p => p.date && new Date(p.date).toDateString() === todayStr);
    const pendingOrders = purchases.filter(p => !p.verified);
    const todayRevenue  = todayOrders.reduce((s, p) => s + (p.total || 0), 0);
    const lowStockItems = products.filter(p => p.stock <= LOW_STOCK_THRESHOLD && p.stock >= 0);

    setText('stat-today',    todayOrders.length);
    setText('stat-pending',  pendingOrders.length);
    setText('stat-revenue',  '₦' + todayRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }));
    setText('stat-lowstock', lowStockItems.length);

    // Colour pending stat red if any exist
    const pendingEl = document.getElementById('stat-pending');
    if (pendingEl) pendingEl.style.color = pendingOrders.length > 0 ? '#c0392b' : '#111';

    // Colour low-stock stat orange if any exist
    const lowEl = document.getElementById('stat-lowstock');
    if (lowEl) lowEl.style.color = lowStockItems.length > 0 ? '#e67e22' : '#111';

    // ── Low-stock list ─────────────────────────────────────────────────────────
    const lowStockEl = document.getElementById('low-stock-list');
    if (lowStockEl) {
      if (lowStockItems.length === 0) {
        lowStockEl.innerHTML = '<p class="dash-empty">All products are well stocked ✓</p>';
      } else {
        lowStockEl.innerHTML = lowStockItems
          .sort((a, b) => a.stock - b.stock)
          .map(p => {
            const pct   = Math.max(0, Math.min(100, (p.stock / LOW_STOCK_THRESHOLD) * 100));
            const color = p.stock === 0 ? '#c0392b' : p.stock <= 2 ? '#e67e22' : '#f39c12';
            return `
            <div class="low-stock-row">
              <div class="low-stock-info">
                <span class="low-stock-name">${p.name}</span>
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

    // ── Recent orders (verified only) ────────────────────────────────────────
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
          const date       = p.date ? new Date(p.date).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
          const method     = p.fulfillmentMethod === 'delivery' ? '🚚' : '🏪';
          const statusCls  = p.verified ? 'order-verified' : 'order-pending';
          const statusText = p.verified ? 'Verified' : 'Pending';
          const items      = p.items ? p.items.map(i => `${i.quantity}× ${i.name}`).join(', ') : '—';
          return `
          <div class="order-row">
            <div class="order-row-left">
              <span class="order-method">${method}</span>
              <div>
                <div class="order-items">${items}</div>
                <div class="order-date">${date}</div>
              </div>
            </div>
            <div class="order-row-right">
              <div class="order-amount">₦${p.total ? p.total.toLocaleString('en-NG', { minimumFractionDigits: 2 }) : '0.00'}</div>
              <span class="order-status ${statusCls}">${statusText}</span>
            </div>
          </div>`;
        }).join('');
      }
    }

  } catch (e) {
    console.error('Dashboard load error:', e);
    notify.error('Could not load dashboard data.');
  }
};

// ── Cashier profile modal ─────────────────────────────────────────────────────
window.openCashierProfileModal = function() {
  const existing = document.getElementById('cashier-profile-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'cashier-profile-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;';
  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.2);font-family:'Segoe UI',sans-serif;overflow:hidden;">
      <div style="background:#111;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;font-size:18px;font-weight:700;">Cashier Profile</h2>
        <button onclick="document.getElementById('cashier-profile-modal').remove()" style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">×</button>
      </div>
      <div style="padding:28px 24px 24px;">
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:6px;">Full Name</label>
          <input id="cp-name" type="text" value="${cashierProfile.name || ''}" placeholder="e.g. John Adeyemi"
            style="width:100%;padding:10px 13px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;outline:none;transition:border-color .2s;"
            onfocus="this.style.borderColor='#111'" onblur="this.style.borderColor='#ddd'">
        </div>
        <div style="margin-bottom:24px;">
          <label style="display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:6px;">Role</label>
          <input id="cp-role" type="text" value="${cashierProfile.role || ''}" placeholder="e.g. Senior Cashier"
            style="width:100%;padding:10px 13px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;outline:none;transition:border-color .2s;"
            onfocus="this.style.borderColor='#111'" onblur="this.style.borderColor='#ddd'">
        </div>
        <div style="display:flex;gap:10px;">
          <button onclick="document.getElementById('cashier-profile-modal').remove()" style="flex:1;padding:12px;background:white;color:#111;border:1.5px solid #ddd;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>
          <button onclick="window.saveCashierProfile()" style="flex:1;padding:12px;background:#111;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">Save</button>
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
    setText('dash-cashier-email', role ? `${role} · ${currentAdminUser.email}` : currentAdminUser.email);

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
