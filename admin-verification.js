// admin-verification.js — QR verification + pending purchases tab (store-aware)
import { getFirestore, collection, getDocs, onSnapshot, doc, updateDoc, query, where, limit } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { storeCol, storeDoc } from "./firebase-config.js";

const app = getApps().find(a => a.name === 'cardstorage') || getApps()[0];
const db  = getFirestore(app);

/* Security: escape HTML to prevent XSS when injecting purchase/item data */
function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Resolve store from cashier profile (injected by admin-auth-guard) or session
function getStoreId() {
    return (window.cashierStoreId) || sessionStorage.getItem('cashierStoreId') || 'store1';
}
function col(name) { return collection(db, storeCol(getStoreId(), name)); }
function docRef(name, id) { return doc(db, storeDoc(getStoreId(), name, id)); }

let html5QrCode  = null;
let scannerActive = false;

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
    () => {}
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

window.verifyPurchaseId = function() {
  const purchaseId = document.getElementById('purchase-id-input').value.trim();
  if (!purchaseId) { notify.warning("Please enter a purchase ID"); return; }
  verifyPurchase(purchaseId);
};

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
    // Use a targeted query instead of scanning the entire collection —
    // this costs 1 Firestore read regardless of collection size.
    const q = query(col('purchases'), where('id', '==', purchaseId), limit(1));
    const querySnapshot = await getDocs(q);
    let purchase = null, purchaseDocId = null;

    if (!querySnapshot.empty) {
      const docSnap = querySnapshot.docs[0];
      purchase = docSnap.data();
      purchaseDocId = docSnap.id;
    }

    if (!purchase) {
      resultDiv.className = 'verification-result error';
      resultDiv.innerHTML = `
        <div class="result-header error-header"><h3> Invalid Purchase ID</h3></div>
        <p>No purchase found with ID: <strong>${escapeHtml(purchaseId)}</strong></p>
        <p class="help-text">Please check the ID and try again.</p>
        <button onclick="clearVerification()" class="btn-clear-result">Clear</button>`;
      return;
    }

    if (purchase.verified) {
      resultDiv.className = 'verification-result warning';
      resultDiv.innerHTML = `
        <div class="result-header warning-header"><h3> Already Verified</h3></div>
        <p>This purchase was already verified on:</p>
        <p class="verified-date">${new Date(purchase.verifiedDate).toLocaleString()}</p>
        <div class="purchase-details">
          <p><strong>Purchase ID:</strong> ${escapeHtml(purchase.id)}</p>
          <p><strong>Total:</strong> ₦${purchase.total.toFixed(2)}</p>
          <p><strong>Items:</strong></p>
          <ul>${purchase.items.map(i => `<li>${escapeHtml(String(i.quantity))}x ${escapeHtml(i.name)} @ ₦${Number(i.price).toFixed(2)}</li>`).join('')}</ul>
        </div>`;
      return;
    }

    const verifiedDate = new Date().toISOString();
    purchase.verified     = true;
    purchase.verifiedDate = verifiedDate;

    if (purchaseDocId) {
      try {
        const cashierEmail = (window.currentAdmin && window.currentAdmin.email) || '';
        const cashierName  = (window.cashierProfile && window.cashierProfile.name) ? window.cashierProfile.name : cashierEmail;
        await updateDoc(docRef('purchases', purchaseDocId), {
          verified: true, verifiedDate, verifiedBy: cashierEmail, verifiedByName: cashierName
        });
      } catch (e) { console.error('Error updating Firestore:', e); }
    }

    _allPending = _allPending.filter(p => p._docId !== purchaseDocId);
    renderPendingList();

    resultDiv.className = 'verification-result success';
    resultDiv.innerHTML = `
      <div class="result-header success-header"><h3> Purchase Verified Successfully!</h3></div>
      <div class="purchase-details">
        <p><strong>Purchase ID:</strong> ${escapeHtml(purchase.id)}</p>
        <p><strong>Date:</strong> ${new Date(purchase.date).toLocaleString()}</p>
        <p><strong>Total Amount:</strong> <span class="amount">₦${purchase.total.toFixed(2)}</span></p>
        <div class="items-purchased">
          <p><strong>Items:</strong></p>
          <ul class="purchased-items">
            ${purchase.items.map(item => `
              <li><span class="item-qty">${escapeHtml(String(item.quantity))}x</span>
                <span class="item-name">${escapeHtml(item.name)}</span>
                <span class="item-price">₦${Number(item.price).toFixed(2)}</span></li>`).join('')}
          </ul>
        </div>
        <button onclick="printReceipt('${escapeHtml(purchase.id)}')" class="btn-print">Print Receipt</button>
        <button onclick="clearVerification()" class="btn-clear-result">Clear</button>
      </div>`;

    document.getElementById('purchase-id-input').value = '';
    notify.success("Purchase verified successfully!", 3000);

  } catch (error) {
    console.error('Verification error:', error);
    resultDiv.className = 'verification-result error';
    resultDiv.innerHTML = `
      <div class="result-header error-header"><h3> Verification Error</h3></div>
      <p>${error.message}</p>
      <button onclick="clearVerification()" class="btn-clear-result">Clear</button>`;
  }
}

