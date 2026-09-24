import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :8000 (see README); Vite proxies to it.
const backend = process.env.ALLOGATOR_BACKEND ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': backend, '/ical': backend },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
