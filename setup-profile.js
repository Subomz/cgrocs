import { initializeApp, getApps }        from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged }   from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { customerConfig } from "./firebase-config.js"; // fix #10

const APP_NAME = 'cardstorage';
let app;
try {
    const existing = getApps().find(a => a.name === APP_NAME);
    app = existing ? existing : initializeApp(customerConfig, APP_NAME);
} catch(e) { console.error("Firebase init error:", e); }

const auth = getAuth(app);
const db   = getFirestore(app);

let currentUser = null;

// ── Auth guard ─────────────────────────────────────────────────────────────
// Fix #6: body stays hidden (set via <body style="visibility:hidden;"> in the HTML)
// until we confirm the user actually needs to complete their profile.
// Previously the page would flash visible before redirecting profiled users.
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    currentUser = user;

    const emailEl = document.getElementById('email-display');
    if (emailEl) emailEl.value = user.email || '';

    try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) {
            const data = snap.data();

            // Profile already complete — redirect without revealing the page
            if (data.firstName && data.lastName) {
                window.location.href = 'customer.html';
                return;
            }

            // Partial profile — pre-fill whatever exists
            if (data.firstName) document.getElementById('first-name').value = data.firstName;
            if (data.lastName)  document.getElementById('last-name').value  = data.lastName;
            if (data.phone)     document.getElementById('phone').value      = data.phone;
        }
    } catch(e) {
        console.warn("Could not pre-load profile (non-fatal):", e.message);
    }

    // Only reveal the page once we know the user needs to fill it in
    document.body.style.visibility = 'visible';
});

// ── Save profile ───────────────────────────────────────────────────────────
document.getElementById('submit').addEventListener('click', async function() {
    if (!currentUser) {
        notify.error("Not logged in. Please refresh and try again.");
        return;
    }

    const firstName = document.getElementById('first-name').value.trim();
    const lastName  = document.getElementById('last-name').value.trim();

    if (!firstName || !lastName) {
        notify.error("First and last name are required.");
        if (!firstName) document.getElementById('first-name').style.borderColor = '#e53935';
        if (!lastName)  document.getElementById('last-name').style.borderColor  = '#e53935';
        return;
    }

    const btn = document.getElementById('submit');
    btn.disabled    = true;
    btn.textContent = 'Saving...';

    const profileData = {
        firstName,
        lastName,
        fullName:  `${firstName} ${lastName}`,
        phone:     document.getElementById('phone').value.trim(),
        email:     currentUser.email,
        uid:       currentUser.uid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    try {
        await setDoc(doc(db, "users", currentUser.uid), profileData, { merge: true });
        notify.success("Profile saved! Redirecting...");
        setTimeout(() => { window.location.href = 'customer.html'; }, 800);

    } catch(e) {
        console.error("Firestore save error — code:", e.code, "| message:", e.message);
        btn.disabled    = false;
        btn.textContent = 'Save & Continue';

        if (e.code === 'permission-denied') {
            console.error(
                "FIRESTORE RULES FIX REQUIRED\n\n" +
                "Go to: Firebase Console > Firestore Database > Rules\n" +
                "Replace your rules with:\n\n" +
                "rules_version = '2';\n" +
                "service cloud.firestore {\n" +
                "  match /databases/{database}/documents {\n\n" +
                "    match /users/{userId} {\n" +
                "      allow read, write: if request.auth != null && request.auth.uid == userId;\n" +
                "    }\n\n" +
                "    match /products/{productId} {\n" +
                "      allow read: if true;\n" +
                "      allow write: if request.auth != null;\n" +
                "    }\n\n" +
                "    match /purchases/{purchaseId} {\n" +
                "      allow read, write: if request.auth != null;\n" +
                "    }\n" +
                "  }\n" +
                "}"
            );
            notify.error(
                "Permission denied by database. Check the browser console (F12) for the exact Firestore rules you need to add.",
                10000
            );
        } else if (e.code === 'unavailable' || e.code === 'network-request-failed') {
            notify.error("Network error. Check your internet connection and try again.");
        } else {
            notify.error("Save failed: " + e.message);
        }
    }
});

// Reset red borders when user starts typing
['first-name', 'last-name'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', function() { this.style.borderColor = ''; });
});
