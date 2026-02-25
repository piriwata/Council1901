# Council1901
Council1901 is a lightweight web chat that enables secret bilateral and multilateral negotiations between countries in a Diplomacy game.

## Local development

### Backend (Cloudflare Worker — Rust + WASM)

**Prerequisites (one-time setup):**
```bash
# Install Rust WASM target
rustup target add wasm32-unknown-unknown

# Install worker-build (Rust → WASM build tool)
cargo install worker-build
```

**Start the dev server:**
```bash
cd backend
npm install                   # installs wrangler

# Create local secrets file (never commit this)
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set a random value for HMAC_SECRET

npm run dev                   # runs: wrangler dev
# Worker is now available at http://localhost:8787
```

`wrangler dev` uses a local KV store automatically — no Cloudflare account needed for development.

### Frontend (Astro static site)

```bash
cd frontend
npm install
npm run dev        # Astro dev server at http://localhost:4320
                   # /api/* is proxied to http://localhost:8787
```

Run backend and frontend simultaneously for full local development.

### E2E tests (Playwright)

```bash
cd frontend
npm test           # builds static site and runs Playwright tests (API calls are mocked)
```

## Deployment

```bash
# Backend
cd backend
npm run build      # compiles Rust → WASM (requires worker-build)
npx wrangler deploy

# Set the HMAC secret in production
npx wrangler secret put HMAC_SECRET

# Frontend
cd frontend
npm run build      # outputs to dist/
# Deploy dist/ to any static host (Cloudflare Pages, etc.)
```
