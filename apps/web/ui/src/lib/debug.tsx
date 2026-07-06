// Global Debug toggle (plan §4): persisted in localStorage, default off.
// When on, routes reveal raw-JSON links/panels. Wired into the app shell so
// every route can read it, even though only Home/Settings use it in slice 4a.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "brain-admin-debug";

interface DebugContextValue {
  debug: boolean;
  setDebug: (value: boolean) => void;
}

const DebugContext = createContext<DebugContextValue>({ debug: false, setDebug: () => {} });

function readInitial(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function DebugProvider({ children }: { children: ReactNode }) {
  const [debug, setDebugState] = useState<boolean>(readInitial);

  const setDebug = useCallback((value: boolean) => {
    setDebugState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Ignore storage failures (private mode); toggle still works in-session.
    }
  }, []);

  useEffect(() => {
    // Keep multiple tabs roughly in sync.
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setDebugState(event.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return <DebugContext.Provider value={{ debug, setDebug }}>{children}</DebugContext.Provider>;
}

export function useDebug(): DebugContextValue {
  return useContext(DebugContext);
}
