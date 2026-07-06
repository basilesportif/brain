// Capability-mutation action helpers for the Users route (plan §5.4, §6.5).
//
// Every grant/revoke/unlink is preceded by a server-computed impact preview
// (?preview=true) shown in the confirm dialog, including its previewCaveat. The
// client renders these server decisions — it never computes authorization and
// never resolves grant ids itself. Revocation acts on the EXACT grant ids the
// /users response carries (per group and per capability), via one atomic batch
// revoke, so it can never miss a secondary-subject or selector-scoped grant.
//
// STORE PINNING (§6.5, A3): each preview returns the storeHash it was computed
// against; the matching commit sends that hash so the server 409s
// (store_conflict) if the store changed between preview and commit — the dialog
// then re-previews rather than committing against a moved target.

import { useCallback, useMemo } from "react";
import { useGrant, useRevokeBatch, useUnlink } from "../../lib/queries";
import type { ImpactPreview, UserSummary } from "../../api-types";

export interface PreviewResult {
  impact: ImpactPreview;
  storeHash: string;
}

export interface CapabilityActions {
  previewGrant: (target: string, isGroup: boolean, selectors?: Record<string, string>) => Promise<PreviewResult>;
  commitGrant: (target: string, isGroup: boolean, expectedStoreHash: string, selectors?: Record<string, string>) => Promise<void>;
  previewRevoke: (grantIds: string[]) => Promise<PreviewResult>;
  commitRevoke: (grantIds: string[], expectedStoreHash: string) => Promise<void>;
  previewUnlink: (identityId: string) => Promise<PreviewResult>;
  commitUnlink: (identityId: string, expectedStoreHash: string) => Promise<void>;
}

export function useCapabilityActions(user: UserSummary): CapabilityActions {
  const grant = useGrant();
  const revoke = useRevokeBatch();
  const unlink = useUnlink();

  const previewGrant = useCallback(
    async (target: string, isGroup: boolean, selectors?: Record<string, string>): Promise<PreviewResult> => {
      const result = await grant.mutateAsync({ personId: user.id, target, isGroup, selectors, preview: true });
      return { impact: result.impact, storeHash: result.storeHash };
    },
    [grant, user.id],
  );
  const commitGrant = useCallback(
    async (target: string, isGroup: boolean, expectedStoreHash: string, selectors?: Record<string, string>) => {
      await grant.mutateAsync({ personId: user.id, target, isGroup, selectors, expectedStoreHash });
    },
    [grant, user.id],
  );

  const previewRevoke = useCallback(
    async (grantIds: string[]): Promise<PreviewResult> => {
      const result = await revoke.mutateAsync({ personId: user.id, grantIds, preview: true });
      return { impact: result.impact, storeHash: result.storeHash };
    },
    [revoke, user.id],
  );
  const commitRevoke = useCallback(
    async (grantIds: string[], expectedStoreHash: string) => {
      await revoke.mutateAsync({ personId: user.id, grantIds, expectedStoreHash });
    },
    [revoke, user.id],
  );

  const previewUnlink = useCallback(
    async (identityId: string): Promise<PreviewResult> => {
      const result = await unlink.mutateAsync({ personId: user.id, identityId, preview: true });
      return { impact: result.impact, storeHash: result.storeHash };
    },
    [unlink, user.id],
  );
  const commitUnlink = useCallback(
    async (identityId: string, expectedStoreHash: string) => {
      await unlink.mutateAsync({ personId: user.id, identityId, expectedStoreHash });
    },
    [unlink, user.id],
  );

  return useMemo(
    () => ({ previewGrant, commitGrant, previewRevoke, commitRevoke, previewUnlink, commitUnlink }),
    [previewGrant, commitGrant, previewRevoke, commitRevoke, previewUnlink, commitUnlink],
  );
}
