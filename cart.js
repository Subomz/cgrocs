import { getFirestore, collection, addDoc, doc, getDoc, setDoc, deleteDoc, getDocs, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getActiveStore, storeCol, storeDoc, headAdminConfig, PAYSTACK_PUBLIC_KEY } from "./firebase-config.js";
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

// Cart management system
let cart = [];
window._cart = cart; // expose for window.checkLogout()
// Tracks how many of each product index are currently in the cart.
const reservedStock = {};  // { productIndex: quantity }

// Customer name/phone loaded before payment opens so the receipt is populated.
let _profileName  = '';
let _profilePhone = '';

// Tracks Firestore reservation doc IDs so we can delete them on cancel/remove
const firestoreReservations = {};

// Write a reservation to Firestore so other sessions see reduced available stock
async function createFirestoreReservation(productId, productName, quantity, productIndex) {
  if (!productId) return;
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
  }
}

async function updateFirestoreReservation(productIndex, newQuantity) {
  const resDocId = firestoreReservations[productIndex];
  if (!resDocId) return;
  try {
    await updateDoc(_docRef('reservations', resDocId), { quantity: newQuantity });
  } catch (e) {
    console.warn('Could not update Firestore reservation:', e.message);
  }
}

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

async function deleteAllFirestoreReservations() {
  const deletions = Object.keys(firestoreReservations).map(idx => deleteFirestoreReservation(parseInt(idx)));
  await Promise.allSettled(deletions);
}

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

window.addEventListener('beforeunload', () => {
  deleteAllFirestoreReservations();
});

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
    return 0;
  }
}

function updateStockDisplay(productIndex) {
  const products = getProducts();
  const product  = products[productIndex];
  if (!product) return;

  const reserved   = reservedStock[productIndex] || 0;
  const displayed  = product.stock - reserved;

  const card = document.querySelector(`#qty-${productIndex}`)?.closest('.card');
  if (!card) return;

  const stockLabel = card.querySelector('.stock-label');
  if (stockLabel) {
    stockLabel.textContent  = displayed > 0 ? `In Stock: ${displayed}` : 'Out of Stock';
    stockLabel.className    = `stock-label${displayed <= 0 ? ' out-of-stock' : ''}`;
  }

  const qtyInput = card.querySelector(`#qty-${productIndex}`);
  if (qtyInput) {
    qtyInput.max   = displayed;
    if (parseInt(qtyInput.value) > displayed) qtyInput.value = Math.max(displayed, 0);
  }

  const buyBtn = card.querySelector('.btn-buy');
  if (buyBtn) {
    buyBtn.disabled    = displayed <= 0;
    buyBtn.textContent = displayed > 0 ? 'Add to Cart' : 'Sold Out';
  }

  card.querySelectorAll('.qty-selector button').forEach(b => {
    b.disabled = displayed <= 0;
  });
}

