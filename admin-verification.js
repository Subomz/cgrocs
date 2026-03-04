// admin-verification.js — QR verification + pending purchases tab
import { getFirestore, collection, getDocs, onSnapshot, doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";

const app = getApps().find(a => a.name === 'cardstorage') || getApps()[0];
const db  = getFirestore(app);

let html5QrCode  = null;
let scannerActive = false;

// ── QR Scanner ────────────────────────────────────────────────────────────────
window.toggleScanner = function() {
  const qrReader = document.getElementById('qr-reader');
  const btnText  = document.getElementById('scanner-btn-text');
  if (!scannerActive) {
    qrReader.style.display = 'block';
    btnText.textContent = 'Stop Scanner';
    startScanner();
    scannerActive = true;
  } else {
    stopScanner();
    qrReader.style.display = 'none';
    btnText.textContent = 'Start Scanner';
    scannerActive = false;
  }
};

function startScanner() {
  html5QrCode = new Html5Qrcode("qr-reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      verifyPurchase(decodedText);
      stopScanner();
      document.getElementById('qr-reader').style.display = 'none';
      document.getElementById('scanner-btn-text').textContent = 'Start Scanner';
      scannerActive = false;
    },
    () => { /* ignore per-frame scan errors */ }
  ).catch((err) => {
    console.error("Unable to start scanner:", err);
    notify.error("Camera access denied or not available. Please use manual ID entry.");
    scannerActive = false;
    document.getElementById('qr-reader').style.display = 'none';
    document.getElementById('scanner-btn-text').textContent = 'Start Scanner';
  });
}

function stopScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => { html5QrCode.clear(); html5QrCode = null; })
      .catch(err => console.error("Error stopping scanner:", err));
  }
}

// ── Manual ID verify ──────────────────────────────────────────────────────────
window.verifyPurchaseId = function() {
  const purchaseId = document.getElementById('purchase-id-input').value.trim();
  if (!purchaseId) { notify.warning("Please enter a purchase ID"); return; }
  verifyPurchase(purchaseId);
};

