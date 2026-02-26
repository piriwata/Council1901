# Council1901 — Agent Development Guide

This document summarises the repository structure, build commands, and development workflow for AI agent sessions.

---

## Repository layout

```
Council1901/
├── backend/          # Rust/WASM Cloudflare Worker (API server)
│   ├── src/lib.rs    # All API logic (single file)
│   ├── Cargo.toml    # Rust dependencies (worker 0.7, hmac, sha2, uuid, serde)
│   ├── wrangler.toml # Cloudflare Worker config
│   ├── package.json  # npm scripts: dev / build  (wrangler as devDep)
│   └── .dev.vars.example  # Template for local secrets
└── frontend/         # Astro static site (single-page app)
    ├── src/pages/index.astro  # Entire UI (HTML + CSS + inline JS)
    ├── playwright.config.ts   # Playwright config (builds + previews site)
    ├── tests/e2e.spec.ts      # 15 Playwright E2E tests (API calls mocked)
    └── package.json           # astro, @playwright/test
```

---

## Backend

### Tech stack
- Language: **Rust** (edition 2021), compiled to **WASM** via `worker-build`
- Runtime: **Cloudflare Workers** (`worker` crate ≥ 0.7)
- Storage: **Cloudflare KV** (binding name: `COUNCIL_KV`)
- Auth: HMAC-SHA256 bearer tokens (secret: `HMAC_SECRET` env var)

### One-time setup
```bash
# Add WASM compile target
rustup target add wasm32-unknown-unknown

# Install worker-build (Rust binary, NOT an npm package)
cargo install worker-build
```

### Local development with `wrangler dev`
```bash
cd backend
npm install                       # installs wrangler (npm package)
cp .dev.vars.example .dev.vars    # never commit .dev.vars
# Edit .dev.vars — set HMAC_SECRET to any random string, e.g.:
#   python3 -c "import secrets; print(secrets.token_hex(32))"
npm run dev                       # → http://localhost:8787
```

`wrangler dev` builds the WASM automatically, uses a **local KV store** (no Cloudflare account needed), and reloads on source changes.

### Verify / check compilation (no WASM build required)
```bash
cd backend
cargo check
```

### Build WASM artifact only
```bash
cd backend
npm run build     # runs: worker-build --release
```

### Deploy to Cloudflare
```bash
cd backend
npx wrangler deploy
npx wrangler secret put HMAC_SECRET   # set production secret
```

### KV namespace IDs
Replace the placeholder values in `wrangler.toml` with real namespace IDs from the Cloudflare dashboard:
```toml
[[kv_namespaces]]
binding = "COUNCIL_KV"
id = "<production-namespace-id>"
preview_id = "<preview-namespace-id>"
```

---

## Frontend

### Tech stack
- Framework: **Astro** (static output)
- UI: single `.astro` page with inline CSS and vanilla JS
- Tests: **Playwright** (Chromium, API calls mocked via `page.route()`)

### Development server
```bash
cd frontend
npm install
npm run dev       # Astro dev server at http://localhost:4321
                  # /api/* proxied to http://localhost:8787 (wrangler dev)
```

Run backend (`npm run dev`) and frontend (`npm run dev`) simultaneously for full end-to-end local development.

### Build static site
```bash
cd frontend
npm run build     # outputs to frontend/dist/
npm run preview   # serves dist/ at http://localhost:4321
```

### E2E tests (Playwright)
```bash
cd frontend
npm test          # starts wrangler dev (:8787) + astro dev (:4321), runs 13 tests
```

> **Important for agent sessions**: Always run the Playwright E2E tests (`cd frontend && npm test`) after making any changes to `frontend/src/pages/index.astro` or `frontend/tests/e2e.spec.ts`. CSS class names and DOM selectors used in tests must stay in sync with the UI code — if you remove or rename a CSS class that tests reference, update the tests accordingly.

Tests run against the **real backend** (`wrangler dev`) — no API mocks are used.
The Astro dev server proxies `/api/*` to `localhost:8787` automatically.
Playwright manages both server processes; pre-requisites:
- `rustup target add wasm32-unknown-unknown`
- `cargo install worker-build`
- `cd backend && npm install`

`backend/.dev.vars` is auto-created from `.dev.vars.example` if absent (any secret value works locally).

---

## API surface (backend endpoints)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth` | — | Issue access token for `(room_id, country)` |
| `GET` | `/api/conversations?room_id=…` | Bearer | List conversations where caller is a participant |
| `POST` | `/api/conversations` | Bearer | Create 2–3 participant conversation (idempotent) |
| `GET` | `/api/messages?conversation_id=…&since=…` | Bearer | Fetch messages after `since` ms timestamp |
| `POST` | `/api/messages` | Bearer | Send a message (max 4096 bytes) |

Token format: `{room_id}|{country}|HMAC-SHA256(secret, "room_id:country")`  
The token is parsed right-to-left so room IDs containing `|` are safe.

### KV key schema
```
room:{room_id}:conversations          → JSON string[]  (list of conv IDs)
conv:{conv_id}:meta                   → { room_id, participants[] }
conv:{conv_id}:msg:{ts:020}:{uuid}    → Message JSON
```

`conv_id = hex(SHA-256(room_id + ":" + sorted_participants.join(":"))[0..16])`  
Message keys use zero-padded 20-digit millisecond timestamps so lexicographic order = chronological order.

---

## Countries (valid values)
`england`, `france`, `germany`, `italy`, `austria`, `russia`, `turkey`

---

## Ignored paths (see `.gitignore`)
```
backend/target/       # Rust build cache
backend/build/        # WASM build output
backend/.wrangler/    # wrangler local state / KV
backend/node_modules/
backend/.dev.vars     # local secrets — NEVER commit
frontend/node_modules/
frontend/dist/
frontend/.astro/
frontend/playwright-report/
frontend/test-results/
```
