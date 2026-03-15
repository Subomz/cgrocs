import { getFirestore, collection, addDoc, doc, getDoc, setDoc, deleteDoc, getDocs, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getActiveStore, storeCol, storeDoc, headAdminConfig } from "./firebase-config.js";
import { escapeHtml } from "./utils.js";

// Customer Firestore (purchases, reservations, products)
const app = getApps().find(a => a.name === 'cardstorage') || getApps()[0];
const db = getFirestore(app);

// Head-admin Firestore — read-only, used to fetch subaccount codes per store
const haApp = getApps().find(a => a.name === 'head-admin-guard')
  || initializeApp(headAdminConfig, 'head-admin-guard');
const haDb = getFirestore(haApp);

// Store-aware collection helpers
function _col(name)        { return collection(db, storeCol(getActiveStore(), name)); }
function _docRef(name, id) { return doc(db, storeDoc(getActiveStore(), name, id)); }

// 
// PAYSTACK CONFIG
//   BEFORE GOING LIVE: replace the test key below with your live public key.
//     Test key:  pk_test_...   → only works in test mode, no real charges
//     Live key:  pk_live_...   → real charges, must be kept secret on the server
//     Never commit your SECRET key (sk_...) here — this file is client-side.
// 
const PAYSTACK_PUBLIC_KEY = 'pk_live_e0c9caffa250105c691eb5a76f63adac7b07ca34'; // REPLACE WITH YOUR LIVE PUBLIC KEY

// Cart management system
let cart = [];
window._cart = cart; // expose for window.checkLogout()
// Tracks how many of each product index are currently in the cart.
// Used to update the displayed stock in real time without touching Firestore.
const reservedStock = {};  // { productIndex: quantity }

// Customer name/phone loaded before payment opens so the receipt is populated.
let _profileName  = '';
let _profilePhone = '';

// Tracks Firestore reservation doc IDs so we can delete them on cancel/remove
// Key: productIndex, Value: Firestore doc ID of the reservation
const firestoreReservations = {};

// Write a reservation to Firestore so other sessions see reduced available stock
async function createFirestoreReservation(productId, productName, quantity, productIndex) {
  if (!productId) return; // products without a Firestore ID can't be reserved
  try {
    const sessionId = getOrCreateSessionId();
    const docRef = await addDoc(_col('reservations'), {
      productId,
      productName,
      quantity,
      sessionId,
      createdAt: new Date().toISOString()
    });
    firestoreReservations[productIndex] = docRef.id;
  } catch (e) {
    console.warn('Could not create Firestore reservation:', e.message);
    // Non-fatal — browser-side reservedStock still prevents double-adding in this session
  }
}

// Update an existing reservation quantity
async function updateFirestoreReservation(productIndex, newQuantity) {
  const resDocId = firestoreReservations[productIndex];
  if (!resDocId) return;
  try {
    await updateDoc(_docRef('reservations', resDocId), { quantity: newQuantity });
  } catch (e) {
    console.warn('Could not update Firestore reservation:', e.message);
  }
}

// Delete a single reservation from Firestore
async function deleteFirestoreReservation(productIndex) {
  const resDocId = firestoreReservations[productIndex];
  if (!resDocId) return;
  try {
    await deleteDoc(_docRef('reservations', resDocId));
    delete firestoreReservations[productIndex];
  } catch (e) {
    console.warn('Could not delete Firestore reservation:', e.message);
  }
}

// Delete ALL reservations for this session (on cart clear / payment cancel / page unload)
async function deleteAllFirestoreReservations() {
  const deletions = Object.keys(firestoreReservations).map(idx => deleteFirestoreReservation(parseInt(idx)));
  await Promise.allSettled(deletions);
}

// Get or create a stable session ID for this browser tab
function getOrCreateSessionId() {
  let id = sessionStorage.getItem('cart_session_id');
  if (!id) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
    sessionStorage.setItem('cart_session_id', id);
  }
  return id;
}

// On page unload, clean up Firestore reservations so they don't block other customers
window.addEventListener('beforeunload', () => {
  deleteAllFirestoreReservations();
});

// Helper — get total Firestore-reserved quantity for a product (excluding this session)
async function getFirestoreReservedQty(productId) {
  if (!productId) return 0;
  try {
    const sessionId = getOrCreateSessionId();
    const snap = await getDocs(
      query(_col('reservations'),
        where('productId', '==', productId)
      )
    );
    let total = 0;
    snap.forEach(d => {
      const data = d.data();
      if (data.sessionId !== sessionId) total += (data.quantity || 0);
    });
    return total;
  } catch (e) {
    return 0; // fail open — don't block the user
  }
}

