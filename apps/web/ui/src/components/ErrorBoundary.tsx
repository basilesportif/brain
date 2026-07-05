import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

// Route/render error boundary (plan §6.6). Catches render-time exceptions so a
// broken component degrades to a message instead of a blank page. Data-fetch
// errors are handled per-route via the API error taxonomy, not here.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for local debugging; no telemetry pipeline here.
    console.error("Brain console render error", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="route">
          <div className="alert bad" role="alert">
            <strong>{this.props.fallbackTitle ?? "Something went wrong"}</strong>
            <p className="muted small">{this.state.error.message}</p>
            <button className="btn ghost" type="button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
