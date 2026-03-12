import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { customerConfig } from "./firebase-config.js"; // fix #10

const APP_NAME = 'cardstorage';
let app;
try {
    const existing = getApps().find(a => a.name === APP_NAME);
    app = existing ? existing : initializeApp(customerConfig, APP_NAME);
} catch (e) {
    console.error("customer-auth-guard: Firebase init error:", e);
}

const auth = getAuth(app);

// Loading overlay
const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'auth-loading';
loadingOverlay.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:white;display:flex;justify-content:center;align-items:center;
    z-index:999999;font-family:Arial,sans-serif;`;
loadingOverlay.innerHTML = `
    <div style="text-align:center;">
        <div style="width:50px;height:50px;border:5px solid #f3f3f3;border-top:5px solid #000;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px;"></div>
        <p style="font-size:18px;color:#333;">Verifying authentication...</p>
    </div>
    <style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>`;
document.body.appendChild(loadingOverlay);

onAuthStateChanged(auth, (user) => {
    if (!user) {
        // On logout (intentional or not from this page), always send to home.
        // The intentional_logout flag in sessionStorage is set by the caller;
        // we clear it here and redirect immediately without a delay.
        sessionStorage.removeItem('intentional_logout');
        sessionStorage.removeItem('selectedStore');
        window.location.href = 'home.html';
    } else {
        // If no tab_active flag, the tab was closed without logging out.
        // Sign out now so Firebase's persisted auth doesn't keep them in.
        if (!sessionStorage.getItem('tab_active')) {
            signOut(auth).then(() => {
                sessionStorage.clear();
                window.location.href = 'home.html';
            });
            return;
        }

        console.log("User authenticated:", user.email);
        window.currentUser = user;

        // If no store was selected (e.g. direct URL access), send back to home
        if (!sessionStorage.getItem('selectedStore')) {
            window.location.href = 'home.html';
            return;
        }

        document.body.style.visibility = 'visible';
        setTimeout(() => {
            loadingOverlay.style.opacity    = '0';
            loadingOverlay.style.transition = 'opacity 0.3s';
            setTimeout(() => loadingOverlay.remove(), 300);
        }, 500);

        // Ensure products are loaded for the correct selected store
        if (typeof window.reloadStoreProducts === 'function') {
            window.reloadStoreProducts();
        }
    }
});
