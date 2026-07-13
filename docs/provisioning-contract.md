# Provisioning path, socket, and capability-store contract

Brain provisions a servant instance from resolved setup/deployment metadata and
repo-registry entries. Host paths are outputs of that resolution; they are not
maintainer-specific constants.

## Instance identity and roots

The production service user is the deployment environment's
`deploy.runtime_user`, falling back to Brain's existing default, `brain`. The
saved setup-context `serviceUser` supplies that value when deployment metadata
is prepared. Brain's conventional remote defaults derive that user's home as
`/home/<service-user>` (or `/root` for root), the
Brain checkout as `<service-home>/brain`, and the personal workspace as
`<service-home>/.brain/workspace`. With the default user these resolve to
`/home/brain/brain` and `/home/brain/.brain/workspace`; an operator-selected
user or path replaces those defaults.

The `codex-chat` and `assistant-agent-logic` checkouts come from their resolved
repo-registry source/deploy records. The assistant workspace comes from the
saved setup context or resolved `assistant-agent-data` workspace record. Neither
checkout is copied into Brain.

## Canonical runtime contract

The instance control-plane directory is
`<service-home>/.brain/control-plane`. Its canonical capability store is
`<service-home>/.brain/control-plane/capabilities.json`. The service home is
derived from the effective deployment service user above, so a deployment for
another owner retains that owner's paths.

`codex-chat` receives this path as `[brain].storePath` and runs with
`[brain].enforcementEnabled = true`. Brain admin must receive the same value as
`BRAIN_CAPABILITY_STORE_PATH`, and the agent-logic capability gate must use the
same store through the `codex-chat` enforcement path. Brain admin currently
defaults the store to `capabilities.json` beside `BRAIN_ADMIN_AUDIT_LOG`; an
admin env renderer must therefore set `BRAIN_CAPABILITY_STORE_PATH` explicitly
(and normally keep the audit log in the same control-plane directory) rather
than depend on an owner-specific fallback.

The canonical IPC socket is
`<assistant-workspace>/state/run/codex-chat.sock`. The `codex-chat` service
config writes that path as `[service].ipcSocket`. Its service environment must
set `BRAIN_IPC_SOCKET` to the same path for injection into
`assistant-agent-logic`; Brain admin's environment must set
`BRAIN_CODEX_CHAT_IPC_SOCKET` to that path. The deployment record exposes both
the socket and capability-store paths for the admin env renderer.

The self-locating `codex-chat` config also sets `[paths].logicRepo` to the
resolved `assistant-agent-logic` checkout and `[paths].assistantWorkspace` to
the resolved workspace root.

| Value | Source of truth | Consumers |
| --- | --- | --- |
| Service user/home | Deployment `runtime_user`, prepared from saved setup service user; existing `brain` default | systemd, control-plane path derivation |
| Brain, `codex-chat`, and logic checkouts | Setup context plus resolved repo-registry source/deploy records | Brain control plane, systemd, `[paths].logicRepo`, Codex `addDirs` |
| Assistant workspace | Saved setup `workspaceRoot` or resolved assistant-data workspace | `[service].workspace`, `[paths].assistantWorkspace`, runtime state/artifacts |
| Capability store | `<effective-service-home>/.brain/control-plane/capabilities.json` | `[brain].storePath`, Brain admin `BRAIN_CAPABILITY_STORE_PATH`, capability gate |
| IPC socket | `<assistant-workspace>/state/run/codex-chat.sock` | `[service].ipcSocket`, agent logic `BRAIN_IPC_SOCKET`, Brain admin `BRAIN_CODEX_CHAT_IPC_SOCKET` |
| Enforcement | Production renderer constant `true` | `[brain].enforcementEnabled`, `codex-chat` capability gate |
