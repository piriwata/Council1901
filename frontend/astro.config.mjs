import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  vite: {
    server: {
      proxy: {
        // Proxy API calls to the Cloudflare Worker during development
        // Run `wrangler dev` in the backend directory first (default port 8787)
        '/api': 'http://localhost:8787',
      },
    },
  },
});
