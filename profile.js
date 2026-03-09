import { initializeApp, getApps }        from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs }
                                          from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { customerConfig, storeCol } from "./firebase-config.js";

/* Security: escape all user-supplied or Firestore-sourced strings before
   injecting them into innerHTML to prevent XSS attacks. */
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const APP_NAME = 'cardstorage';
let app;
try {
    const existing = getApps().find(a => a.name === APP_NAME);
    app = existing ? existing : initializeApp(customerConfig, APP_NAME);
} catch(e) {
    console.error("Firebase init error in profile.js:", e);
}

const auth = getAuth(app);
const db   = getFirestore(app);

let currentUser = null;
let profileData = {};           // always holds the latest saved data from Firestore
let pendingAvatarBase64 = null; // tracks a newly picked photo this session
let _allPurchases = [];         // cached for filter re-renders
let _purchaseFilter = 'all';    // all | pending | ready | verified

//  Auth 
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        window.currentUser = user;
        document.body.style.visibility = 'visible';
        await loadProfile(user.uid);
        await loadPurchaseHistory(user.uid);
        setupLogoutButtons();
        setupAvatarInput(); // wire AFTER auth so profileData is ready
    } else {
        window.location.href = 'login.html';
    }
});

//  Load profile from Firestore 
async function loadProfile(uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid));
        profileData = snap.exists() ? snap.data() : {};
        console.log("Profile loaded. Avatar present:", !!profileData.avatar);
    } catch(e) {
        console.error("Error loading profile:", e);
        profileData = {};
    }

    const p = profileData;

    setValue('first-name',    p.firstName || '');
    setValue('last-name',     p.lastName  || '');
    setValue('phone',         p.phone     || '');
    setValue('email-display', currentUser.email || '');

    const fullName = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Your Name';
    setTextContent('sidebar-name',  fullName);
    setTextContent('sidebar-email', currentUser.email || '');

    // Show saved avatar, or fall back to initials via ui-avatars
    const avatarEl = document.getElementById('avatar-display');
    if (avatarEl) {
        avatarEl.src = p.avatar ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=111&color=fff&size=120`;
    }

    setTextContent('badge-phone',   p.phone   ? p.phone : 'No phone set');
    setTextContent('badge-address', p.address ? p.address : 'No address set');
}

//  Avatar file input 
// Fix #2: resizeImageToBase64 is no longer duplicated here — it is loaded
// from the shared avatar-upload.js which exposes it on window.
// profile.html now includes <script src="avatar-upload.js"></script>.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB — hard block at file input

// Called after auth resolves so profileData is populated before any save
function setupAvatarInput() {
    const input = document.getElementById('avatar-input');
    if (!input) return;

    // Remove any previously attached listeners by replacing the element
    const fresh = input.cloneNode(true);
    input.parentNode.replaceChild(fresh, input);

    fresh.addEventListener('change', async function(e) {
        const file = e.target.files[0];
        if (!file) return;

        //  Block oversized files immediately at selection 
        if (file.size > MAX_FILE_BYTES) {
            notify.error('Photo is too large. Please choose an image under 5MB.');
            fresh.value = '';
            return;
        }

        // Show a loading state on the avatar while processing
        const avatarEl = document.getElementById('avatar-display');
        if (avatarEl) {
            avatarEl.style.opacity = '0.4';
            avatarEl.style.filter  = 'blur(2px)';
        }

        try {
            // Use the shared resizeImageToBase64 from avatar-upload.js (window global)
            const compressed = await window.resizeImageToBase64(file, 200);
            pendingAvatarBase64 = compressed;

            // Show preview
            if (avatarEl) {
                avatarEl.src           = compressed;
                avatarEl.style.opacity = '1';
                avatarEl.style.filter  = '';
            }
            console.log("Avatar compressed and ready. Approx size:", Math.round(compressed.length / 1024), "KB");
        } catch(err) {
            console.error("Image resize error:", err);
            notify.error('Could not process image. Please try a different file.');
            fresh.value = '';
            if (avatarEl) { avatarEl.style.opacity = '1'; avatarEl.style.filter = ''; }
        }
    });
}

//  Save profile 
window.saveProfile = async function() {
    if (!currentUser) { notify.error("Not logged in."); return; }

    const firstName = document.getElementById('first-name').value.trim();
    const lastName  = document.getElementById('last-name').value.trim();

    if (!firstName || !lastName) {
        notify.error("Please enter your first and last name.");
        return;
    }

    // Decide which avatar to save:
    // 1. A newly picked photo this session (pendingAvatarBase64)
    // 2. The already-saved avatar from Firestore (profileData.avatar)
    // 3. Empty string as last resort (never wipes a saved photo accidentally)
    const avatarToSave = pendingAvatarBase64 || profileData.avatar || '';
    console.log("Saving avatar. New pick:", !!pendingAvatarBase64, "| Existing saved:", !!profileData.avatar);

    const updated = {
        ...profileData,             // carry over any fields we don't edit here
        firstName,
        lastName,
        fullName:        `${firstName} ${lastName}`,
        phone:           document.getElementById('phone').value.trim(),
        email:           currentUser.email,
        uid:             currentUser.uid,
        avatar:          avatarToSave,   // always explicitly set
        updatedAt:       new Date().toISOString()
    };

    try {
        await setDoc(doc(db, "users", currentUser.uid), updated, { merge: true });

        // Update local state so subsequent saves also have the correct avatar
        profileData = updated;
        pendingAvatarBase64 = null; // clear pending — it's now saved

        // Refresh sidebar
        setTextContent('sidebar-name',  updated.fullName);
        setTextContent('badge-phone',   updated.phone   ? updated.phone : 'No phone set');
        setTextContent('badge-address', updated.address ? updated.address : 'No address set');

        // Keep avatar display in sync
        const avatarEl = document.getElementById('avatar-display');
        if (avatarEl && updated.avatar) avatarEl.src = updated.avatar;

        notify.success("Profile saved successfully!");
        console.log("Profile saved. Avatar stored:", !!updated.avatar);
    } catch(e) {
        console.error("Save error:", e.code, e.message);
        if (e.code === 'permission-denied') {
            notify.error("Permission denied. Check your Firestore security rules.", 8000);
        } else {
            notify.error("Error saving profile: " + e.message);
        }
    }
};

//  Purchase history 
async function loadPurchaseHistory(uid) {
    const listEl = document.getElementById('purchase-list');
    if (!listEl) return;

    listEl.innerHTML = '<p class="empty-state">Loading...</p>';

    try {
        // Security fix: scope query to the current user instead of loading
        // all purchases and filtering client-side. This also improves performance.
        const storeId = sessionStorage.getItem('selectedStore') || 'store1';
        const q = query(
            collection(db, storeCol(storeId, 'purchases')),
            where('uid', '==', uid)
        );
        const snap = await getDocs(q);
        const purchases = [];
        snap.forEach(d => purchases.push(d.data()));

        if (purchases.length === 0) {
            listEl.innerHTML = '<p class="empty-state">No purchases yet.</p>';
            return;
        }

        purchases.sort((a, b) => new Date(b.date) - new Date(a.date));
        _allPurchases = purchases;

        // Inject filter controls above list (once)
        if (!document.getElementById('ph-filter-bar')) {
            listEl.insertAdjacentHTML('beforebegin', `
            <div id="ph-filter-bar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
                <button class="ph-filt-btn active" data-f="all"      onclick="window._filterPurchases(this)">All</button>
                <button class="ph-filt-btn" data-f="pending"   onclick="window._filterPurchases(this)"> Preparing</button>
                <button class="ph-filt-btn" data-f="ready"     onclick="window._filterPurchases(this)">Ready</button>
                <button class="ph-filt-btn" data-f="verified"  onclick="window._filterPurchases(this)">Collected</button>
            </div>
            <style>
                .ph-filt-btn{padding:6px 14px;border-radius:20px;border:1.5px solid #e4e4e7;background:white;color:#6b7280;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans','Segoe UI',sans-serif;transition:all .15s;}
                .ph-filt-btn:hover{border-color:#0a0a0a;color:#0a0a0a;}
                .ph-filt-btn.active{background:#0a0a0a;color:white;border-color:#0a0a0a;}
            </style>`);
        }

        _renderPurchaseList();

    } catch(e) {
        console.error("Error loading purchases:", e);
        listEl.innerHTML = '<p class="empty-state">Could not load purchase history.</p>';
    }
}

function _renderPurchaseList() {
    const listEl = document.getElementById('purchase-list');
    if (!listEl) return;
    const purchases = _purchaseFilter === 'all' ? _allPurchases
        : _purchaseFilter === 'verified' ? _allPurchases.filter(p => p.verified)
        : _purchaseFilter === 'ready'    ? _allPurchases.filter(p => !p.verified && p.orderStatus === 'ready')
        : _allPurchases.filter(p => !p.verified && p.orderStatus !== 'ready');

    if (purchases.length === 0) {
        listEl.innerHTML = '<p class="empty-state">No purchases match this filter.</p>';
        return;
    }

    listEl.innerHTML = purchases.slice(0, 40).map(p => {
        // Security: escape all values sourced from Firestore before injecting into DOM
        const safeId    = escapeHtml(p.id);
        const itemsText = p.items ? p.items.map(i => `${escapeHtml(String(i.quantity))}× ${escapeHtml(i.name)}`).join(', ') : 'Unknown items';
        const dateStr   = p.date ? new Date(p.date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
        const verifiedDate = p.verifiedDate ? new Date(p.verifiedDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

        // Status badge — 3 states: not_ready → ready → verified
        let statusHtml;
        if (p.verified) {
            statusHtml = `<span class="purchase-status status-verified">Collected${verifiedDate ? ' · ' + verifiedDate : ''}</span>`;
        } else if (p.orderStatus === 'ready') {
            const isDelivery = (p.fulfillmentMethod === 'delivery');
            const readyLabel = isDelivery ? ' Out for Delivery' : ' Ready for Pickup';
            statusHtml = `<span class="purchase-status status-ready">${readyLabel}</span>`;
        } else {
            statusHtml = `<span class="purchase-status status-pending"> Being Prepared</span>`;
        }

        // Fulfillment info — escape before injecting
        const method      = p.fulfillmentMethod || 'unknown';
        const methodLabel = method === 'pickup' ? 'Store Pickup' : method === 'delivery' ? 'Delivery' : '—';
        const addrText    = p.deliveryAddress && p.deliveryAddress !== 'Store pickup'
            ? escapeHtml(p.deliveryAddress) : '';

        // Security fix: use data-attributes instead of inline onclick with
        // unescaped string interpolation — prevents XSS via malicious purchase IDs.
        const qrBtn = safeId
            ? `<button class="btn-reshow-qr qr-trigger" data-id="${safeId}" data-total="${escapeHtml(String(p.total || 0))}">View QR</button>`
            : '';

        return `
        <div class="purchase-item purchase-item--col">
            <div class="purchase-item__row">
                <div class="purchase-meta">
                    <p class="purchase-id">${safeId || '—'}</p>
                    <p class="purchase-items-text">${itemsText}</p>
                    <p class="purchase-date">${dateStr}</p>
                </div>
                <div class="purchase-right">
                    <p class="purchase-amount">₦${p.total ? p.total.toLocaleString(undefined,{minimumFractionDigits:2}) : '0.00'}</p>
                    ${statusHtml}
                </div>
            </div>
            <div class="purchase-footer">
                <div class="purchase-detail">
                    <span>${methodLabel}</span>
                    ${addrText ? `<span class="purchase-addr">${addrText}</span>` : ''}
                    ${p.deliveryFee ? `<span class="purchase-fee">+₦${Number(p.deliveryFee).toLocaleString(undefined,{minimumFractionDigits:2})} delivery</span>` : ''}
                </div>
                ${qrBtn}
            </div>
        </div>`;
    }).join('');
}

//  Purchase history filter 
window._filterPurchases = function(btn) {
    document.querySelectorAll('.ph-filt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _purchaseFilter = btn.dataset.f;
    _renderPurchaseList();
};

// Delegated click handler for "View QR" buttons — avoids inline onclick
// with unescaped string interpolation in the HTML template.
document.addEventListener('click', function(e) {
    const btn = e.target.closest('.qr-trigger');
    if (!btn) return;
    const purchaseId = btn.dataset.id;
    const total      = btn.dataset.total;
    // Reconstruct items text from the rendered siblings for display only
    const card       = btn.closest('.purchase-item--col');
    const itemsEl    = card && card.querySelector('.purchase-items-text');
    const itemsText  = itemsEl ? itemsEl.textContent : '';
    window._reshowQR(purchaseId, itemsText, total);
});

//  Logout 
function setupLogoutButtons() {
    document.querySelectorAll('.logout-button').forEach(btn => {
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
            sessionStorage.setItem('intentional_logout', 'true');
            signOut(auth).then(() => {
                notify.success("Logged out!");
                sessionStorage.clear();
                window.location.href = 'home.html';
            });
        });
    });
}

//  Re-show QR modal from purchase history 
window._reshowQR = function(purchaseId, itemsText, total) {
    const existing = document.getElementById('profile-qr-modal');
    if (existing) existing.remove();

    // Security: escape everything before DOM injection
    const safePurchaseId = escapeHtml(purchaseId);
    const safeItemsText  = escapeHtml(itemsText);
    const safeTotal      = Number(total) || 0;

    const modal = document.createElement('div');
    modal.id = 'profile-qr-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;';
    modal.innerHTML = `
        <div style="background:white;border-radius:16px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.25);font-family:'DM Sans','Segoe UI',sans-serif;overflow:hidden;">
            <div style="background:#0a0a0a;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
                <h2 style="margin:0;font-size:18px;font-weight:700;">Purchase QR Code</h2>
                <button id="qr-modal-close" style="background:rgba(255,255,255,0.15);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&#215;</button>
            </div>
            <div style="padding:24px;text-align:center;">
                <p style="font-size:12px;color:#6b7280;margin-bottom:4px;">Purchase ID</p>
                <p style="font-family:'DM Mono','Courier New',monospace;font-size:14px;font-weight:700;color:#1a1a1a;background:#f5f5f5;padding:10px;border-radius:8px;word-break:break-all;margin-bottom:16px;">${safePurchaseId}</p>
                <p style="font-size:13px;color:#6b7280;margin-bottom:16px;">${safeItemsText}</p>
                <p style="font-size:16px;font-weight:700;color:#1a1a1a;margin-bottom:20px;">&#8358;${safeTotal.toLocaleString(undefined,{minimumFractionDigits:2})}</p>
                <div id="profile-qrcode" style="display:inline-block;margin-bottom:12px;"></div>
                <p style="font-size:12px;color:#9ca3af;font-style:italic;">Show this to the cashier for pickup verification</p>
                <div style="display:flex;gap:10px;margin-top:20px;">
                    <button id="qr-download-btn" style="flex:1;padding:11px;background:white;color:#1a1a1a;border:1.5px solid #0a0a0a;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Download</button>
                    <button id="qr-done-btn" style="flex:1;padding:11px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Done</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Wire up buttons via event listeners — no inline onclick needed
    modal.querySelector('#qr-modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#qr-done-btn').addEventListener('click',    () => modal.remove());
    modal.querySelector('#qr-download-btn').addEventListener('click', () => window._downloadProfileQR(purchaseId));
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Generate QR code — needs qrcodejs loaded on the page
    setTimeout(() => {
        if (typeof QRCode !== 'undefined') {
            new QRCode(document.getElementById('profile-qrcode'), {
                text: purchaseId,
                width: 180,
                height: 180,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
            });
        } else {
            document.getElementById('profile-qrcode').innerHTML =
                '<p style="color:#9ca3af;font-size:13px;">QR library not loaded.<br>Use the Purchase ID above.</p>';
        }
    }, 50);
};

window._downloadProfileQR = function(purchaseId) {
    const canvas = document.querySelector('#profile-qrcode canvas');
    if (!canvas) { notify.warning('QR code not ready yet.'); return; }
    const link = document.createElement('a');
    link.download = `purchase-${purchaseId}.png`;
    link.href = canvas.toDataURL();
    link.click();
};

//  Helpers 
function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

function setTextContent(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
