// Runtime bootstrap config. The Clerk publishable key is injected into the SPA
// shell by admin-service.ts (`window.__BRAIN_UI_CONFIG__`) so it can change
// without rebuilding the bundle. In `vite dev` there is no injection, so we fall
// back to VITE_CLERK_PUBLISHABLE_KEY from the environment.

export interface UiConfig {
  clerkPublishableKey: string;
  signInUrl: string;
}

export function readUiConfig(): UiConfig {
  const injected = typeof window !== "undefined" ? window.__BRAIN_UI_CONFIG__ : undefined;
  return {
    clerkPublishableKey: injected?.clerkPublishableKey || import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "",
    signInUrl: injected?.signInUrl || "/admin-v2",
  };
}

// The app is mounted under /admin-v2 (see admin-service.ts static handler).
export const ROUTER_BASENAME = "/admin-v2";
