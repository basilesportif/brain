export const DEFAULT_ADMIN_ROUTE_PATH = "/admin";
export const DEFAULT_ADMIN_V2_REDIRECT_ROUTE_PATH = "/admin-v2";

// Backward-compatible aliases for callers/tests that mean the default mount.
export const ADMIN_SPA_ROUTE_PATH = DEFAULT_ADMIN_ROUTE_PATH;
export const ADMIN_V2_REDIRECT_ROUTE_PATH = DEFAULT_ADMIN_V2_REDIRECT_ROUTE_PATH;

export function isPathAtMount(pathname: string, mountPath: string): boolean {
  return pathname === mountPath || pathname.startsWith(`${mountPath}/`);
}

export function normalizeAdminRoutePath(value: string | undefined, fallback = DEFAULT_ADMIN_ROUTE_PATH): string {
  const raw = value?.trim() || fallback;
  const out = (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "");
  return out || fallback;
}

export function redirectPathFromAdminV2(pathname: string, search: string, targetMountPath = DEFAULT_ADMIN_ROUTE_PATH): string {
  const suffix = pathname === DEFAULT_ADMIN_V2_REDIRECT_ROUTE_PATH ? "" : pathname.slice(DEFAULT_ADMIN_V2_REDIRECT_ROUTE_PATH.length);
  return `${targetMountPath}${suffix}${search}`;
}
