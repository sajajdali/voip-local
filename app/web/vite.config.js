import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.API_TARGET || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  // API_TARGET=https://192.168.89.50 runs the panel locally against the server's API (self-signed cert)
  server: { proxy: { '/api': { target: API, changeOrigin: true, secure: false }, '/socket.io': { target: API, ws: true, changeOrigin: true, secure: false } } },
  build: { chunkSizeWarningLimit: 2000 },
});
