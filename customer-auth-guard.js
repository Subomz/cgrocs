import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
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
        if (sessionStorage.getItem('intentional_logout')) {
            sessionStorage.removeItem('intentional_logout');
            setTimeout(() => { window.location.href = 'home.html'; }, 2000);
        } else {
            console.log("Unauthorized access - redirecting to login");
            window.location.href = 'login.html';
        }
    } else {
        console.log("User authenticated:", user.email);
        window.currentUser = user;
        document.body.style.visibility = 'visible';
        setTimeout(() => {
            loadingOverlay.style.opacity    = '0';
            loadingOverlay.style.transition = 'opacity 0.3s';
            setTimeout(() => loadingOverlay.remove(), 300);
        }, 500);
    }
});
