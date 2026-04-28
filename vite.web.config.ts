import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Builds the bot dashboard UI.
//   Source: src/web/
//   Output: dist/web/
//   Served by: src/bot/http-server.ts at WEB_DIR
//
// Dev: npx vite --config vite.web.config.ts (proxies /api to local bot)

export default defineConfig({
  root: path.resolve(__dirname, "src/web"),
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/web"),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, "src/web/index.html") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/ready": "http://localhost:3000",
    },
  },
});
