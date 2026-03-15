import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { customerConfig, adminConfig, getActiveStore, storeCol, storeDoc } from "./firebase-config.js";

const CARDSTORAGE_APP_NAME = 'cardstorage';
let app;
try {
    const existing = getApps().find(a => a.name === CARDSTORAGE_APP_NAME);
    app = existing || initializeApp(customerConfig, CARDSTORAGE_APP_NAME);
} catch (e) { console.error("Firebase init error:", e); }

const auth = getAuth(app);
const db   = getFirestore(app);

// Admin project — product_logs stored here so head admin can read via cashierDb
const adminLogApp = getApps().find(a => a.name === 'admin-guard')
    || initializeApp(adminConfig, 'admin-guard');
const adminLogDb = getFirestore(adminLogApp);

// ── Active store — always resolved live so auth guards can set it first ───────
// Never freeze _storeId at module load. col() and docRef() call
// resolveStoreId() fresh on every Firestore operation so that by the time
// init() or reloadStoreProducts() runs the auth guard has already written
// the correct storeId to sessionStorage / window.cashierStoreId.
function resolveStoreId() {
    return window.cashierStoreId
        || sessionStorage.getItem('cashierStoreId')
        || sessionStorage.getItem('selectedStore')
        || 'store1';
}

// Expose so other modules can read the current store
window.getStoreId = () => resolveStoreId();