// Helper — update the stock label and buttons on a single product card
function updateStockDisplay(productIndex) {
  const products = getProducts();
  const product  = products[productIndex];
  if (!product) return;

  const reserved   = reservedStock[productIndex] || 0;
  const displayed  = product.stock - reserved;

  // Update the stock label text
  const card = document.querySelector(`#qty-${productIndex}`)?.closest('.card');
  if (!card) return;

  const stockLabel = card.querySelector('.stock-label');
  if (stockLabel) {
    stockLabel.textContent  = displayed > 0 ? `In Stock: ${displayed}` : 'Out of Stock';
    stockLabel.className    = `stock-label${displayed <= 0 ? ' out-of-stock' : ''}`;
  }

  // Update qty input max and +/- buttons
  const qtyInput = card.querySelector(`#qty-${productIndex}`);
  if (qtyInput) {
    qtyInput.max   = displayed;
    if (parseInt(qtyInput.value) > displayed) qtyInput.value = Math.max(displayed, 0);
  }

  // Update the add-to-cart button
  const buyBtn = card.querySelector('.btn-buy');
  if (buyBtn) {
    buyBtn.disabled    = displayed <= 0;
    buyBtn.textContent = displayed > 0 ? 'Add to Cart' : 'Sold Out';
  }

  // Update +/- buttons
  card.querySelectorAll('.qty-selector button').forEach(b => {
    b.disabled = displayed <= 0;
  });
}

// Restore all reserved stock to displayed (on cancel / clear)
function restoreAllReservedStock() {
  Object.keys(reservedStock).forEach(idx => {
    delete reservedStock[idx];
    updateStockDisplay(parseInt(idx));
  });
  // Clean up Firestore reservations so stock is released for other customers
  deleteAllFirestoreReservations();
}

function initCart() {
  updateCartDisplay();
}

function getProducts() {
  if (typeof window.products !== 'undefined' && Array.isArray(window.products) && window.products.length > 0) {
    return window.products;
  }
  
  try {
    const stored = localStorage.getItem('myProducts');
    if (stored && stored !== 'null') {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        window.products = parsed;
        return parsed;
      }
    }
  } catch (e) {
    console.error('Error loading products:', e);
  }
  
  return [{ name: "Sample Watch", stock: 20, price: 150, img: "https://placehold.co/300x200/f5f5f5/999?text=No+Image" }];
}

window.addToCart = async function(productIndex) {
  const products = getProducts();

  if (!products || products.length === 0) {
    notify.error("Products not loaded yet. Please refresh.");
    return;
  }

  const product = products[productIndex];
  if (!product) {
    notify.error("Product not found.");
    return;
  }

  const qtyInput = document.getElementById(`qty-${productIndex}`);
  const quantity = parseInt(qtyInput?.value || 1);

  // Check actual available stock = real stock - other sessions' Firestore reservations
  const otherReserved  = await getFirestoreReservedQty(product.id);
  const thisReserved   = reservedStock[productIndex] || 0;
  const actualAvailable = product.stock - otherReserved - thisReserved;

  if (quantity > actualAvailable) {
    if (actualAvailable <= 0) {
      notify.error(`Sorry, this item is fully reserved by other customers right now.`);
    } else {
      notify.warning(`Only ${actualAvailable} available (${otherReserved} reserved by others).`);
    }
    // Update the display to reflect real availability
    const displayStock = Math.max(0, product.stock - otherReserved - thisReserved);
    const stockLabel = document.querySelector(`#qty-${productIndex}`)?.closest('.card')?.querySelector('.stock-label');
    if (stockLabel) {
      stockLabel.textContent = displayStock > 0 ? `In Stock: ${displayStock}` : 'Out of Stock';
      stockLabel.className   = `stock-label${displayStock <= 0 ? ' out-of-stock' : ''}`;
    }
    return;
  }

  const existingItem = cart.find(item => item.name === product.name);

  if (existingItem) {
    const newQty = existingItem.quantity + quantity;
    if (newQty > product.stock) {
      notify.warning(`Cannot add more. Only ${product.stock} available.`);
      return;
    }
    existingItem.quantity = newQty;
  } else {
    cart.push({
      name: product.name,
      price: product.price,
      quantity: quantity,
      img: product.img,
      productIndex: productIndex
    });
  }

  // Reserve visually on product card
  reservedStock[productIndex] = (reservedStock[productIndex] || 0) + quantity;
  updateStockDisplay(productIndex);

  // Reserve in Firestore so other sessions see reduced available stock
  if (firestoreReservations[productIndex]) {
    // Already have a reservation doc — just update the quantity
    updateFirestoreReservation(productIndex, reservedStock[productIndex]);
  } else {
    createFirestoreReservation(product.id, product.name, quantity, productIndex);
  }

  updateCartDisplay();
  notify.success(`${quantity} x ${product.name} added to cart!`);
}

