import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.CABO_SERVER ?? 'http://localhost:3101';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/socket.io': { target: server, ws: true },
    },
  },
});