// ── Main verification ─────────────────────────────────────────────────────────
async function verifyPurchase(purchaseId) {
  const resultDiv = document.getElementById('verification-result');
  resultDiv.style.display = 'block';
  resultDiv.className = 'verification-result';
  resultDiv.innerHTML = `
    <div style="text-align:center;padding:20px;">
      <div style="width:40px;height:40px;border:4px solid #f3f3f3;border-top:4px solid #000;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 15px;"></div>
      <p>Verifying purchase...</p>
    </div>
    <style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>`;

  try {
    const querySnapshot = await getDocs(collection(db, "purchases"));

    let purchase      = null;
    let purchaseDocId = null;

    // Fix #2: renamed loop variable from 'doc' to 'docSnap' to avoid
    // shadowing the imported Firestore doc() function used in updateDoc below.
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.id === purchaseId) {
        purchase      = data;
        purchaseDocId = docSnap.id;
      }
    });

    // Fallback to localStorage if not in Firestore
    if (!purchase) {
      const localPurchases = JSON.parse(localStorage.getItem('purchases')) || [];
      purchase = localPurchases.find(p => p.id === purchaseId);
    }

    if (!purchase) {
      resultDiv.className = 'verification-result error';
      resultDiv.innerHTML = `
        <div class="result-header error-header"><h3>❌ Invalid Purchase ID</h3></div>
        <p>No purchase found with ID: <strong>${purchaseId}</strong></p>
        <p class="help-text">Please check the ID and try again.</p>
        <button onclick="clearVerification()" class="btn-clear-result">Clear</button>`;
      return;
    }

    if (purchase.verified) {
      resultDiv.className = 'verification-result warning';
      resultDiv.innerHTML = `
        <div class="result-header warning-header"><h3>⚠️ Already Verified</h3></div>
        <p>This purchase was already verified on:</p>
        <p class="verified-date">${new Date(purchase.verifiedDate).toLocaleString()}</p>
        <div class="purchase-details">
          <p><strong>Purchase ID:</strong> ${purchase.id}</p>
          <p><strong>Total:</strong> ₦${purchase.total.toFixed(2)}</p>
          <p><strong>Items:</strong></p>
          <ul>${purchase.items.map(i => `<li>${i.quantity}x ${i.name} @ ₦${i.price}</li>`).join('')}</ul>
        </div>`;
      return;
    }

    // Mark as verified
    const verifiedDate = new Date().toISOString();
    purchase.verified     = true;
    purchase.verifiedDate = verifiedDate;

    if (purchaseDocId) {
      try {
        // Fix #2: doc() here now correctly refers to the Firestore function,
        // not the forEach loop variable (which is now named docSnap).
        const cashierEmail = (window.currentAdmin && window.currentAdmin.email) || '';
        const cashierName  = (window.cashierProfile && window.cashierProfile.name)
          ? window.cashierProfile.name : cashierEmail;
        await updateDoc(doc(db, "purchases", purchaseDocId), {
          verified:         true,
          verifiedDate:     verifiedDate,
          verifiedBy:       cashierEmail,
          verifiedByName:   cashierName
        });
      } catch (e) {
        console.error('Error updating Firestore:', e);
      }
    }

    // Also update localStorage
    const localPurchases = JSON.parse(localStorage.getItem('purchases')) || [];
    const localIdx = localPurchases.findIndex(p => p.id === purchaseId);
    if (localIdx !== -1) {
      localPurchases[localIdx].verified     = true;
      localPurchases[localIdx].verifiedDate = verifiedDate;
      localStorage.setItem('purchases', JSON.stringify(localPurchases));
    }

    // Remove verified entry from pending list display
    _allPending = _allPending.filter(p => p._docId !== purchaseDocId);
    renderPendingList();

    resultDiv.className = 'verification-result success';
    resultDiv.innerHTML = `
      <div class="result-header success-header"><h3>✅ Purchase Verified Successfully!</h3></div>
      <div class="purchase-details">
        <p><strong>Purchase ID:</strong> ${purchase.id}</p>
        <p><strong>Purchase Date:</strong> ${new Date(purchase.date).toLocaleString()}</p>
        <p><strong>Payment Reference:</strong> ${purchase.reference}</p>
        <p><strong>Total Amount:</strong> <span class="amount">₦${purchase.total.toFixed(2)}</span></p>
        <div class="items-purchased">
          <p><strong>Items Purchased:</strong></p>
          <ul class="purchased-items">
            ${purchase.items.map(item => `
              <li>
                <span class="item-qty">${item.quantity}x</span>
                <span class="item-name">${item.name}</span>
                <span class="item-price">₦${item.price.toFixed(2)}</span>
              </li>`).join('')}
          </ul>
        </div>
        <p style="margin-top:15px;padding:10px;background:#e7f3ff;border-radius:6px;font-size:14px;">
          <strong>✓ Verified from Firestore Database</strong><br>
          This purchase was verified across devices.
        </p>
        <button onclick="printReceipt('${purchase.id}')" class="btn-print">Print Receipt</button>
        <button onclick="clearVerification()" class="btn-clear-result">Clear</button>
      </div>`;

    document.getElementById('purchase-id-input').value = '';
    notify.success("Purchase verified successfully!", 3000);

  } catch (error) {
    console.error('Verification error:', error);
    resultDiv.className = 'verification-result error';
    resultDiv.innerHTML = `
      <div class="result-header error-header"><h3>❌ Verification Error</h3></div>
      <p>An error occurred while verifying the purchase:</p>
      <p style="color:#666;font-size:14px;">${error.message}</p>
      <p class="help-text">Please try again or contact support.</p>
      <button onclick="clearVerification()" class="btn-clear-result">Clear</button>`;
  }
}

window.clearVerification = function() {
  document.getElementById('verification-result').style.display = 'none';
};

