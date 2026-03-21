import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { customerConfig } from "./firebase-config.js";

const APP_NAME = 'cardstorage';
let app;
try {
    const existing = getApps().find(a => a.name === APP_NAME);
    app = existing ? existing : initializeApp(customerConfig, APP_NAME);
} catch (e) {
    console.error("register.js: Firebase init error:", e);
}

const auth = getAuth(app);
const db   = getFirestore(app);

document.getElementById('submit').addEventListener('click', async function (e) {
    e.preventDefault();

    const firstName = document.getElementById('first-name').value.trim();
    const lastName  = document.getElementById('last-name').value.trim();
    const phone     = document.getElementById('phone').value.trim();
    const email     = document.getElementById('email').value.trim();
    const password  = document.getElementById('password').value;

    if (!firstName || !lastName) { notify.error("Please enter your first and last name."); return; }
    if (!email || !password)     { notify.error("Please enter both email and password."); return; }
    if (password.length < 6)     { notify.error("Password must be at least 6 characters."); return; }

    const btn = document.getElementById('submit');
    btn.disabled    = true;
    btn.textContent = 'Creating account...';

    // ── Step 1: Create Firebase Auth user ─────────────────────────────────────
    let user = null;
    try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        user = cred.user;
    } catch (authError) {
        const code = authError.code;
        let msg = authError.message;
        if (code === 'auth/email-already-in-use') msg = "This email is already registered. Please login instead.";
        else if (code === 'auth/invalid-email')   msg = "Please enter a valid email address.";
        else if (code === 'auth/weak-password')   msg = "Password is too weak. Use at least 6 characters.";
        notify.error(msg);
        btn.disabled    = false;
        btn.textContent = 'Create Account';
        return;
    }

    const fullName = `${firstName} ${lastName}`;

    // ── Step 2: Store name in Firebase Auth displayName ───────────────────────
    // This always works for the authenticated user — no Firestore rules needed.
    try {
        await updateProfile(user, { displayName: fullName });
    } catch (profileError) {
        // Non-fatal — we still have the user account
        console.warn("register.js: Could not set displayName:", profileError.message);
    }

    // ── Step 3: Write minimal Firestore doc (phone + metadata only) ───────────
    // Name is already in Firebase Auth so this doc only needs to store phone.
    // If the Firestore write fails due to security rules the user can still
    // shop — name comes from Auth and phone can be added later in their profile.
    try {
        await setDoc(doc(db, "users", user.uid), {
            uid:   user.uid,
            email,
            phone:     phone || '',
            createdAt: new Date().toISOString()
        });
    } catch (firestoreError) {
        // Non-fatal — log it but don't block the user
        console.warn("register.js: Firestore write failed (non-fatal):", firestoreError.code, firestoreError.message);
    }

    // ── Always proceed to the shop ────────────────────────────────────────────
    notify.success("Account created! Welcome to CGrocs.");
    sessionStorage.setItem('tab_active', 'true');
    if (!sessionStorage.getItem('selectedStore')) sessionStorage.setItem('selectedStore', 'store1');
    setTimeout(() => { window.location.href = "customer.html"; }, 700);
});
