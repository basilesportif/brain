import { SignIn, SignOutButton, useUser } from "@clerk/clerk-react";

// Signed-out state: Clerk's hosted sign-in widget. `routing="hash"` keeps
// Clerk's internal navigation off the react-router history so it never fights
// the SPA routes.
export function SignInScreen() {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo" aria-hidden="true">
            B
          </span>
          <h1>Brain</h1>
        </div>
        <p className="muted">Sign in with an allowlisted account.</p>
        <SignIn routing="hash" />
      </div>
    </div>
  );
}

// Signed-in but the server allowlist rejected the request (fail-closed). The
// client never grants access; it only reports the server's decision and offers
// a way to switch accounts.
export function AccessDenied({ reason }: { reason?: string }) {
  const { user } = useUser();
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo" aria-hidden="true">
            B
          </span>
          <h1>Access denied</h1>
        </div>
        <p className="bad">This account is not authorized for the Brain admin console.</p>
        <p className="muted small">
          Signed in as <span className="mono">{user?.primaryEmailAddress?.emailAddress ?? "unknown account"}</span>. Access is enforced
          server-side and fails closed{reason ? ` (${reason})` : ""}.
        </p>
        <SignOutButton>
          <button className="btn primary" type="button">
            Sign out / switch account
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
