import { getFirestore, collection, addDoc, doc, getDoc, setDoc, deleteDoc, getDocs, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getActiveStore, storeCol, storeDoc } from "./firebase-config.js";

// Get Firestore from the same named app that cardstorage.js created
const app = getApps().find(a => a.name === 'cardstorage') || getApps()[0];
const db = getFirestore(app);

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

function showQRCodeModal(purchaseId, items, total) {
  const modal = document.createElement('div');
  modal.className = 'qr-modal';
  modal.id = 'qr-modal';
  
  const itemsList = items.map(item => 
    `${item.quantity}x ${item.name} @ ₦${item.price}`
  ).join('<br>');
  
  modal.innerHTML = `
    <div class="qr-modal-content">
      <div class="qr-header">
        <h2> Purchase Successful!</h2>
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
          <p class="qr-instruction">Show this QR code or ID to admin for verification</p>
        </div>
        <div class="modal-actions">
          <button onclick="downloadQR('${purchaseId}')" class="btn-download">Download QR</button>
          <button onclick="closeQRModal()" class="btn-done">Done</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);

  // Small delay so the #qrcode element is in the DOM before QRCode targets it
  setTimeout(() => {
    new QRCode(document.getElementById("qrcode"), {
      text: purchaseId,
      width: 200,
      height: 200,
      colorDark: "#000000",
      colorLight: "#ffffff",
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
}

window.downloadQR = function(purchaseId) {
  const qrCanvas = document.querySelector('#qrcode canvas');
  if (!qrCanvas) return;

  // Create a composite canvas: ID label on top, QR code below
  const padding  = 16;
  const fontSize = 18;
  const lineH    = fontSize + 8;
  const totalH   = lineH + padding + qrCanvas.height + padding;
  const totalW   = Math.max(qrCanvas.width + padding * 2, 260);

  const out = document.createElement('canvas');
  out.width  = totalW;
  out.height = totalH;
  const ctx = out.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, totalH);

  // Purchase ID text centred at top
  ctx.fillStyle = '#111111';
  ctx.font      = `bold ${fontSize}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(purchaseId, totalW / 2, padding + fontSize);

  // QR code centred below the label
  const qrX = (totalW - qrCanvas.width) / 2;
  ctx.drawImage(qrCanvas, qrX, padding + lineH);

  const link = document.createElement('a');
  link.download = `purchase-${purchaseId}.png`;
  link.href = out.toDataURL('image/png');
  link.click();
}

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
  const { purchaseId, cartSnapshot, total } = payload;

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
  showQRCodeModal(purchaseId, cartSnapshot, total);

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

  var total        = calculateTotal();
  var purchaseId   = generatePurchaseId();
  var paystackRef  = purchaseId.replace(/-/g, '');
  var cartSnapshot = cart.map(function(item) { return Object.assign({}, item); });

  _paystackPayload = {
    purchaseId:   purchaseId,
    cartSnapshot: cartSnapshot,
    total:        total
  };

  var handler = PaystackPop.setup({
    key:      PAYSTACK_PUBLIC_KEY,
    email:    userEmail,
    amount:   Math.round(total * 100),
    currency: 'NGN',
    ref:      paystackRef,
    metadata: {
      custom_fields: [
        { display_name: "Purchase ID", variable_name: "purchase_id", value: purchaseId }
      ]
    },
    callback: window._paystackCallback,
    onClose:  window._paystackOnClose
  });

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
        cartTotal.innerText = "₦0.00";
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
            <strong>${item.name}</strong>
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
    cartTotal.innerText = `₦${grandTotal.toFixed(2)}`;
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