window.clearVerification = function() {
  document.getElementById('verification-result').style.display = 'none';
};

window.printReceipt = async function(purchaseId) {
  let purchase = null;
  try {
    const q   = query(col('purchases'), where('id', '==', purchaseId), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) purchase = snap.docs[0].data();
  } catch (e) { console.error('Error loading from Firestore:', e); }
  if (!purchase) { notify.error('Purchase not found'); return; }

  const customerName  = escapeHtml(purchase.customerName  || purchase.email || 'Unknown');
  const customerPhone = escapeHtml(purchase.customerPhone || '\u2014');
  const customerEmail = escapeHtml(purchase.email         || '\u2014');

  const storeId    = getStoreId();
  const storeLabel = sessionStorage.getItem('storeLabel_' + storeId) || 'CGrocs';

  const dateStr = new Date(purchase.date).toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).toUpperCase();

  const items    = Array.isArray(purchase.items) ? purchase.items : [];
  const charge   = purchase.serviceCharge || 0;
  const subTotal = purchase.cartSubtotal  || (Number(purchase.total||0) - charge);

  const itemRows = items.map(i => {
    const price = Number(i.price)||0, qty = Number(i.quantity)||0;
    return `<tr><td>${escapeHtml(i.name)}</td><td style="text-align:center;">${qty}</td><td style="text-align:right;">\u20a6${price.toFixed(2)}</td><td style="text-align:right;">\u20a6${(price*qty).toFixed(2)}</td></tr>`;
  }).join('');

  const chargeRows = charge > 0 ? `
    <tr style="border-top:1px solid #e4e4e7;"><td colspan="3" style="text-align:right;color:#6b7280;">Subtotal</td><td style="text-align:right;color:#6b7280;">\u20a6${subTotal.toFixed(2)}</td></tr>
    <tr><td colspan="3" style="text-align:right;color:#6b7280;">Convenience Fee</td><td style="text-align:right;color:#6b7280;">\u20a6${charge.toFixed(2)}</td></tr>` : '';

  const verifiedRows = purchase.verified ? `
    <div class="info-row"><span class="info-label">Verified At</span><span class="info-value">${new Date(purchase.verifiedDate).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div>
    <div class="info-row"><span class="info-label">Verified By</span><span class="info-value">${escapeHtml(purchase.verifiedByName || purchase.verifiedBy || '\u2014')}</span></div>` : '';

  const printWindow = window.open('', '', 'width=800,height=900');
  printWindow.document.write(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>CGrocs Receipt \u2014 ${escapeHtml(purchase.id)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#111;padding:40px 48px;max-width:600px;margin:0 auto;}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #0a0a0a;}
.brand-name{font-size:26px;font-weight:800;letter-spacing:-0.5px;}.brand-store{font-size:13px;color:#6b7280;margin-top:4px;}
.receipt-label{text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;}.receipt-date{font-size:13px;color:#111;margin-top:4px;}
.section-head{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e7;}
.info-block{margin-bottom:24px;}
.info-row{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid #f4f4f5;font-size:14px;}
.info-row:last-child{border-bottom:none;}.info-label{color:#6b7280;}.info-value{font-weight:500;text-align:right;font-family:inherit;}
.info-value.mono{font-family:'Courier New',monospace;font-size:13px;}
.items-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;margin-bottom:10px;}
table{width:100%;border-collapse:collapse;font-size:14px;}
thead tr{background:#0a0a0a;color:#fff;}
thead th{padding:9px 12px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
thead th:first-child{text-align:left;border-radius:6px 0 0 6px;}thead th:last-child{text-align:right;border-radius:0 6px 6px 0;}
tbody tr td{padding:10px 12px;border-bottom:1px solid #e4e4e7;vertical-align:middle;}
tbody tr:last-child td{border-bottom:none;}
.total-row td{padding:12px;font-size:16px;font-weight:800;border-top:2px solid #0a0a0a!important;}
.footer{margin-top:32px;padding-top:18px;border-top:1px solid #e4e4e7;text-align:center;font-size:12px;color:#9ca3af;line-height:1.8;}
@media print{body{padding:20px;}@page{margin:12mm;size:A5 portrait;}}
</style></head><body>

<div class="header">
  <div><div class="brand-name">CGrocs</div><div class="brand-store">${escapeHtml(storeLabel)}</div></div>
  <div class="receipt-label">Purchase Receipt<div class="receipt-date">${dateStr}</div></div>
</div>

<div class="info-block">
  <div class="section-head">Customer</div>
  <div class="info-row"><span class="info-label">Name</span><span class="info-value">${customerName}</span></div>
  <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${customerPhone}</span></div>
  <div class="info-row"><span class="info-label">Email</span><span class="info-value">${customerEmail}</span></div>
</div>

<div class="info-block">
  <div class="section-head">Order Info</div>
  <div class="info-row"><span class="info-label">Purchase ID</span><span class="info-value mono">${escapeHtml(purchase.id)}</span></div>
  <div class="info-row"><span class="info-label">Date</span><span class="info-value">${new Date(purchase.date).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div>
  ${verifiedRows}
</div>

<div class="items-title">Items Purchased</div>
<table>
  <thead><tr><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Unit Price</th><th style="text-align:right;">Subtotal</th></tr></thead>
  <tbody>
    ${itemRows}${chargeRows}
    <tr class="total-row"><td colspan="3" style="text-align:right;">Total Paid</td><td style="text-align:right;">\u20a6${Number(purchase.total||0).toFixed(2)}</td></tr>
  </tbody>
</table>

<div class="footer">Thank you for shopping at CGrocs &middot; ${escapeHtml(storeLabel)}<br>Keep this receipt until your order is collected</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  printWindow.document.close();
};

//  Pending Purchases 
let _allPending    = [];
let _pendingFilter = 'all';
let _pendingUnsubscribe = null;

window.loadPendingPurchases = function() {
  const listEl = document.getElementById('pending-list');
  if (!listEl) return;
  if (_pendingUnsubscribe) return;
  listEl.innerHTML = '<p class="dash-empty">Loading...</p>';

  _pendingUnsubscribe = onSnapshot(
    col('purchases'),
    (snap) => {
      _allPending = [];
      snap.forEach(d => { const data = d.data(); if (!data.verified) _allPending.push({ ...data, _docId: d.id }); });
      _allPending.sort((a, b) => new Date(a.date) - new Date(b.date));
      renderPendingList();
    },
    (e) => {
      console.error('Error loading pending purchases:', e);
      if (listEl) listEl.innerHTML = '<p class="dash-empty">Could not load purchases.</p>';
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
  const weekStart  = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay()+6)%7)); weekStart.setHours(0,0,0,0);
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

  const filterLabel = { all:'All pending',today:'Today',week:'This week',month:'This month',
    pick: pickedDate ? pickedDate.toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'}) : 'All pending'
  }[_pendingFilter] || 'All pending';

  if (subtitleEl) {
    subtitleEl.textContent = filtered.length === 0
      ? `No pending purchases — ${filterLabel}`
      : `${filtered.length} purchase${filtered.length!==1?'s':''} pending · ${filterLabel}`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="pending-empty"><span style="font-size:40px;"></span><p>No pending purchases for this period.</p></div>';
    return;
  }

  listEl.innerHTML = filtered.map(p => {
    const date         = p.date ? new Date(p.date).toLocaleString('en-NG',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
    const itemsText    = p.items ? p.items.map(i => `<span class="pend-item-pill">${escapeHtml(String(i.quantity))}× ${escapeHtml(i.name)}</span>`).join('') : '—';
    const customerName = escapeHtml(p.customerName || p.email || 'Unknown customer');
    return `
    <div class="pending-card" id="pcard-${p._docId}">
      <div class="pend-top">
        <div class="pend-left">
          <div class="pend-customer">${customerName}</div>
          <div class="pend-date">${date}</div>
        </div>
        <div class="pend-right">
          <div class="pend-amount">₦${p.total ? p.total.toLocaleString('en-NG',{minimumFractionDigits:2}) : '0.00'}</div>
        </div>
      </div>
      <div class="pend-items">${itemsText}</div>
    </div>`;
  }).join('');
}
