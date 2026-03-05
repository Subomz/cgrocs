import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { adminConfig } from "./firebase-config.js";

let app;
const appName = 'admin-guard';
try {
    const existing = getApps().find(a => a.name === appName);
    app = existing ? existing : initializeApp(adminConfig, appName);
} catch (error) { console.error("Firebase initialization error:", error); }

const auth = getAuth(app);
const db   = getFirestore(app);

const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'auth-loading';
loadingOverlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:white;display:flex;justify-content:center;align-items:center;z-index:999999;font-family:Arial,sans-serif;`;
loadingOverlay.innerHTML = `<div style="text-align:center;"><div style="width:50px;height:50px;border:5px solid #f3f3f3;border-top:5px solid #000;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px;"></div><p style="font-size:18px;color:#333;">Verifying authentication...</p></div><style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>`;
document.body.appendChild(loadingOverlay);

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        if (sessionStorage.getItem('intentional_logout')) {
            sessionStorage.removeItem('intentional_logout');
            window.location.href = 'home.html';
        } else {
            window.location.href = 'login.html';
        }
    } else {
        window.currentAdmin = user;

        // Load cashier's assigned store so all modules can use it
        try {
            const snap = await getDoc(doc(db, 'cashiers', user.uid));
            const storeId = snap.exists() ? (snap.data().storeId || 'store1') : 'store1';
            sessionStorage.setItem('cashierStoreId', storeId);
            window.cashierStoreId = storeId;
        } catch (e) {
            console.warn('Could not load cashier storeId:', e.message);
            sessionStorage.setItem('cashierStoreId', 'store1');
            window.cashierStoreId = 'store1';
        }

        // Now that storeId is set, load products for this store
        if (typeof window.reloadStoreProducts === 'function') {
            window.reloadStoreProducts();
        }

        document.body.style.visibility = 'visible';
        setTimeout(() => {
            loadingOverlay.style.opacity    = '0';
            loadingOverlay.style.transition = 'opacity 0.3s';
            setTimeout(() => loadingOverlay.remove(), 300);
        }, 500);

        document.querySelectorAll('.logout-button').forEach(btn => {
            btn.addEventListener('click', function() {
                sessionStorage.setItem('intentional_logout', 'true');
                signOut(auth).then(() => {
                    if (typeof notify !== 'undefined') notify.success("Logged out!");
                    sessionStorage.clear();
                    window.location.href = 'home.html';
                }).catch(e => {
                    console.error("Logout error:", e);
                    sessionStorage.removeItem('intentional_logout');
                });
            });
        });
    }
});
