import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The console is served under /admin-v2 by admin-service.ts, so assets must be
// requested with that base. In dev, proxy the Brain admin API to the local
// admin service (default port 49347) so `/api/admin/brain/*` calls work.
const ADMIN_SERVICE_ORIGIN = process.env.BRAIN_ADMIN_DEV_ORIGIN || "http://127.0.0.1:49347";

export default defineConfig({
  base: "/admin-v2/",
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
