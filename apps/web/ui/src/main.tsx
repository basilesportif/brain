import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ClerkProvider, SignedIn, SignedOut } from "@clerk/clerk-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { SignInScreen } from "./components/Auth";
import { DebugProvider } from "./lib/debug";
import { ROUTER_BASENAME, readUiConfig } from "./config";
import "./styles.css";

const config = readUiConfig();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Never retry auth/forbidden/validation — retrying can't change a
        // server verdict. Retry transient errors a couple of times.
        const kind = (error as { kind?: string })?.kind;
        if (kind === "auth" || kind === "forbidden" || kind === "validation") return false;
        return failureCount < 2;
      },
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

function Root() {
  if (!config.clerkPublishableKey) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Brain console not configured</h1>
          <p className="muted">
            No Clerk publishable key was provided. Set it in the Brain admin service environment (served via the SPA bootstrap config), then
            reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey} afterSignOutUrl={config.signInUrl}>
      <QueryClientProvider client={queryClient}>
        <DebugProvider>
          <SignedOut>
            <SignInScreen />
          </SignedOut>
          <SignedIn>
            <BrowserRouter basename={ROUTER_BASENAME}>
              <App />
            </BrowserRouter>
          </SignedIn>
        </DebugProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
