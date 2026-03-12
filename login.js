import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { customerConfig, adminConfig, headAdminConfig } from "./firebase-config.js";

const customerApp = getApps().find(a => a.name === 'cardstorage')
    || initializeApp(customerConfig, 'cardstorage');

const adminApp = getApps().find(a => a.name === 'admin-guard')
    || initializeApp(adminConfig, 'admin-guard');

const headAdminApp = getApps().find(a => a.name === 'head-admin-guard')
    || initializeApp(headAdminConfig, 'head-admin-guard');

const customerAuth  = getAuth(customerApp);
const adminAuth     = getAuth(adminApp);
const headAdminAuth = getAuth(headAdminApp);

// Firestore instances for store validation
const adminDb     = getFirestore(adminApp);
const headAdminDb = getFirestore(headAdminApp);

//  Bug fix: also catch auth/invalid-login-credentials (Firebase v9+ with
//    email-enumeration protection enabled returns this instead of
//    auth/user-not-found or auth/wrong-password) 
const PASS_THROUGH_CODES = new Set([
    'auth/invalid-credential',
    'auth/invalid-login-credentials',
    'auth/user-not-found',
    'auth/wrong-password'
]);

//  Enter key submits the form 
['email', 'password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('submit').click();
    });
});

//  Login 
document.getElementById("submit").addEventListener("click", async function(e) {
    e.preventDefault();

    const email    = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    if (!email || !password) {
        notify.error("Please enter both email and password.");
        return;
    }

    const btn = document.getElementById("submit");
    btn.disabled    = true;
    btn.textContent = "Signing in…";

    const selectedStore = sessionStorage.getItem('selectedStore');

    //  Step 1: Try customer project 
    try {
        const cred = await signInWithEmailAndPassword(customerAuth, email, password);
        console.log("Customer login successful:", cred.user.email);
        notify.success("Login successful!");
        // Ensure a store is selected
        if (!selectedStore) {
            sessionStorage.setItem('selectedStore', 'store1');
        }
        sessionStorage.setItem('tab_active', 'true');
        setTimeout(() => { window.location.href = "customer.html"; }, 500);
        return;
    } catch (customerErr) {
        if (!PASS_THROUGH_CODES.has(customerErr.code)) {
            notify.error(friendlyError(customerErr.code));
            resetBtn(btn);
            return;
        }
        console.log("Not a customer account, trying admin…");
    }

    //  Step 2: Try cashier (admin) project — validate store matches 
    try {
        const cred = await signInWithEmailAndPassword(adminAuth, email, password);
        const uid  = cred.user.uid;

        // Fetch cashier profile to check their assigned store
        let cashierStore = null;
        try {
            const snap = await getDoc(doc(adminDb, 'cashiers', uid));
            cashierStore = snap.exists() ? (snap.data().storeId || 'store1') : 'store1';
        } catch (e) {
            console.warn("Could not fetch cashier profile for store check:", e.message);
            cashierStore = 'store1';
        }

        // If a store is selected and it doesn't match, reject
        if (selectedStore && cashierStore !== selectedStore) {
            notify.error("Invalid email or password.");
            resetBtn(btn);
            return;
        }

        console.log("Admin login successful:", cred.user.email);
        notify.success("Login successful!");
        sessionStorage.setItem('tab_active', 'true');
        setTimeout(() => { window.location.href = "admin.html"; }, 500);
        return;
    } catch (adminErr) {
        console.log("Admin login also failed:", adminErr.code);
    }

    //  Step 3: Try head admin project — general admins bypass store check 
    try {
        const cred = await signInWithEmailAndPassword(headAdminAuth, email, password);
        const uid  = cred.user.uid;

        // Fetch role to check if general or store-head
        let role      = 'store-head';
        let haStoreId = 'store1';
        try {
            const snap = await getDoc(doc(headAdminDb, 'admins', uid));
            if (snap.exists()) {
                role      = snap.data().role    || 'store-head';
                haStoreId = snap.data().storeId || 'store1';
            }
        } catch (e) {
            console.warn("Could not fetch head admin role for store check:", e.message);
        }

        // General admins can log in from any store
        // Store-head admins must match the selected store
        if (role !== 'general' && selectedStore && haStoreId !== selectedStore) {
            notify.error("Invalid email or password.");
            resetBtn(btn);
            return;
        }

        console.log("Head admin login successful:", cred.user.email);
        notify.success("Login successful!");
        sessionStorage.setItem('tab_active', 'true');
        setTimeout(() => { window.location.href = "head-admin.html"; }, 500);
        return;
    } catch (headAdminErr) {
        console.log("Head admin login also failed:", headAdminErr.code);
    }

    //  All three failed 
    notify.error("Invalid email or password.");
    resetBtn(btn);
});

