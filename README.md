# CGrocs

A multi-store grocery web app with customer shopping, cashier management, and admin controls — built with vanilla HTML/CSS/JS, Firebase, and Paystack.

---

## Features

### Customer
- Browse products by category and store location
- Add items to cart and pay via Paystack
- View purchase history and order status (pending → ready → verified)
- QR code generation for order pickup
- Profile management with avatar upload

### Cashier (Admin)
- Scan or verify customer QR codes at pickup
- Mark orders as ready or verified
- Manage product inventory and categories
- View store-specific transaction logs

### Head Admin
- Full oversight across all stores
- Create and delete cashier accounts
- Create and delete other head admin accounts (general or per-store)
- Configure Paystack split payment subaccounts per store
- Delete entire store data

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript (vanilla) |
| Auth & Database | Firebase Authentication + Firestore |
| Payments | Paystack (inline.js + split subaccounts) |
| Hosting | Cloudflare Pages |
| Serverless Functions | Cloudflare Pages Functions |
| Analytics | Cloudflare Web Analytics |
| Font | DM Sans (Google Fonts) |

---

## Project Structure

```
/
├── home.html               # Landing page
├── login.html              # Login (customers, cashiers, head admins)
├── register.html           # Customer registration
├── setup-profile.html      # Post-registration profile completion
├── customer.html           # Customer shopping interface
├── profile.html            # Customer profile & order history
├── admin.html              # Cashier dashboard
├── head-admin.html         # Head admin dashboard
│
├── login.js                # Auth logic (3 Firebase projects)
├── register.js             # Account creation
├── profile.js              # Profile & purchase history
├── cart.js                 # Cart & Paystack checkout
├── firebase-config.js      # Firebase project configs & store helpers
├── notifications.js        # Toast notification system
├── utils.js                # Shared utility functions
│
├── functions/
│   ├── _firebase-rest.js   # Firebase REST API helper (no firebase-admin)
│   └── api/
│       ├── get-banks.js          # Fetch Nigerian banks from Paystack
│       ├── verify-account.js     # Resolve bank account holder name
│       ├── save-subaccount.js    # Create/update Paystack split subaccount
│       ├── create-head-admin.js  # Create head admin Firebase Auth account
│       ├── delete-head-admin.js  # Delete head admin account + Firestore docs
│       ├── delete-cashier.js     # Delete cashier account + Firestore docs
│       └── delete-store.js       # Delete all data for a store across projects
│
├── _redirects              # Cloudflare redirect rules (/ → home.html)
└── wrangler.toml           # Cloudflare Pages config
```

---

## Firebase Architecture

The app uses **three separate Firebase projects** to isolate access by role:

| Project | Name | Used For |
|---|---|---|
| Customer | `cloexlogin-d466a` | Customer accounts, products, purchases, categories |
| Admin | `cloexadminlogin` | Cashier accounts, product logs |
| Head Admin | `cloex-managerpage` | Head admin accounts, store config, transfer settings |

### Firestore Data Structure

```
# Customer project
users/{uid}                        # Customer profiles
stores/{storeId}/products/{id}
stores/{storeId}/purchases/{id}
stores/{storeId}/categories/list
stores/{storeId}/reservations/{id}

# Admin project
cashiers/{uid}                     # Cashier profiles (includes storeId)
stores/{storeId}/product_logs/{id}

# Head Admin project
admins/{uid}                       # Role doc: { role, storeId? }
headAdmins/{uid}                   # Profile doc: { name, email }
transferSettings/stores            # Paystack subaccount codes per store
storeConfig/list                   # Store list and metadata
```

---

## Environment Variables

Set these in **Cloudflare Dashboard → Pages → Settings → Environment Variables**:

| Variable | Description |
|---|---|
| `PAYSTACK_SECRET_KEY` | Paystack live secret key (`sk_live_...`) |
| `FIREBASE_CUSTOMER_SERVICE_ACCOUNT` | Service account JSON for the customer Firebase project |
| `FIREBASE_ADMIN_SERVICE_ACCOUNT` | Service account JSON for the admin Firebase project |
| `FIREBASE_HEAD_ADMIN_SERVICE_ACCOUNT` | Service account JSON for the head admin Firebase project |

To get a service account JSON: Firebase Console → your project → Project Settings → Service Accounts → Generate new private key.

---

## Local Development

No build step required. Open any HTML file directly in a browser, or use a simple local server:

```bash
npx serve .
```

---

## Deployment

The site auto-deploys to Cloudflare Pages on every push to `main`.

**Cloudflare Pages settings:**
- Build command: `npm install`
- Build output directory: `.`
- Compatibility date: `2024-09-23`
- Compatibility flags: `nodejs_compat`

---

## Payment Flow

1. Customer adds items to cart and proceeds to checkout
2. Paystack inline popup collects card details
3. On success, a purchase document is written to Firestore with status `pending`
4. A QR code is generated containing the purchase ID
5. Customer presents QR code at the store
6. Cashier scans/verifies the QR code and marks the order `ready`
7. Order is confirmed and marked `verified`

Payments use Paystack split subaccounts so funds are distributed automatically between the primary account and each store's bank account.

---

## License

Private — all rights reserved.
