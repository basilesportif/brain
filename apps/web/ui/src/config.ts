// Runtime bootstrap config. The Clerk publishable key is injected into the SPA
// shell by admin-service.ts (`window.__BRAIN_UI_CONFIG__`) so it can change
// without rebuilding the bundle. In `vite dev` there is no injection, so we fall
// back to VITE_CLERK_PUBLISHABLE_KEY from the environment.
import { DEFAULT_ADMIN_ROUTE_PATH, normalizeAdminRoutePath } from "../../src/admin-routes";

export interface UiConfig {
  clerkPublishableKey: string;
  routePath: string;
  signInUrl: string;
}

export function readUiConfig(): UiConfig {
  const injected = typeof window !== "undefined" ? window.__BRAIN_UI_CONFIG__ : undefined;
  const routePath = normalizeAdminRoutePath(injected?.routePath || import.meta.env.VITE_BRAIN_ADMIN_ROUTE_PATH, DEFAULT_ADMIN_ROUTE_PATH);
  return {
    clerkPublishableKey: injected?.clerkPublishableKey || import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "",
    routePath,
    signInUrl: injected?.signInUrl || routePath,
  };
}