//  Password reset 
window.openResetModal = function() {
    const existing = document.getElementById('reset-modal');
    if (existing) existing.remove();

    // Pre-fill the email field if the user already typed one on the login form
    const prefill = (document.getElementById('email')?.value || '').trim();

    const modal = document.createElement('div');
    modal.id = 'reset-modal';
    modal.style.cssText = [
        'position:fixed;inset:0;background:rgba(0,0,0,0.45);',
        'display:flex;align-items:center;justify-content:center;',
        'z-index:99999;padding:16px;'
    ].join('');

    modal.innerHTML = `
        <div style="
            background:white;border-radius:16px;width:100%;max-width:400px;
            box-shadow:0 8px 40px rgba(0,0,0,0.18);
            font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
            overflow:hidden;
        ">
            <!-- Header -->
            <div style="background:#111;color:white;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
                <h2 style="margin:0;font-size:17px;font-weight:700;">Reset Password</h2>
                <button id="reset-close" style="
                    background:rgba(255,255,255,0.15);border:none;color:white;
                    width:32px;height:32px;border-radius:50%;font-size:20px;
                    cursor:pointer;display:flex;align-items:center;justify-content:center;
                    line-height:1;
                ">×</button>
            </div>

            <!-- Body -->
            <div style="padding:28px 24px 24px;">
                <p style="font-size:14px;color:#666;margin:0 0 20px;line-height:1.6;">
                    Enter your email address and we'll send you a link to reset your password.
                    The link works for both customer and admin accounts.
                </p>

                <div style="margin-bottom:20px;">
                    <label style="
                        display:block;font-size:12px;font-weight:700;
                        text-transform:uppercase;letter-spacing:.06em;
                        color:#888;margin-bottom:6px;
                    ">Email Address</label>
                    <input id="reset-email" type="email" value="${prefill}"
                        placeholder="jane@email.com"
                        autocomplete="email"
                        style="
                            width:100%;padding:10px 13px;
                            border:1.5px solid #ddd;border-radius:8px;
                            font-size:14px;font-family:inherit;color:#222;
                            background:#fafafa;outline:none;
                            transition:border-color .2s,box-shadow .2s;
                            box-sizing:border-box;
                        "
                    >
                </div>

                <div style="display:flex;gap:10px;">
                    <button id="reset-cancel" style="
                        flex:1;padding:12px;background:white;color:#111;
                        border:1.5px solid #ddd;border-radius:8px;
                        font-size:14px;font-weight:600;cursor:pointer;
                        font-family:inherit;
                    ">Cancel</button>
                    <button id="reset-send" style="
                        flex:2;padding:12px;background:#111;color:white;
                        border:none;border-radius:8px;
                        font-size:14px;font-weight:700;cursor:pointer;
                        font-family:inherit;transition:background .2s;
                    ">Send Reset Link</button>
                </div>
            </div>
        </div>`;

    document.body.appendChild(modal);

    const emailInput = modal.querySelector('#reset-email');
    const sendBtn    = modal.querySelector('#reset-send');
    const closeModal = () => {
        modal.style.opacity = '0';
        modal.style.transition = 'opacity .2s';
        setTimeout(() => modal.remove(), 200);
    };

    // Focus & hover styling
    emailInput.addEventListener('focus', () => {
        emailInput.style.borderColor  = '#111';
        emailInput.style.boxShadow    = '0 0 0 3px rgba(0,0,0,0.06)';
        emailInput.style.background   = '#fff';
    });
    emailInput.addEventListener('blur', () => {
        emailInput.style.borderColor = '#ddd';
        emailInput.style.boxShadow   = 'none';
        emailInput.style.background  = '#fafafa';
    });
    sendBtn.addEventListener('mouseover', () => { sendBtn.style.background = '#333'; });
    sendBtn.addEventListener('mouseout',  () => { sendBtn.style.background = '#111'; });

    // Close on backdrop click or close button
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    modal.querySelector('#reset-close').addEventListener('click', closeModal);
    modal.querySelector('#reset-cancel').addEventListener('click', closeModal);

    // Enter key inside the email input triggers send
    emailInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') sendBtn.click();
    });

    //  Send the reset email 
    // We try both Firebase projects because the user might be a customer OR an
    // admin — they land on the same login page and we don't know which project
    // their account lives in. sendPasswordResetEmail is safe to call regardless;
    // Firebase returns auth/user-not-found (silently handled) if the email
    // isn't registered in that project.
    sendBtn.addEventListener('click', async () => {
        const resetEmail = emailInput.value.trim();
        if (!resetEmail) {
            emailInput.style.borderColor = '#e53935';
            emailInput.focus();
            return;
        }

        sendBtn.disabled    = true;
        sendBtn.textContent = 'Sending…';

        let sent = false;
        let lastErr = null;

        // Try customer project first
        try {
            await sendPasswordResetEmail(customerAuth, resetEmail);
            sent = true;
        } catch (e) {
            if (e.code !== 'auth/user-not-found' && e.code !== 'auth/invalid-email') {
                lastErr = e;
            }
        }

        // Try admin project if not yet sent (and no hard error)
        if (!sent && !lastErr) {
            try {
                await sendPasswordResetEmail(adminAuth, resetEmail);
                sent = true;
            } catch (e) {
                if (e.code !== 'auth/user-not-found') {
                    lastErr = e;
                }
            }
        }

        // Try head admin project as final fallback
        if (!sent && !lastErr) {
            try {
                await sendPasswordResetEmail(headAdminAuth, resetEmail);
                sent = true;
            } catch (e) {
                if (e.code !== 'auth/user-not-found') {
                    lastErr = e;
                }
            }
        }

        if (lastErr) {
            // Hard error (network, invalid email, rate limit)
            sendBtn.disabled    = false;
            sendBtn.textContent = 'Send Reset Link';
            notify.error(friendlyResetError(lastErr.code));
            return;
        }

        // Whether or not the email is registered we always show the same
        // success message — this prevents email enumeration attacks.
        closeModal();
        notify.success(
            `If ${resetEmail} is registered, a reset link has been sent. Check your inbox (and spam folder).`,
            8000
        );
    });

    // Auto-focus email input
    setTimeout(() => emailInput.focus(), 50);
};

//  Helpers 
function resetBtn(btn) {
    btn.disabled    = false;
    btn.textContent = "Login";
}

function friendlyError(code) {
    const map = {
        'auth/invalid-email':         "Please enter a valid email address.",
        'auth/too-many-requests':     "Too many attempts. Please try again later.",
        'auth/network-request-failed':"Network error. Check your connection.",
    };
    return map[code] || "Login failed. Please try again.";
}

function friendlyResetError(code) {
    const map = {
        'auth/invalid-email':         "Please enter a valid email address.",
        'auth/too-many-requests':     "Too many reset attempts. Please wait a few minutes.",
        'auth/network-request-failed':"Network error. Check your connection.",
    };
    return map[code] || "Could not send reset email. Please try again.";
}
