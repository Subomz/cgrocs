// ============================================================
//  ColEx — firebase-config.js
//  Single source of truth for all Firebase project configs.
// ============================================================

export const customerConfig = {
    apiKey:            "AIzaSyAiUCMpCNYkOQZ7zLxFjkpHTh-Nk3QN3gw",
    authDomain:        "cloexlogin-d466a.firebaseapp.com",
    projectId:         "cloexlogin-d466a",
    storageBucket:     "cloexlogin-d466a.firebasestorage.app",
    messagingSenderId: "87844737437",
    appId:             "1:87844737437:web:11f79d9b262d042d915f74"
};

export const adminConfig = {
    apiKey:            "AIzaSyCPk6S4_eefL_2uPLF13IezpmB4jipijbA",
    authDomain:        "cloexadminlogin.firebaseapp.com",
    projectId:         "cloexadminlogin",
    storageBucket:     "cloexadminlogin.firebasestorage.app",
    messagingSenderId: "909762210969",
    appId:             "1:909762210969:web:2d4efbda5bbb0014a85c08"
};

export const headAdminConfig = {
    apiKey:            "AIzaSyBq1fxBBjm54ekc6YwGQEivCnbOuCcoHJU",
    authDomain:        "cloex-managerpage.firebaseapp.com",
    projectId:         "cloex-managerpage",
    storageBucket:     "cloex-managerpage.firebasestorage.app",
    messagingSenderId: "737992865407",
    appId:             "1:737992865407:web:0d68c9979e8392f0bfb14a"
};

//  Store helpers 
// All Firestore data is namespaced under /stores/{storeId}/ so the two stores
// share the same Firebase projects while keeping their data fully separated.
//
//   /stores/store1/products/{id}
//   /stores/store1/purchases/{id}
//   /stores/store1/categories/list
//   /stores/store1/reservations/{id}
//   /stores/store1/product_logs/{id}   (written into customer project for head-admin reads)
//
//   /stores/store2/...  (identical structure)
//
// Admin cashier profiles are stored in the admin project at:
//   /cashiers/{uid}   — includes a `storeId` field (store1 | store2)
//
// The general head admin has a special role stored in headAdminConfig project:
//   /admins/{uid}  →  { role: 'general' }
// Per-store head admins:
//   /admins/{uid}  →  { role: 'store-head', storeId: 'store1' | 'store2' }

export const STORE_IDS = ['store1', 'store2'];

export const STORE_LABELS = {
    store1: 'Store 1 — Main Branch',
    store2: 'Store 2 — Second Branch'
};

/**
 * Returns the active store ID from sessionStorage.
 * Falls back to 'store1' if nothing is set (e.g. for cashiers whose
 * storeId is injected by the auth guard, not sessionStorage).
 */
export function getActiveStore() {
    return sessionStorage.getItem('selectedStore') || 'store1';
}

/**
 * Returns the Firestore collection path for a given store and collection name.
 * e.g. storeCol('store1', 'products') → 'stores/store1/products'
 */
export function storeCol(storeId, colName) {
    return `stores/${storeId}/${colName}`;
}

/**
 * Returns the Firestore document path for a given store and document.
 * e.g. storeDoc('store1', 'categories', 'list') → 'stores/store1/categories/list'
 */
export function storeDoc(storeId, colName, docId) {
    return `stores/${storeId}/${colName}/${docId}`;
}