function restoreAllReservedStock() {
  Object.keys(reservedStock).forEach(idx => {
    delete reservedStock[idx];
    updateStockDisplay(parseInt(idx));
  });
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

  const otherReserved  = await getFirestoreReservedQty(product.id);
  const thisReserved   = reservedStock[productIndex] || 0;
  const actualAvailable = product.stock - otherReserved - thisReserved;

  if (quantity > actualAvailable) {
    if (actualAvailable <= 0) {
      notify.error(`Sorry, this item is fully reserved by other customers right now.`);
    } else {
      notify.warning(`Only ${actualAvailable} available (${otherReserved} reserved by others).`);
    }
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

  reservedStock[productIndex] = (reservedStock[productIndex] || 0) + quantity;
  updateStockDisplay(productIndex);

  if (firestoreReservations[productIndex]) {
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
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => CHARS[b % CHARS.length]).join('');
}

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

  const qrCanvas = document.querySelector('#qrcode canvas');
  const qrDataUrl = qrCanvas ? qrCanvas.toDataURL('image/png') : '';

  const { items, total, serviceCharge, cartSubtotal, storeLabel } = data;
  const dateStr = new Date().toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

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
  <title>CGrocs Receipt — ${purchaseId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #fff; color: #111; padding: 40px 48px; max-width: 600px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 2px solid #0a0a0a; }
    .brand-name { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .brand-store { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .receipt-label { text-align: right; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; }
    .receipt-date { font-size: 13px; color: #111; margin-top: 4px; }
    .qr-section { display: flex; align-items: center; gap: 24px; background: #f4f4f5; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px; }
    .qr-section img { width: 110px; height: 110px; flex-shrink: 0; }
    .qr-id-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; margin-bottom: 6px; }
    .qr-id { font-family: 'Courier New', monospace; font-size: 17px; font-weight: 700; color: #0a0a0a; word-break: break-all; line-height: 1.4; }
    .qr-hint { font-size: 11px; color: #9ca3af; margin-top: 8px; }
    .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px; }
    thead tr { background: #0a0a0a; color: #fff; }
    thead th { padding: 9px 12px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    thead th:first-child { text-align: left; border-radius: 6px 0 0 6px; }
    thead th:last-child  { text-align: right; border-radius: 0 6px 6px 0; }
    tbody tr td { padding: 10px 12px; border-bottom: 1px solid #e4e4e7; vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    .total-row td { padding: 12px 12px; font-size: 16px; font-weight: 800; border-top: 2px solid #0a0a0a !important; }
    .footer { margin-top: 32px; padding-top: 18px; border-top: 1px solid #e4e4e7; text-align: center; font-size: 12px; color: #9ca3af; line-height: 1.8; }
    @media print { body { padding: 20px; } @page { margin: 12mm; size: A5 portrait; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand-name">CGrocs</div>
      <div class="brand-store">${storeLabel}</div>
    </div>
    <div class="receipt-label">
      Payment Receipt
      <div class="receipt-date">${dateStr}</div>
    </div>
  </div>
  <div class="qr-section">
    ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR Code">` : ''}
    <div>
      <div class="qr-id-label">Purchase ID</div>
      <div class="qr-id">${purchaseId}</div>
      <div class="qr-hint">Show this to the cashier to collect your order</div>
    </div>
  </div>
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
  <div class="footer">
    Thank you for shopping at CGrocs · ${storeLabel}<br>
    Keep this receipt until your order is collected
  </div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=700,height=900');
  if (!win) {
    notify.error('Please allow pop-ups to download the receipt.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.onload = function() { win.print(); };
  setTimeout(() => { try { win.print(); } catch(e) {} }, 600);
};

// ---------------------------------------------------------------------------
// Paystack global callbacks (must be on window — see original comment above)
// ---------------------------------------------------------------------------

let _paystackPayload = null;

window._paystackCallback = function(response) {
  const payload = _paystackPayload;
  if (!payload) {
    console.error("Paystack callback fired but no payload found");
    return;
  }
  _paystackPayload = null;

  const { purchaseId, cartSnapshot, total, serviceCharge, cartSubtotal } = payload;

  console.log('Payment successful:', response.reference);

  const products = getProducts();

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

  const activeStore = getActiveStore();
  localStorage.setItem(`myProducts_${activeStore}`, JSON.stringify(products));
  window.products = products;

  const purchaseData = {
    id:        purchaseId,
    items:     cartSnapshot.map(item => ({
      name:     item.name,
      quantity: item.quantity,
      price:    item.price
    })),
    total,
    cartSubtotal,
    serviceCharge,
    date:      new Date().toISOString(),
    reference: response.reference,
    verified:  false,
    storeId:   getActiveStore(),
    uid:       (window.currentUser && window.currentUser.uid)   || '',
    email:     (window.currentUser && window.currentUser.email) || '',
    customerName:  _profileName  || '',
    customerPhone: _profilePhone || '',
    paymentMethod: 'paystack'
  };

  deleteAllFirestoreReservations();
  Object.keys(reservedStock).forEach(k => delete reservedStock[k]);

  savePurchase(purchaseData);

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

  showQRCodeModal(purchaseId, cartSnapshot, total, serviceCharge, cartSubtotal);

  cart = [];
  updateCartDisplay();

  var cartPopup = document.getElementById('cart-popup');
  if (cartPopup) cartPopup.classList.remove('active');
};

window._paystackOnClose = function() {
  notify.info('Payment window closed.');
  restoreAllReservedStock();
};

// ── Paystack split config ─────────────────────────────────────────────────────

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

function getServiceCharge(cartTotal) {
  if (cartTotal < 1000)  return 50;
  if (cartTotal < 10000) return 100;
  return 150;
}

// ── Paystack payment ──────────────────────────────────────────────────────────

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
  var grandTotal     = cartTotal + serviceCharge;
  var purchaseId     = generatePurchaseId();
  var paystackRef    = purchaseId.replace(/-/g, '');
  var cartSnapshot   = cart.map(function(item) { return Object.assign({}, item); });

  var activeStore    = getActiveStore();
  var subaccountCode = await getStoreSubaccountCode(activeStore);

  _paystackPayload = {
    purchaseId,
    cartSnapshot,
    total:         grandTotal,
    serviceCharge,
    cartSubtotal:  cartTotal
  };

  var paystackConfig = {
    key:      PAYSTACK_PUBLIC_KEY,
    email:    userEmail,
    amount:   Math.round(grandTotal * 100),
    currency: 'NGN',
    ref:      paystackRef,
    metadata: {
      custom_fields: [
        { display_name: 'Purchase ID',    variable_name: 'purchase_id',    value: purchaseId },
        { display_name: 'Store',          variable_name: 'store_id',       value: activeStore },
        { display_name: 'Service Charge', variable_name: 'service_charge', value: '₦' + serviceCharge }
      ]
    },
    callback: window._paystackCallback,
    onClose:  window._paystackOnClose
  };

  if (subaccountCode) {
    paystackConfig.subaccount         = subaccountCode;
    paystackConfig.transaction_charge = Math.round(serviceCharge * 100);
    paystackConfig.bearer             = 'account';
  }

  var handler = PaystackPop.setup(paystackConfig);
  handler.openIframe();
}

// ── Wallet payment ────────────────────────────────────────────────────────────

/**
 * Pay for the current cart using the customer's wallet balance.
 * No service charge is applied to wallet payments.
 * The server (wallet-pay.js function) atomically deducts the balance
 * and creates the purchase record. The client then deducts stock and
 * shows the QR modal, mirroring the Paystack callback flow.
 */
window.payWithWallet = async function() {
  if (cart.length === 0) {
    notify.warning("Your cart is empty!");
    return;
  }

  const uid   = window.currentUser?.uid;
  const email = window.currentUser?.email;
  if (!uid) {
    notify.error("You must be logged in to pay with your wallet.");
    return;
  }

  const cartTotal = calculateTotal();
  const balance   = window.walletBalance || 0;

  if (balance < cartTotal) {
    const shortfall = cartTotal - balance;
    const topupMsg  = `You need ₦${shortfall.toLocaleString('en-NG', { minimumFractionDigits: 2 })} more.`;
    notify.warning(`Insufficient wallet balance. ${topupMsg}`);
    return;
  }

  // Load profile for receipt (same as Paystack flow)
  _profileName  = '';
  _profilePhone = '';
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      const u   = snap.data();
      _profileName  = u.fullName || ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
      _profilePhone = u.phone || '';
    }
  } catch(e) { console.warn('Could not load profile for wallet receipt:', e.message); }

  const purchaseId   = generatePurchaseId();
  const cartSnapshot = cart.map(item => ({ ...item }));
  const activeStore  = getActiveStore();

  // Disable wallet pay button while processing
  const walletBtn = document.querySelector('.btn-wallet-pay');
  if (walletBtn) { walletBtn.disabled = true; walletBtn.textContent = 'Processing…'; }

  try {
    const res = await fetch('/api/wallet-pay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        uid,
        storeId:       activeStore,
        purchaseId,
        items:         cartSnapshot.map(i => ({ name: i.name, quantity: i.quantity, price: i.price })),
        total:         cartTotal,   // no service charge for wallet payments
        email:         email   || '',
        customerName:  _profileName  || '',
        customerPhone: _profilePhone || ''
      })
    });

    const data = await res.json();

    if (!data.success) {
      const msg = data.error === 'Insufficient wallet balance'
        ? 'Your wallet balance has changed. Please refresh and try again.'
        : (data.error || 'Payment failed. Please try again.');
      notify.error(msg, 7000);
      if (walletBtn) { walletBtn.disabled = false; walletBtn.textContent = 'Pay with Wallet'; }
      return;
    }

    // Update cached balance
    window.walletBalance = data.newBalance;
    // Update any balance displays on the page
    document.querySelectorAll('[data-wallet-balance]').forEach(el => {
      el.textContent = '₦' + data.newBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 });
    });
    const navBal = document.getElementById('wallet-nav-balance');
    if (navBal) navBal.textContent = '₦' + data.newBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 });

    // Deduct product stock (same as Paystack callback)
    const products = getProducts();
    for (const item of cartSnapshot) {
      const product = products[item.productIndex];
      if (product) {
        product.stock -= item.quantity;
        if (product.id && typeof window.updateProductInFirestore === 'function') {
          window.updateProductInFirestore(product.id, {
            name: product.name, price: product.price,
            stock: product.stock, img: product.img
          });
        }
      }
    }
    localStorage.setItem(`myProducts_${activeStore}`, JSON.stringify(products));
    window.products = products;

    // Clear reservations
    deleteAllFirestoreReservations();
    Object.keys(reservedStock).forEach(k => delete reservedStock[k]);

    // Reload product cards
    if (typeof window.loadProducts === 'function') {
      window.loadProducts().then(updated => {
        window.products = updated;
        if (typeof window.renderCardsCustomer === 'function') window.renderCardsCustomer();
      }).catch(e => console.error('Error reloading products:', e));
    }

    // Show QR modal (no service charge on wallet payments)
    showQRCodeModal(purchaseId, cartSnapshot, cartTotal, 0, cartTotal);

    // Clear cart
    cart = [];
    updateCartDisplay();
    const cartPopup = document.getElementById('cart-popup');
    if (cartPopup) cartPopup.classList.remove('active');

    notify.success('Payment successful!', 4000);

  } catch (err) {
    console.error('Wallet pay error:', err);
    notify.error('Payment failed. Please check your connection and try again.', 7000);
    if (walletBtn) { walletBtn.disabled = false; walletBtn.textContent = 'Pay with Wallet'; }
  }
};

// ─────────────────────────────────────────────────────────────────────────────

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
  const cartCount   = document.getElementById('cart-count');
  const cartItems   = document.getElementById('cart-items');
  const cartTotal   = document.getElementById('cart-total');
  const cartTrigger = document.querySelector('.cart-trigger');
  const payBtn      = document.querySelector('.btn-pay');

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
      if (cartTotal) cartTotal.innerHTML = "₦0.00";
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
    const charge       = cart.length > 0 ? getServiceCharge(grandTotal) : 0;
    const displayTotal = grandTotal + charge;
    cartTotal.innerHTML = charge > 0
      ? `<span style="font-size:13px;color:var(--muted);display:block;margin-bottom:2px;">Subtotal: ₦${grandTotal.toFixed(2)}</span>` +
        `<span style="font-size:13px;color:var(--muted);display:block;margin-bottom:4px;">Service charge: ₦${charge.toFixed(2)}</span>` +
        `₦${displayTotal.toFixed(2)}`
      : `₦${grandTotal.toFixed(2)}`;
  }

  // ── Wallet pay row ────────────────────────────────────────────────────────
  // Show Pay with Wallet option when the cart has items
  const cartFooter = document.querySelector('.cart-footer');
  if (cartFooter && cart.length > 0) {
    // Remove existing wallet row so it doesn't duplicate
    const existing = cartFooter.querySelector('.wallet-pay-row');
    if (existing) existing.remove();

    const balance      = window.walletBalance || 0;
    const cartSubtotal = calculateTotal();      // wallet pays subtotal only (no service charge)
    const hasFunds     = balance >= cartSubtotal;

    const walletRow = document.createElement('div');
    walletRow.className = 'wallet-pay-row';
    walletRow.innerHTML = `
      <p class="wallet-pay-balance">
        Wallet: ₦${balance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}
        ${hasFunds ? '— <strong style="color:#16a34a;">sufficient</strong>' : ''}
      </p>
      <button class="btn-wallet-pay" onclick="payWithWallet()" ${hasFunds ? '' : 'disabled'}>
        ${hasFunds ? '◎ Pay with Wallet (₦' + cartSubtotal.toLocaleString('en-NG', { minimumFractionDigits: 2 }) + ')' : '◎ Insufficient balance'}
      </button>`;
    cartFooter.appendChild(walletRow);
  } else if (cartFooter) {
    const existing = cartFooter.querySelector('.wallet-pay-row');
    if (existing) existing.remove();
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
