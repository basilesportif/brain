/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected into the SPA shell at serve time by admin-service.ts (non-secret).
interface BrainUiConfig {
  clerkPublishableKey: string;
  signInUrl: string;
}

interface Window {
  __BRAIN_UI_CONFIG__?: BrainUiConfig;
}
