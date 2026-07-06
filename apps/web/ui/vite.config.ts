import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_ADMIN_ROUTE_PATH, normalizeAdminRoutePath } from "../src/admin-routes";

// The console is served under /admin by admin-service.ts, so assets must be
// requested with that base. In dev, proxy the Brain admin API to the local
// admin service (default port 49347) so `/api/admin/brain/*` calls work.
const ADMIN_SERVICE_ORIGIN = process.env.BRAIN_ADMIN_DEV_ORIGIN || "http://127.0.0.1:49347";
const ADMIN_ROUTE_PATH = normalizeAdminRoutePath(process.env.BRAIN_ADMIN_ROUTE_PATH, DEFAULT_ADMIN_ROUTE_PATH);

export default defineConfig({
  base: `${ADMIN_ROUTE_PATH}/`,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api/admin/brain": {
        target: ADMIN_SERVICE_ORIGIN,
        changeOrigin: true,
      },
    },
  },
});
