import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { headAdminConfig } from "./firebase-config.js";

const APP_NAME = 'head-admin-guard';
let app;
try {
    const existing = getApps().find(a => a.name === APP_NAME);
    app = existing ? existing : initializeApp(headAdminConfig, APP_NAME);
} catch (e) { console.error("Head admin Firebase init error:", e); }

const auth = getAuth(app);
const db   = getFirestore(app);

const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'auth-loading';
loadingOverlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:white;display:flex;justify-content:center;align-items:center;z-index:999999;font-family:Arial,sans-serif;`;
loadingOverlay.innerHTML = `<div style="text-align:center;"><div style="width:50px;height:50px;border:5px solid #f3f3f3;border-top:5px solid #000;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px;"></div><p style="font-size:18px;color:#333;">Verifying access…</p></div><style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>`;
document.body.appendChild(loadingOverlay);

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        if (sessionStorage.getItem('ha_intentional_logout')) {
            sessionStorage.removeItem('ha_intentional_logout');
        }
        window.location.href = 'home.html';
    } else {
        window.currentHeadAdmin = user;

        // Load admin role (general | store-head) and storeId
        try {
            const snap = await getDoc(doc(db, 'admins', user.uid));
            if (snap.exists()) {
                const data = snap.data();
                window._haRole    = data.role    || 'store-head';
                window._haStoreId = data.storeId || 'store1';
            } else {
                window._haRole    = 'store-head';
                window._haStoreId = 'store1';
            }
        } catch (e) {
            console.warn('Could not load head admin role:', e.message);
            window._haRole    = 'store-head';
            window._haStoreId = 'store1';
        }

        document.body.style.visibility = 'visible';
        setTimeout(() => {
            loadingOverlay.style.opacity    = '0';
            loadingOverlay.style.transition = 'opacity 0.3s';
            setTimeout(() => loadingOverlay.remove(), 300);
        }, 400);

        document.querySelectorAll('.logout-button').forEach(btn => {
            btn.addEventListener('click', function () {
                sessionStorage.setItem('ha_intentional_logout', 'true');
                signOut(auth).then(() => {
                    sessionStorage.clear();
                    window.location.href = 'home.html';
                }).catch(e => {
                    console.error("Logout error:", e);
                    sessionStorage.removeItem('ha_intentional_logout');
                });
            });
        });
    }
});