window.removeFromCart = function(cartIndex) {
  const item = cart[cartIndex];
  if (item) {
    const idx = item.productIndex;
    if (idx !== undefined) {
      reservedStock[idx] = Math.max(0, (reservedStock[idx] || 0) - item.quantity);
      updateStockDisplay(idx);
      // Remove or reduce Firestore reservation
      if (reservedStock[idx] <= 0) {
        deleteFirestoreReservation(idx);
      } else {
        updateFirestoreReservation(idx, reservedStock[idx]);
      }
    }
  }
  cart.splice(cartIndex, 1);
  updateCartDisplay();
}

window.toggleCart = function() {
  const cartPopup = document.getElementById('cart-popup');
  if (cartPopup) {
    cartPopup.classList.toggle('active');
  }
}

window.clearCart = function() {
  notify.confirm("Clear all items from cart?", () => {
    cart = [];
    restoreAllReservedStock();
    updateCartDisplay();
    notify.success("Cart cleared!");
  });
}

function generatePurchaseId() {
  // 6 chars from a 62-char alphabet (A-Z, a-z, 0-9).
  // 62^6 ~ 56 billion combinations — short enough to type, hard enough to guess.
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => CHARS[b % CHARS.length]).join('');
}

// Save purchase to Firestore — single source of truth.
// localStorage is NOT used as a fallback: a purchase that only exists in the
// customer's browser is invisible to the admin's verification system, meaning
// the cashier would have no record of it and the customer could not be served.
// If Firestore fails the error is surfaced to the customer so they can retry.
async function savePurchase(purchaseData) {
  try {
    const docRef = await addDoc(_col("purchases"), purchaseData);
    console.log("Purchase saved to Firestore:", docRef.id);
  } catch (e) {
    console.error("Firestore save failed:", e);
    notify.error(
      "Your payment went through but we could not save your order. " +
      "Please screenshot your Purchase ID and contact support.",
      10000
    );
  }
}