//  Security: escape HTML to prevent XSS 
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const DEFAULT_PRODUCTS = [
  { name: "Luxury Watch",     stock: 20, price: 15000, category: "Accessories", img: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&h=200&fit=crop" },
  { name: "Designer Bag",     stock: 15, price: 25000, category: "Bags",        img: "https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=300&h=200&fit=crop" },
  { name: "Premium Sneakers", stock: 30, price: 12000, category: "Footwear",    img: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=300&h=200&fit=crop" },
  { name: "Leather Wallet",   stock: 50, price: 8000,  category: "Accessories", img: "https://images.unsplash.com/photo-1627123424574-724758594e93?w=300&h=200&fit=crop" },
  { name: "Sunglasses",       stock: 25, price: 5000,  category: "Accessories", img: "https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=300&h=200&fit=crop" },
  { name: "Smart Watch",      stock: 18, price: 35000, category: "Electronics", img: "https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=300&h=200&fit=crop" }
];

let products          = [];
let currentUser       = null;
let cartKey           = "guestCart";
let selectedImageFile = null;
let imagePreviewUrl   = null;
let _activeCategory      = 'All';
let _searchQuery         = '';
let _adminActiveCategory = 'All';
let _adminSearchQuery    = '';

onAuthStateChanged(auth, (user) => {
  currentUser = user; window.currentUser = user;
  cartKey = user ? `cart_${user.uid}` : "guestCart";
});

//  Store path helpers 
function col(name)        { return collection(db, storeCol(resolveStoreId(), name)); }
function docRef(name, id) { return doc(db, storeDoc(resolveStoreId(), name, id)); }

//  Firestore: products 
async function loadProducts() {
  try {
    const snap = await getDocs(col('products'));
    const loaded = [];
    snap.forEach(d => loaded.push({ id: d.id, ...d.data() }));
    if (loaded.length === 0 && !snap.metadata.fromCache) {
      // Only seed when Firestore confirms the collection is genuinely empty.
      // If the read came from cache (e.g. a permissions error returned nothing),
      // we skip seeding to avoid silently overwriting a store's products.
      await initializeDefaultProducts();
      return loadProducts();
    }
    return loaded;
  } catch (e) {
    console.error('Firestore error:', e);
    notify.error('Database error. Using local cache.');
    const local = sessionStorage.getItem(`myProducts_${resolveStoreId()}`);
    return local ? JSON.parse(local) : [...DEFAULT_PRODUCTS];
  }
}
async function initializeDefaultProducts() {
  try { for (const p of DEFAULT_PRODUCTS) await addDoc(col('products'), p); }
  catch (e) { console.error('Init error:', e); }
}
async function saveProductToFirestore(data)       { return (await addDoc(col('products'), data)).id; }
async function updateProductInFirestore(id, data) { await updateDoc(doc(db, storeDoc(resolveStoreId(), 'products', id)), data); }
async function deleteProductFromFirestore(id)     { await deleteDoc(doc(db, storeDoc(resolveStoreId(), 'products', id))); }

async function logProductChange(action, productId, snapshot, before, after, cashierEmail, cashierName) {
  try {
    const changes = [];
    if (action === 'edit' && before && after) {
      const fields = ['name','price','stock','category','description'];
      fields.forEach(f => {
        if (String(before[f] ?? '') !== String(after[f] ?? '')) {
          changes.push({ field: f, from: before[f] ?? '', to: after[f] ?? '' });
        }
      });
    }
    await addDoc(collection(adminLogDb, storeCol(resolveStoreId(), 'product_logs')), {
      action, productId,
      productName: (after || snapshot).name || '',
      changes, cashierEmail, cashierName,
      storeId: resolveStoreId(),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.warn('Could not write product log:', e.message);
  }
}

//  Firestore: categories 
async function loadCategories() {
  try {
    const snap = await getDoc(docRef('categories', 'list'));
    if (snap.exists()) return snap.data().items || [];
  } catch (e) { console.warn('loadCategories:', e.message); }
  return [...new Set(products.map(p => p.category).filter(Boolean))];
}
async function saveCategories(cats) {
  try { await setDoc(docRef('categories', 'list'), { items: cats }); }
  catch (e) { console.warn('saveCategories:', e.message); }
}
async function getAllCategories() {
  const fromFirestore = await loadCategories();
  const fromProducts  = products.map(p => p.category).filter(Boolean);
  return [...new Set([...fromFirestore, ...fromProducts])].sort();
}

//  Category dropdown 
async function populateCategoryDropdown(selectedValue) {
  const sel = document.getElementById('p-category'); if (!sel) return;
  const cats = await getAllCategories();
  sel.innerHTML = '<option value="">— No category —</option>' +
    cats.map(c => `<option value="${c}"${c === selectedValue ? ' selected' : ''}>${c}</option>`).join('');
}

//  Add/delete category modal 
window.openAddCategoryModal = function() {
  const existing = document.getElementById('add-cat-modal'); if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'add-cat-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;';
  modal.innerHTML = `
    <div style="background:white;border-radius:16px;width:100%;max-width:400px;padding:28px 24px 22px;box-shadow:0 8px 40px rgba(0,0,0,0.18);font-family:'DM Sans','Segoe UI',sans-serif;">
      <h3 style="margin:0 0 4px;font-size:17px;font-weight:800;color:#1a1a1a;">Manage Categories</h3>
      <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">Categories appear as filter pills on the shop page.</p>
      <div style="display:flex;gap:8px;margin-bottom:18px;">
        <input id="new-cat-input" type="text" placeholder="New category name…"
          style="flex:1;padding:10px 13px;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-family:inherit;outline:none;"
          onfocus="this.style.borderColor='#111'" onblur="this.style.borderColor='#ddd'"
          onkeydown="if(event.key==='Enter')window.confirmAddCategory()">
        <button onclick="window.confirmAddCategory()"
          style="padding:10px 18px;border:none;background:#0a0a0a;color:white;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Add</button>
      </div>
      <p style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;">Existing</p>
      <div id="existing-cats-list" style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px;margin-bottom:18px;"></div>
      <button onclick="document.getElementById('add-cat-modal').remove()"
        style="width:100%;padding:11px;border:1.5px solid #e4e4e7;background:white;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">Close</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('new-cat-input').focus();
  _refreshCatList();
};

async function _refreshCatList() {
  const el = document.getElementById('existing-cats-list'); if (!el) return;
  const cats = await getAllCategories();
  if (cats.length === 0) { el.innerHTML = '<span style="font-size:13px;color:#bbb;">None yet</span>'; return; }
  el.innerHTML = cats.map(c => `
    <span style="display:inline-flex;align-items:center;gap:4px;background:#f4f4f5;border-radius:20px;padding:5px 10px 5px 13px;font-size:13px;font-weight:600;color:#1a1a1a;">
      ${c}
      <button onclick="window.deleteCategory('${c.replace(/'/g,"\\'")}')"
        style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1;color:#bbb;padding:0 2px;" title="Remove">×</button>
    </span>`).join('');
}

window.confirmAddCategory = async function() {
  const input = document.getElementById('new-cat-input');
  const name  = input ? input.value.trim() : '';
  if (!name) { notify.warning('Enter a category name.'); return; }
  const cats = await loadCategories();
  if (cats.map(c => c.toLowerCase()).includes(name.toLowerCase())) { notify.warning('Category already exists.'); return; }
  cats.push(name); cats.sort();
  await saveCategories(cats);
  if (input) input.value = '';
  await populateCategoryDropdown(name);
  _buildCategoryBar(); _buildAdminCategoryBar(); _refreshCatList();
  notify.success(`"${name}" added!`);
};

window.deleteCategory = async function(name) {
  const cats = await loadCategories();
  await saveCategories(cats.filter(c => c !== name));
  await populateCategoryDropdown('');
  _buildCategoryBar(); _buildAdminCategoryBar(); _refreshCatList();
  notify.success(`"${name}" removed.`);
};

//  Image helpers 
const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
function convertImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = e => resolve(e.target.result); r.onerror = e => reject(e); r.readAsDataURL(file);
  });
}
window.handleImageSelect = function(event) {
  const file = event.target.files[0];
  if (!file) { selectedImageFile = null; imagePreviewUrl = null; updateImagePreview(null); return; }
  if (!file.type.startsWith('image/')) { notify.error('Select an image file.'); event.target.value = ''; return; }
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) { notify.error('Image must be under 5MB.'); event.target.value = ''; return; }
  selectedImageFile = file;
  const r = new FileReader(); r.onload = e => { imagePreviewUrl = e.target.result; updateImagePreview(imagePreviewUrl); }; r.readAsDataURL(file);
};
function updateImagePreview(url) {
  const c = document.getElementById('image-preview-container'); if (!c) return;
  if (url) {
    c.innerHTML = `<img src="${url}" alt="Preview" style="max-width:100%;max-height:200px;border-radius:8px;object-fit:cover;">
      <button type="button" onclick="clearImageSelection()" class="btn-clear-image">Remove Image</button>`;
    c.style.display = 'block';
  } else { c.innerHTML = ''; c.style.display = 'none'; }
}
window.clearImageSelection = function() {
  selectedImageFile = null; imagePreviewUrl = null;
  const fi = document.getElementById('p-img-file'); if (fi) fi.value = '';
  updateImagePreview(null);
  const ui = document.getElementById('p-img'); if (ui) ui.value = '';
};
window.toggleImageInputMethod = function() {
  const urlS = document.getElementById('url-input-section');
  const filS = document.getElementById('file-input-section');
  const btn  = document.getElementById('toggle-input-btn');
  if (urlS.style.display === 'none') {
    urlS.style.display = 'block'; filS.style.display = 'none'; btn.textContent = 'Switch to File Upload'; window.clearImageSelection();
  } else {
    urlS.style.display = 'none'; filS.style.display = 'block'; btn.textContent = 'Switch to URL Input'; document.getElementById('p-img').value = '';
  }
};

//  Render: Admin 
function renderCardsAdmin() {
  const container = document.getElementById('product-container-admin'); if (!container) return;
  _buildAdminCategoryBar();
  if (!products || products.length === 0) {
    container.innerHTML = '<p style="text-align:center;padding:40px;color:#6b7280;">No products. Add your first!</p>'; return;
  }
  const query    = _adminSearchQuery.trim().toLowerCase();
  const filtered = products.map((p, index) => ({ p, index })).filter(({ p }) => {
    const matchCat  = _adminActiveCategory === 'All' || (p.category || '') === _adminActiveCategory;
    const matchText = !query || p.name.toLowerCase().includes(query) || (p.category || '').toLowerCase().includes(query);
    return matchCat && matchText;
  });
  const noRes = document.getElementById('no-results-admin');
  if (noRes) noRes.style.display = filtered.length === 0 ? 'block' : 'none';
  const LOW_STOCK = 5;
  container.innerHTML = filtered.map(({ p, index }) => {
    const isLow = p.stock > 0 && p.stock <= LOW_STOCK, isOut = p.stock <= 0;
    const badge = isOut ? `<span class="admin-stock-badge badge-out">OUT OF STOCK</span>`
                : isLow ? `<span class="admin-stock-badge badge-low"> Low Stock</span>` : '';
    const safeName = escapeHtml(p.name);
    const safeCat  = escapeHtml(p.category);
    const safeDesc = escapeHtml(p.description);
    return `
    <div class="card ${isLow || isOut ? 'card-stock-warn' : ''}">
      ${badge}
      <img src="${p.img || 'https://placehold.co/400x300/f5f5f5/999?text=No+Image'}" alt="${safeName}"
           onerror="this.src='https://placehold.co/400x300/f5f5f5/999?text=No+Image'">
      ${p.category ? `<span class="admin-card-category">${safeCat}</span>` : ''}
      <h4>${safeName}</h4>
      ${p.description ? `<p class="card-description">${safeDesc}</p>` : '<p class="card-description card-no-desc">No description</p>'}
      <p>₦${p.price.toLocaleString()}</p>
      <p class="stock-label ${isOut ? 'out-of-stock' : isLow ? 'low-stock-warn' : ''}">${isOut ? 'Out of Stock' : `In Stock: ${p.stock}`}</p>
      <button class="btn-edit" onclick="editProduct(${index})">Edit</button>
      <button class="btn-delete" onclick="deleteProduct(${index})">Delete</button>
    </div>`;
  }).join('');
}
function _buildAdminCategoryBar() {
  const bar = document.getElementById('admin-category-bar'); if (!bar) return;
  const cats = ['All', ...new Set(products.map(p => p.category).filter(Boolean))].sort((a,b) => a==='All'?-1:b==='All'?1:a.localeCompare(b));
  bar.innerHTML = cats.map(cat =>
    `<button class="cat-btn${cat===_adminActiveCategory?' active':''}" data-cat="${cat}" onclick="window.selectAdminCategory(this)">${cat}</button>`
  ).join('');
}
window.selectAdminCategory = function(btn) { _adminActiveCategory = btn.dataset.cat; renderCardsAdmin(); };
window.filterAdminProducts = function() {
  const input = document.getElementById('admin-product-search'); if (!input) return;
  _adminSearchQuery = input.value;
  const clr = document.getElementById('admin-search-clear'); if (clr) clr.classList.toggle('visible', _adminSearchQuery.length > 0);
  renderCardsAdmin();
};
window.clearAdminSearch = function() {
  const input = document.getElementById('admin-product-search'); if (input) input.value = '';
  _adminSearchQuery = '';
  const clr = document.getElementById('admin-search-clear'); if (clr) clr.classList.remove('visible');
  renderCardsAdmin();
};

//  Render: Customer 
function renderCardsCustomer() {
  const container = document.getElementById('product-container-customer'); if (!container) return;
  if (!products || products.length === 0) {
    container.innerHTML = '<p style="text-align:center;padding:40px;color:#6b7280;">No products available.</p>'; return;
  }
  _buildCategoryBar();
  const query    = _searchQuery.trim().toLowerCase();
  const filtered = products.map((p, index) => ({ p, index })).filter(({ p }) => {
    const matchCat  = _activeCategory === 'All' || (p.category || '') === _activeCategory;
    const matchText = !query || p.name.toLowerCase().includes(query) || (p.category || '').toLowerCase().includes(query);
    return matchCat && matchText;
  });
  const noRes = document.getElementById('no-results'); if (noRes) noRes.style.display = filtered.length === 0 ? 'block' : 'none';
  container.innerHTML = filtered.map(({ p, index }) => {
    const safeName = escapeHtml(p.name);
    const safeCat  = escapeHtml(p.category);
    const safeDesc = escapeHtml(p.description);
    return `
    <div class="card">
      <img src="${p.img || 'https://placehold.co/400x300/f5f5f5/999?text=No+Image'}" alt="${safeName}"
           onerror="this.src='https://placehold.co/400x300/f5f5f5/999?text=No+Image'">
      ${p.category ? `<span class="card-category-label">${safeCat}</span>` : ''}
      <h4>${safeName}</h4>
      ${p.description ? `<p class="card-description">${safeDesc}</p>` : '<p class="card-description card-no-desc">No description</p>'}
      <p>₦${p.price.toLocaleString()}</p>
      <p class="stock-label ${p.stock<=0?'out-of-stock':''}">${p.stock>0?`In Stock: ${p.stock}`:'Out of Stock'}</p>
      <div class="qty-selector">
        <button onclick="changeQty(${index},-1)" ${p.stock<=0?'disabled':''}>-</button>
        <input type="number" id="qty-${index}" value="${p.stock>0?1:0}" max="${p.stock}" readonly>
        <button onclick="changeQty(${index},1)" ${p.stock<=0?'disabled':''}>+</button>
      </div>
      <button class="btn-buy" onclick="addToCart(${index})" ${p.stock<=0?'disabled':''}>${p.stock>0?'Add to Cart':'Sold Out'}</button>
    </div>
  `}).join('');
}
function _buildCategoryBar() {
  const bar = document.getElementById('category-bar'); if (!bar) return;
  const cats = ['All', ...new Set(products.map(p => p.category).filter(Boolean))].sort((a,b) => a==='All'?-1:b==='All'?1:a.localeCompare(b));
  bar.innerHTML = cats.map(cat =>
    `<button class="cat-btn${cat===_activeCategory?' active':''}" data-cat="${cat}" onclick="window.selectCategory(this)">${cat}</button>`
  ).join('');
}
window.selectCategory = function(btn) { _activeCategory = btn.dataset.cat; renderCardsCustomer(); };
window.filterProducts  = function() {
  const input = document.getElementById('product-search'); if (!input) return;
  _searchQuery = input.value;
  const clr = document.getElementById('search-clear'); if (clr) clr.classList.toggle('visible', _searchQuery.length > 0);
  renderCardsCustomer();
};
window.clearSearch = function() {
  const input = document.getElementById('product-search'); if (input) input.value = '';
  _searchQuery = '';
  const clr = document.getElementById('search-clear'); if (clr) clr.classList.remove('visible');
  renderCardsCustomer();
};

//  Render: Home 
function renderCardsHome() {
  const container = document.getElementById('product-container-home'); if (!container) return;
  if (!products || products.length === 0) {
    container.innerHTML = '<p style="text-align:center;padding:40px;color:#6b7280;">No products available.</p>'; return;
  }
  container.innerHTML = products.map((p,i) => `
    <div class="card">
      <img src="${p.img||'https://placehold.co/400x300/f5f5f5/999?text=No+Image'}" alt="${p.name}"
           onerror="this.src='https://placehold.co/400x300/f5f5f5/999?text=No+Image'">
      <h4>${p.name}</h4><p>₦${p.price.toLocaleString()}</p>
      <p class="stock-label ${p.stock<=0?'out-of-stock':''}">${p.stock>0?`In Stock: ${p.stock}`:'Out of Stock'}</p>
      <button class="btn-buy" onclick="redirectToLoginPage()">Add To Cart</button>
    </div>`).join('');
}

//  Product CRUD 
window.saveProduct = async function() {
  const name      = document.getElementById('p-name').value.trim();
  const price     = parseFloat(document.getElementById('p-price').value);
  const stock     = parseInt(document.getElementById('p-stock').value);
  const urlInput  = document.getElementById('p-img').value.trim();
  const category  = document.getElementById('p-category')?.value.trim() || '';
  const description = (document.getElementById('p-desc')?.value || '').trim();
  const editIndex = document.getElementById('edit-index').value;
  if (!name || !price || isNaN(stock) || stock < 0) { notify.error("Fill all fields correctly."); return; }
  let imageUrl = "https://placehold.co/300x200/f5f5f5/999?text=No+Image";
  try {
    if (selectedImageFile) { notify.info('Processing image...'); imageUrl = await convertImageToBase64(selectedImageFile); }
    else if (urlInput) { imageUrl = urlInput; }
    const productData = { name, price, stock, img: imageUrl, category, description };
    const cashierEmail = (window.currentAdmin && window.currentAdmin.email) || '';
    const cashierName  = (window.cashierProfile && window.cashierProfile.name) ? window.cashierProfile.name : cashierEmail;
    if (editIndex === "") {
      const newId = await saveProductToFirestore(productData);
      await logProductChange('add', newId, productData, null, productData, cashierEmail, cashierName);
      notify.success("Product added!");
    } else {
      const oldProduct = products[editIndex];
      await updateProductInFirestore(oldProduct.id, productData);
      document.getElementById('edit-index').value = "";
      await logProductChange('edit', oldProduct.id, oldProduct, oldProduct, productData, cashierEmail, cashierName);
      notify.success("Product updated!");
    }
    products = await loadProducts(); window.products = products;
    sessionStorage.setItem(`myProducts_${resolveStoreId()}`, JSON.stringify(products));
    renderAll(); clearInputs();
    document.getElementById('save-btn').innerText = "Save Product";
    await populateCategoryDropdown('');
  } catch (e) { notify.error("Error saving product."); console.error(e); }
};

window.deleteProduct = function(index) {
  notify.confirm(`Delete "${products[index].name}"?`, async () => {
    try {
      const deletedProduct = products[index];
      const cashierEmail   = (window.currentAdmin && window.currentAdmin.email) || '';
      const cashierName    = (window.cashierProfile && window.cashierProfile.name) ? window.cashierProfile.name : cashierEmail;
      await deleteProductFromFirestore(deletedProduct.id);
      await logProductChange('delete', deletedProduct.id, deletedProduct, deletedProduct, null, cashierEmail, cashierName);
      products = await loadProducts(); window.products = products;
      sessionStorage.setItem(`myProducts_${resolveStoreId()}`, JSON.stringify(products));
      renderAll(); notify.success("Deleted!");
    } catch (e) { notify.error("Error deleting."); console.error(e); }
  });
};

window.editProduct = function(index) {
  const p = products[index];
  document.getElementById('p-name').value  = p.name;
  document.getElementById('p-price').value = p.price;
  document.getElementById('p-stock').value = p.stock;
  document.getElementById('edit-index').value = index;
  document.getElementById('save-btn').innerText = "Update Product";
  const urlS = document.getElementById('url-input-section'), filS = document.getElementById('file-input-section');
  if (urlS && filS) { urlS.style.display='block'; filS.style.display='none'; document.getElementById('toggle-input-btn').textContent='Switch to File Upload'; }
  selectedImageFile = null; imagePreviewUrl = null;
  const fi = document.getElementById('p-img-file'); if (fi) fi.value = '';
  const imgInput = document.getElementById('p-img'); if (imgInput) imgInput.value = p.img || '';
  updateImagePreview(p.img || null);
  populateCategoryDropdown(p.category || '');
  const descEl = document.getElementById('p-desc'); if (descEl) descEl.value = p.description || '';
  document.getElementById('admin-panel').scrollIntoView({ behavior: 'smooth' });
};

function clearInputs() {
  ['p-name','p-price','p-img','p-stock','edit-index'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const cs = document.getElementById('p-category'); if (cs) cs.value = '';
  const ds = document.getElementById('p-desc'); if (ds) ds.value = '';
  window.clearImageSelection();
}

window.changeQty = function(index, delta) {
  const input = document.getElementById(`qty-${index}`), product = products[index];
  let newVal = (parseInt(input.value)||1) + delta;
  if (newVal >= 1 && newVal <= product.stock) { input.value = newVal; }
  else if (newVal > product.stock) { notify.warning(`Only ${product.stock} available.`); }
};

//  Logout 
function doLogout() {
  sessionStorage.setItem('intentional_logout','true');
  signOut(auth).then(()=>notify.success("Logged out!")).catch(e=>{sessionStorage.removeItem('intentional_logout');notify.error("Logout error.");});
}
function showLogoutWarning(n) {
  const ex=document.getElementById('logout-warning-modal'); if(ex) ex.remove();
  const modal=document.createElement('div'); modal.id='logout-warning-modal';
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;';
  modal.innerHTML=`<div style="background:white;border-radius:16px;padding:32px 28px 24px;max-width:400px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.18);font-family:'DM Sans','Segoe UI',sans-serif;text-align:center;">
    <div style="font-size:40px;margin-bottom:12px;"></div>
    <h2 style="font-size:18px;font-weight:700;color:#1a1a1a;margin-bottom:10px;">Your cart will be cleared</h2>
    <p style="font-size:14px;color:#6b7280;margin-bottom:24px;line-height:1.5;">You have <strong>${n} item${n!==1?'s':''}</strong> in your cart. Logging out will clear it.</p>
    <div style="display:flex;gap:10px;">
      <button id="lw-stay"    style="flex:1;padding:12px;background:white;color:#1a1a1a;border:1.5px solid #e4e4e7;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Stay</button>
      <button id="lw-confirm" style="flex:1;padding:12px;background:#0a0a0a;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">Logout anyway</button>
    </div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#lw-stay').onclick=()=>modal.remove();
  modal.querySelector('#lw-confirm').onclick=()=>{modal.remove();doLogout();};
  modal.onclick=e=>{if(e.target===modal)modal.remove();};
}
window.checkLogout=function(){const c=Array.isArray(window._cart)?window._cart:[],n=c.reduce((s,i)=>s+(i.quantity||1),0);if(n>0)showLogoutWarning(n);else doLogout();};
window.handleLogout=window.checkLogout;
window.toggleFilterBar = function(barId, btnId) {
  const bar = document.getElementById(barId);
  const btn = document.getElementById(btnId);
  if (!bar) return;
  const isOpen = bar.classList.toggle('open');
  if (btn) {
    btn.classList.toggle('active', isOpen);
    btn.textContent = isOpen ? ' Close' : '⊞ Filter';
  }
};

window.redirectToLoginPage=()=>window.location.href='login.html';
window.redirectToAdminPage=()=>window.location.href='login.html';
window.updateProductInFirestore=updateProductInFirestore;
window.renderCardsCustomer=renderCardsCustomer;

function renderAll(){renderCardsAdmin();renderCardsCustomer();renderCardsHome();}
window.products=products; window.loadProducts=loadProducts;

// Called by the store picker (home.html) and by admin-auth-guard after storeId is confirmed
window.reloadStoreProducts = async function() {
  try {
    products = await loadProducts();
    window.products = products;
    renderAll();
    await populateCategoryDropdown('');
  } catch(e){ console.error('reloadStoreProducts error:', e); }
};

// Auto-init only on the customer page — admin and home pages control
// their own load timing so products are never fetched before a store is set.
function isAdminPage() {
  const path = window.location.pathname;
  return path.includes('admin.html') || path.includes('home.html');
}

async function init() {
  try {
    products = await loadProducts();
    window.products = products;
    renderAll();
    await populateCategoryDropdown('');
  } catch(e){ console.error('Init error:', e); notify.error('Error initialising.'); }
}

if (!isAdminPage()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
