import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AccessDenied } from "./components/Auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Loading } from "./components/common";
import { useStatus } from "./lib/queries";
import { ApiError } from "./lib/api";
import { Home } from "./routes/Home";
import { Settings } from "./routes/Settings";
import { Setup } from "./routes/Setup";
import { Users } from "./routes/Users";
import { Operations } from "./routes/Operations";

// The status endpoint is the first gated call every session makes, so it
// doubles as the access gate: an auth/forbidden result means the server
// allowlist rejected this account and we render access-denied instead of the
// console. All other states render the shell (routes handle their own errors).
function AccessGate({ children }: { children: React.ReactNode }) {
  const status = useStatus();
  if (status.isError && status.error instanceof ApiError && (status.error.kind === "forbidden" || status.error.kind === "auth")) {
    return <AccessDenied reason={status.error.code} />;
  }
  if (status.isLoading) return <Loading label="Loading console…" />;
  return <>{children}</>;
}

export function App() {
  return (
    <AccessGate>
      <AppShell>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/users" element={<Users />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </AppShell>
    </AccessGate>
  );
}