function showQRCodeModal(purchaseId, items, total, serviceCharge, cartSubtotal) {
  const modal = document.createElement('div');
  modal.className = 'qr-modal';
  modal.id = 'qr-modal';

  const storeId    = getActiveStore();
  const storeLabel = sessionStorage.getItem('storeLabel_' + storeId) || storeId;

  const itemsList = items.map(item =>
    `${item.quantity}x ${item.name} @ ₦${parseFloat(item.price).toFixed(2)}`
  ).join('<br>');

  modal.innerHTML = `
    <div class="qr-modal-content">
      <div class="qr-header">
        <h2>Purchase Successful!</h2>
        <button onclick="closeQRModal()" class="close-modal">×</button>
      </div>
      <div class="qr-body">
        <div class="purchase-info">
          <p><strong>Purchase ID:</strong></p>
          <p class="purchase-id">${purchaseId}</p>
          <p class="items-list">${itemsList}</p>
          <p class="total-amount"><strong>Total:</strong> ₦${total.toFixed(2)}</p>
        </div>
        <div class="qr-code-container">
          <div id="qrcode"></div>
          <p class="qr-instruction">Show this QR code or ID to the cashier for verification</p>
        </div>
        <div class="modal-actions">
          <button onclick="downloadReceiptPDF('${purchaseId}')" class="btn-download">Download Receipt</button>
          <button onclick="closeQRModal()" class="btn-done">Done</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Store receipt data on the modal so downloadReceiptPDF can read it
  modal._receiptData = { purchaseId, items, total, serviceCharge, cartSubtotal, storeLabel };

  setTimeout(() => {
    new QRCode(document.getElementById('qrcode'), {
      text:         purchaseId,
      width:        200,
      height:       200,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  }, 50);

  setTimeout(() => modal.classList.add('active'), 10);
}

window.closeQRModal = function() {
  const modal = document.getElementById('qr-modal');
  if (modal) {
    modal.classList.remove('active');
    setTimeout(() => modal.remove(), 300);
  }
};

window.downloadReceiptPDF = function(purchaseId) {
  const modal = document.getElementById('qr-modal');
  const data  = modal && modal._receiptData;
  if (!data) return;

  // Get QR code as a base64 image from the canvas QRCode.js rendered
  const qrCanvas = document.querySelector('#qrcode canvas');
  const qrDataUrl = qrCanvas ? qrCanvas.toDataURL('image/png') : '';

  const { items, total, serviceCharge, cartSubtotal, storeLabel } = data;
  const dateStr = new Date().toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  // Build item rows
  const itemRows = items.map(item => {
    const price    = parseFloat(item.price);
    const subtotal = price * item.quantity;
    return `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td style="text-align:center;">${item.quantity}</td>
        <td style="text-align:right;">₦${price.toFixed(2)}</td>
        <td style="text-align:right;">₦${subtotal.toFixed(2)}</td>
      </tr>`;
  }).join('');

  // Service charge rows — only shown when a split is active
  const chargeRows = (serviceCharge && serviceCharge > 0) ? `
      <tr style="border-top:1px solid #e4e4e7;">
        <td colspan="3" style="text-align:right;color:#6b7280;">Subtotal</td>
        <td style="text-align:right;color:#6b7280;">₦${(cartSubtotal || (total - serviceCharge)).toFixed(2)}</td>
      </tr>
      <tr>
        <td colspan="3" style="text-align:right;color:#6b7280;">Service Charge</td>
        <td style="text-align:right;color:#6b7280;">₦${serviceCharge.toFixed(2)}</td>
      </tr>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ColEx Receipt — ${purchaseId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #fff;
      color: #111;
      padding: 40px 48px;
      max-width: 600px;
      margin: 0 auto;
    }

    /* ── Header ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 2px solid #0a0a0a;
    }
    .brand-name  { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .brand-store { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .receipt-label {
      text-align: right;
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #6b7280;
    }
    .receipt-date { font-size: 13px; color: #111; margin-top: 4px; }

    /* ── QR + ID section ── */
    .qr-section {
      display: flex;
      align-items: center;
      gap: 24px;
      background: #f4f4f5;
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 28px;
    }
    .qr-section img { width: 110px; height: 110px; flex-shrink: 0; }
    .qr-text-block { flex: 1; }
    .qr-id-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; margin-bottom: 6px; }
    .qr-id {
      font-family: 'Courier New', monospace;
      font-size: 17px; font-weight: 700;
      color: #0a0a0a;
      word-break: break-all;
      line-height: 1.4;
    }
    .qr-hint { font-size: 11px; color: #9ca3af; margin-top: 8px; }

    /* ── Items table ── */
    .section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .07em; color: #6b7280;
      margin-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 14px;
    }
    thead tr {
      background: #0a0a0a; color: #fff;
    }
    thead th {
      padding: 9px 12px;
      font-weight: 700;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    thead th:first-child  { text-align: left; border-radius: 6px 0 0 6px; }
    thead th:last-child   { text-align: right; border-radius: 0 6px 6px 0; }
    tbody tr td {
      padding: 10px 12px;
      border-bottom: 1px solid #e4e4e7;
      vertical-align: middle;
    }
    tbody tr:last-child td { border-bottom: none; }

    /* ── Total row ── */
    .total-row td {
      padding: 12px 12px;
      font-size: 16px; font-weight: 800;
      border-top: 2px solid #0a0a0a !important;
    }

    /* ── Footer ── */
    .footer {
      margin-top: 32px;
      padding-top: 18px;
      border-top: 1px solid #e4e4e7;
      text-align: center;
      font-size: 12px;
      color: #9ca3af;
      line-height: 1.8;
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
      <div class="brand-name">ColEx</div>
      <div class="brand-store">${storeLabel}</div>
    </div>
    <div class="receipt-label">
      Payment Receipt
      <div class="receipt-date">${dateStr}</div>
    </div>
  </div>

  <!-- QR Code + Purchase ID -->
  <div class="qr-section">
    ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR Code">` : ''}
    <div class="qr-text-block">
      <div class="qr-id-label">Purchase ID</div>
      <div class="qr-id">${purchaseId}</div>
      <div class="qr-hint">Show this to the cashier to collect your order</div>
    </div>
  </div>

  <!-- Items -->
  <div class="section-title">Items Purchased</div>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      ${chargeRows}
      <tr class="total-row">
        <td colspan="3" style="text-align:right;">Total Paid</td>
        <td style="text-align:right;">₦${total.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Footer -->
  <div class="footer">
    Thank you for shopping at ColEx · ${storeLabel}<br>
    Keep this receipt until your order is collected
  </div>

</body>
</html>`;

  // Open a new window, write the receipt HTML, then trigger print → Save as PDF
  const win = window.open('', '_blank', 'width=700,height=900');
  if (!win) {
    notify.error('Please allow pop-ups to download the receipt.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  // Small delay so images (QR) fully load before print dialog opens
  win.onload = function() { win.print(); };
  // Fallback if onload already fired
  setTimeout(() => { try { win.print(); } catch(e) {} }, 600);
};

// ---------------------------------------------------------------------------
// Paystack callback & onClose MUST live on window (global scope).
//
// Paystack's inline.js validates callbacks with:  !(fn instanceof Function)
// That check fails for functions created inside an ES module, because module
// code runs in a separate realm/context.  Assigning to window puts them in
// the same global scope Paystack expects, so instanceof passes.
// ---------------------------------------------------------------------------

// Temporary storage so the global callbacks can reach the closure data
let _paystackPayload = null;

window._paystackCallback = function(response) {
  // Pull the frozen payload that proceedToPayment stored
  const payload = _paystackPayload;
  if (!payload) {
    console.error("Paystack callback fired but no payload found");
    return;
  }
  _paystackPayload = null; // consume it

  // Destructure ALL fields from payload BEFORE nulling it
  const { purchaseId, cartSnapshot, total, serviceCharge, cartSubtotal } = payload;

  console.log('Payment successful:', response.reference);

  const products = getProducts();

  // Deduct stock and persist to Firestore
  for (const item of cartSnapshot) {
    const product = products[item.productIndex];
    if (product) {
      product.stock -= item.quantity;

      if (product.id && typeof window.updateProductInFirestore === 'function') {
        try {
          window.updateProductInFirestore(product.id, {
            name: product.name,
            price: product.price,
            stock: product.stock,
            img: product.img
          });
        } catch (e) {
          console.error("Error updating stock in Firestore:", e);
        }
      }
    }
  }

  // Persist updated products locally using store-aware key
  const activeStore = getActiveStore();
  localStorage.setItem(`myProducts_${activeStore}`, JSON.stringify(products));
  window.products = products;

  // Use values already destructured from payload above
  const purchaseData = {
    id:        purchaseId,
    items:     cartSnapshot.map(item => ({
      name:     item.name,
      quantity: item.quantity,
      price:    item.price
    })),
    total:     total,
    date:      new Date().toISOString(),
    reference: response.reference,
    verified:  false,
    storeId:   getActiveStore(),
    uid:       (window.currentUser && window.currentUser.uid)   || '',
    email:     (window.currentUser && window.currentUser.email) || '',
    customerName:  _profileName  || '',
    customerPhone: _profilePhone || ''
  };

  // Payment complete — clear browser reservations and Firestore reservations
  // (stock permanently deducted via updateProductInFirestore above)
  deleteAllFirestoreReservations();
  Object.keys(reservedStock).forEach(k => delete reservedStock[k]);

  savePurchase(purchaseData);

  // Re-render product cards with updated stock
  if (typeof window.loadProducts === 'function') {
    window.loadProducts().then(function(updated) {
      window.products = updated;
      if (typeof window.renderCardsCustomer === 'function') {
        window.renderCardsCustomer();
      }
    }).catch(function(e) {
      console.error("Error reloading products:", e);
    });
  }

  // Show QR modal (uses the frozen snapshot, not the now-empty live cart)
  showQRCodeModal(purchaseId, cartSnapshot, total, serviceCharge, cartSubtotal);

  // Clear the live cart
  cart = [];
  updateCartDisplay();

  // Close the cart sidebar
  var cartPopup = document.getElementById('cart-popup');
  if (cartPopup) cartPopup.classList.remove('active');
};

window._paystackOnClose = function() {
  notify.info('Payment window closed.');
  // Payment was abandoned — restore the reserved stock display
  restoreAllReservedStock();
};



// ─────────────────────────────────────────────────────────────────────────────
//  PAYSTACK SPLIT — subaccount codes per store
//
//  Service charge tiers (added ON TOP of cart total — customer pays):
//    Cart total < ₦1,000   →  ₦50  surcharge
//    Cart total < ₦10,000  →  ₦100 surcharge
//    Cart total ≥ ₦10,000  →  ₦150 surcharge
//
//  Paystack config:
//    amount:             (cart total + surcharge) × 100 kobo  — what customer pays
//    subaccount:         store's subaccount_code              — store receives cart total
//    transaction_charge: surcharge × 100 kobo                — primary account receives surcharge
//    bearer:             "account"                           — primary account bears Paystack fees
//
//  If no subaccount is configured the surcharge is still added to the customer's
//  total (it all settles to the primary Paystack account).
// ─────────────────────────────────────────────────────────────────────────────

// Cache subaccount codes for the session so we don't re-fetch on every payment
const _subaccountCache = {};

async function getStoreSubaccountCode(storeId) {
  if (_subaccountCache[storeId]) return _subaccountCache[storeId];
  try {
    const snap = await getDoc(doc(haDb, 'transferSettings', 'stores'));
    if (snap.exists()) {
      const data = snap.data();
      Object.keys(data).forEach(id => {
        if (data[id]?.subaccount_code) _subaccountCache[id] = data[id].subaccount_code;
      });
    }
  } catch (e) {
    console.warn('Could not fetch subaccount code:', e.message);
  }
  return _subaccountCache[storeId] || null;
}

// Returns the service charge (in naira) to add on top of the cart total
function getServiceCharge(cartTotal) {
  if (cartTotal < 1000)  return 50;
  if (cartTotal < 10000) return 100;
  return 150;
}

//  Proceed to payment 
window.proceedToPayment = async function() {
  if (cart.length === 0) {
    notify.warning("Your cart is empty!");
    return;
  }

  if (typeof PaystackPop === 'undefined') {
    notify.error("Payment system not loaded. Please refresh the page.");
    return;
  }

  var userEmail = (window.currentUser && window.currentUser.email)
    ? window.currentUser.email
    : null;

  if (!userEmail) {
    notify.error("You must be logged in to make a payment.");
    return;
  }

  // Await profile load so name/phone are ready before Paystack callback fires
  _profileName  = '';
  _profilePhone = '';
  if (window.currentUser && window.currentUser.uid) {
    try {
      var snap = await getDoc(doc(db, 'users', window.currentUser.uid));
      if (snap.exists()) {
        var u = snap.data();
        _profileName  = u.fullName || ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
        _profilePhone = u.phone || '';
      }
    } catch(e) { console.warn('Could not load profile for receipt:', e.message); }
  }

  var cartTotal      = calculateTotal();
  var serviceCharge  = getServiceCharge(cartTotal);
  var grandTotal     = cartTotal + serviceCharge;   // what the customer actually pays
  var purchaseId     = generatePurchaseId();
  var paystackRef    = purchaseId.replace(/-/g, '');
  var cartSnapshot   = cart.map(function(item) { return Object.assign({}, item); });

  // Fetch this store's Paystack subaccount code for the split
  var activeStore    = getActiveStore();
  var subaccountCode = await getStoreSubaccountCode(activeStore);

  // Store grandTotal (items + surcharge) so receipts reflect what was paid
  _paystackPayload = {
    purchaseId:    purchaseId,
    cartSnapshot:  cartSnapshot,
    total:         grandTotal,
    serviceCharge: serviceCharge,
    cartSubtotal:  cartTotal
  };

  // Build Paystack config
  var paystackConfig = {
    key:      PAYSTACK_PUBLIC_KEY,
    email:    userEmail,
    amount:   Math.round(grandTotal * 100),   // customer pays cartTotal + surcharge
    currency: 'NGN',
    ref:      paystackRef,
    metadata: {
      custom_fields: [
        { display_name: 'Purchase ID',     variable_name: 'purchase_id',     value: purchaseId },
        { display_name: 'Store',           variable_name: 'store_id',        value: activeStore },
        { display_name: 'Service Charge',  variable_name: 'service_charge',  value: '₦' + serviceCharge }
      ]
    },
    callback: window._paystackCallback,
    onClose:  window._paystackOnClose
  };

  if (subaccountCode) {
    // Surcharge (in kobo) settles to the primary linked Paystack account
    // Store subaccount receives the cart subtotal
    // bearer: 'account' — primary account bears Paystack's own transaction fee
    paystackConfig.subaccount         = subaccountCode;
    paystackConfig.transaction_charge = Math.round(serviceCharge * 100);
    paystackConfig.bearer             = 'account';
  }

  var handler = PaystackPop.setup(paystackConfig);
  handler.openIframe();
}

function calculateTotal() {
  return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

window.changeCartQty = function(cartIndex, delta) {
  const item = cart[cartIndex];
  if (!item) return;
  const products    = typeof window.products !== 'undefined' ? window.products : [];
  const product     = products.find(p => p.name === item.name);
  const maxStock    = product ? product.stock : Infinity;
  const newQty      = item.quantity + delta;
  if (newQty < 1) { window.removeFromCart(cartIndex); return; }
  if (newQty > maxStock) { notify.warning(`Only ${maxStock} available.`); return; }
  item.quantity = newQty;
  // Update reserved stock display and Firestore reservation
  const productIndex = product ? products.indexOf(product) : -1;
  if (productIndex !== -1) {
    reservedStock[productIndex] = (reservedStock[productIndex] || 0) + delta;
    updateStockDisplay(productIndex);
    if (reservedStock[productIndex] > 0) {
      updateFirestoreReservation(productIndex, reservedStock[productIndex]);
    }
  }
  updateCartDisplay();
};

function updateCartDisplay() {
  window._cart = cart;
  const cartCount = document.getElementById('cart-count');
  const cartItems = document.getElementById('cart-items');
  const cartTotal = document.getElementById('cart-total');
  const cartTrigger = document.querySelector('.cart-trigger');
  const payBtn = document.querySelector('.btn-pay');

  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  if (cartCount) {
    cartCount.textContent = totalItems;
    cartCount.classList.toggle('empty', totalItems === 0);
  }
  if (cartTrigger) {
    cartTrigger.classList.toggle('cart-empty', totalItems === 0);
    cartTrigger.title = totalItems === 0 ? 'Cart is empty' : '';
  }
  if (payBtn) {
    payBtn.disabled = totalItems === 0;
  }

  let grandTotal = 0;

  if (cartItems) {
    if (cart.length === 0) {
      cartItems.innerHTML = '<p style="text-align:center; padding: 20px;">Your cart is empty.</p>';
      if (cartTotal) {
        cartTotal.innerHTML = "₦0.00";
      }
      return;
    } else {
      cartItems.innerHTML = cart.map((item, index) => {
        const priceNum = parseFloat(item.price);
        const subtotal = priceNum * item.quantity;
        grandTotal += subtotal;
        return `
        <div class="cart-item">
          <div class="cart-item-info" style="flex:1;">
            <strong>${escapeHtml(item.name)}</strong>
            <div class="cart-item-qty">
              <button class="cart-qty-btn" onclick="changeCartQty(${index}, -1)">−</button>
              <span class="cart-qty-num">${item.quantity}</span>
              <button class="cart-qty-btn" onclick="changeCartQty(${index}, 1)">+</button>
              <span style="font-size:12px;color:#9ca3af;">× ₦${priceNum.toFixed(2)}</span>
            </div>
          </div>
          <div class="cart-item-price" style="flex-direction:column;align-items:flex-end;gap:4px;">
            <span>₦${subtotal.toFixed(2)}</span>
            <button class="btn-remove-small" onclick="removeFromCart(${index})">Remove</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  if (cartTotal) {
    const charge = cart.length > 0 ? getServiceCharge(grandTotal) : 0;
    const displayTotal = grandTotal + charge;
    cartTotal.innerHTML = charge > 0
      ? `<span style="font-size:13px;color:var(--muted);display:block;margin-bottom:2px;">Subtotal: ₦${grandTotal.toFixed(2)}</span>` +
        `<span style="font-size:13px;color:var(--muted);display:block;margin-bottom:4px;">Service charge: ₦${charge.toFixed(2)}</span>` +
        `₦${displayTotal.toFixed(2)}`
      : `₦${grandTotal.toFixed(2)}`;
  }
}

const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(400px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(400px); opacity: 0; }
  }
`;
document.head.appendChild(style);

initCart();
