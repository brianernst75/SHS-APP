# SHS Drug Search — CMS PUF Integration

## What This Does
Native in-app drug formulary search using CMS public data.
No carrier API registrations needed. Covers all plans.

## Files
- `import-cms-puf.js`     — One-time + monthly import script
- `drug-search-routes.js` — API route handlers (add to server.js)
- `drug-screen.html`      — Drop-in UI screen (add to client.html)
- `server-integration.js` — Exact integration snippets for server.js

## MongoDB Collections Created
- `formulary`      — Drug records (~5-10M documents, indexed)
- `puf_metadata`   — Tracks last import date + source URL

## Setup Steps

### 1. Install dependency
```
npm install node-cron
```

### 2. Run initial import (do this once from Railway shell or local)
```
MONGODB_URI=... node import-cms-puf.js
```

### 3. Add routes to server.js
See server-integration.js — copy the 4 blocks into server.js

### 4. Add drug screen to client.html
- Copy drug-screen.html into your screen section
- In your showScreen('drugs') function, call: initDrugScreen(clientData.mapd_plan_number)
- Remove the old "opens q1medicare" button handler

### 5. Manual refresh via admin
```
POST https://shs-app-production.up.railway.app/admin/refresh-formulary?pw=shs2026
```

## Data Fields Available Per Drug
- Drug name, NDC, RxCUI
- Tier (1-5) with label
- Prior authorization required (Y/N)
- Step therapy required (Y/N)  
- Quantity limits (Y/N)
- IRA selected drug flag (negotiated price)
- Preferred retail copay / coinsurance
- Standard retail copay / coinsurance
- Mail order copay / coinsurance

## CMS Source
Monthly PUF from data.cms.gov — same source as Medicare.gov Plan Finder.
Next release: ~Sept 23, 2026 (then Oct 15 with 2027 plan year data).

## Notes
- Initial import takes ~20-30 min (large files, millions of drug records)
- MongoDB index makes searches fast (<100ms) after import
- Plan key format: "H0609-073" (contract_id + 3-digit plan_id)
- The formulary collection is dropped and re-created each month (clean import)
