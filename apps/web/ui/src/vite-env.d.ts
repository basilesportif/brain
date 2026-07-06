/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_BRAIN_ADMIN_ROUTE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected into the SPA shell at serve time by admin-service.ts (non-secret).
interface BrainUiConfig {
  clerkPublishableKey: string;
  routePath: string;
  signInUrl: string;
}

interface Window {
  __BRAIN_UI_CONFIG__?: BrainUiConfig;
}