// ── Print receipt ─────────────────────────────────────────────────────────────
window.printReceipt = async function(purchaseId) {
  let purchase = null;
  try {
    const querySnapshot = await getDocs(collection(db, "purchases"));
    querySnapshot.forEach((docSnap) => {
      if (docSnap.data().id === purchaseId) purchase = docSnap.data();
    });
  } catch (e) { console.error('Error loading from Firestore:', e); }

  if (!purchase) {
    const purchases = JSON.parse(localStorage.getItem('purchases')) || [];
    purchase = purchases.find(p => p.id === purchaseId);
  }
  if (!purchase) { notify.error("Purchase not found"); return; }

  const customerName  = purchase.customerName  || purchase.email || 'Unknown';
  const customerPhone = purchase.customerPhone || '—';
  const customerEmail = purchase.email         || '—';

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
      .section{margin:18px 0;}
      .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #eee;}
      .detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:14px;}
      .detail-row span:first-child{color:#555;}
      .detail-row span:last-child{font-weight:600;text-align:right;max-width:60%;}
      .method-pill{display:inline-block;background:#f5f5f5;padding:3px 12px;border-radius:20px;font-size:13px;font-weight:700;}
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
      ${purchase.verified ? '<div class="verified-badge">✓ VERIFIED</div>' : ''}
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
      <div class="detail-row"><span>Payment Ref</span><span style="font-family:monospace;font-size:12px;">${purchase.reference}</span></div>
      ${purchase.verified ? `<div class="detail-row"><span>Verified</span><span>${new Date(purchase.verifiedDate).toLocaleString()}</span></div>` : ''}
    </div>

    <div class="section">
      <div class="section-title">Items</div>
      <table class="items-table">
        <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead>
        <tbody>
          ${purchase.items.map(item => `
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
          <td style="font-weight:800;">₦${Number(purchase.total).toFixed(2)}</td>
        </tr>
      </table>
    </div>
    <div class="footer">
      <p>Thank you for shopping with ColEx!</p>
      <p style="margin-top:4px;">This receipt was generated at ${new Date().toLocaleString()}</p>
    </div>
    <script>window.onload=function(){window.print();}<\/script>
    </body></html>`);
  printWindow.document.close();
};

// ── Pending Purchases (shown in Verify tab) ───────────────────────────────────
let _allPending    = [];
let _pendingFilter = 'all';

let _pendingUnsubscribe = null;

window.loadPendingPurchases = function() {
  const listEl = document.getElementById('pending-list');
  if (!listEl) return;

  // If already listening, do nothing — listener stays active
  if (_pendingUnsubscribe) return;

  listEl.innerHTML = '<p class="dash-empty">Loading...</p>';

  _pendingUnsubscribe = onSnapshot(
    collection(db, 'purchases'),
    (snap) => {
      _allPending = [];
      snap.forEach(d => {
        const data = d.data();
        if (!data.verified) _allPending.push({ ...data, _docId: d.id });
      });
      _allPending.sort((a, b) => new Date(a.date) - new Date(b.date));
      renderPendingList();
    },
    (e) => {
      console.error('Error loading pending purchases:', e);
      if (listEl) listEl.innerHTML = '<p class="dash-empty">Could not load purchases. Please try again.</p>';
    }
  );
};

window.setPendingFilter = function(el) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  const datePick = document.getElementById('pending-date-pick');
  if (el.dataset.filter === 'pick') {
    _pendingFilter = el.value ? 'pick' : 'all';
  } else {
    el.classList.add('active');
    _pendingFilter = el.dataset.filter;
    if (datePick) datePick.value = '';
  }
  renderPendingList();
};

function renderPendingList() {
  const listEl     = document.getElementById('pending-list');
  const subtitleEl = document.getElementById('pending-subtitle');
  if (!listEl) return;

  const now        = new Date();
  const todayStr   = now.toDateString();
  const datePick   = document.getElementById('pending-date-pick');
  const pickedDate = datePick && datePick.value ? new Date(datePick.value + 'T00:00:00') : null;

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const filtered = _allPending.filter(p => {
    if (!p.date) return _pendingFilter === 'all';
    const d = new Date(p.date);
    switch (_pendingFilter) {
      case 'today': return d.toDateString() === todayStr;
      case 'week':  return d >= weekStart;
      case 'month': return d >= monthStart;
      case 'pick':  return pickedDate ? d.toDateString() === pickedDate.toDateString() : true;
      default:      return true;
    }
  });

  const filterLabel = {
    all:   'All pending',
    today: 'Today',
    week:  'This week',
    month: 'This month',
    pick:  pickedDate ? pickedDate.toLocaleDateString('en-NG', { day:'numeric', month:'short', year:'numeric' }) : 'All pending'
  }[_pendingFilter] || 'All pending';

  if (subtitleEl) {
    subtitleEl.textContent = filtered.length === 0
      ? `No pending purchases — ${filterLabel}`
      : `${filtered.length} purchase${filtered.length !== 1 ? 's' : ''} pending · ${filterLabel}`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="pending-empty"><span style="font-size:40px;">✅</span><p>No pending purchases for this period.</p></div>';
    return;
  }

  listEl.innerHTML = filtered.map(p => {
    const date         = p.date ? new Date(p.date).toLocaleString('en-NG', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const itemsText    = p.items ? p.items.map(i => `<span class="pend-item-pill">${i.quantity}× ${i.name}</span>`).join('') : '—';
    const customerName = p.customerName || p.email || 'Unknown customer';

    return `
    <div class="pending-card" id="pcard-${p._docId}">
      <div class="pend-top">
        <div class="pend-left">
          <div class="pend-customer">${customerName}</div>
          <div class="pend-date">${date}</div>
        </div>
        <div class="pend-right">
          <div class="pend-amount">₦${p.total ? p.total.toLocaleString('en-NG', { minimumFractionDigits:2 }) : '0.00'}</div>
        </div>
      </div>
      <div class="pend-items">${itemsText}</div>
    </div>`;
  }).join('');
}
