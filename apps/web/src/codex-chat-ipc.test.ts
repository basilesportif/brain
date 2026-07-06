import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeIpcToken, startFakeCodexChatIpc, type FakeCodexChatIpcServer } from "./codex-chat-ipc.test-helpers.js";
import { CodexChatIpcError, sendSetConfig } from "./codex-chat-ipc.js";

test("sendSetConfig sends one authenticated line and returns restart metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-success-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    ipc = await startFakeCodexChatIpc(root);
    const result = await sendSetConfig(ipc.socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 500 });
    assert.deepEqual(result, { via: "ipc", ok: true, restartRequired: true });
    assert.deepEqual(ipc.requests, [{ type: "set_config", keys: ["CODEX_CHAT_BASE_URL"], brainSubjectIdPresent: false }]);
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSetConfig returns codex-chat field errors without falling back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-fields-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    ipc = await startFakeCodexChatIpc(root, {
      response: { ok: true, result: { ok: false, fieldErrors: { CODEX_CHAT_BASE_URL: "unknown configuration key" } } },
    });
    const result = await sendSetConfig(ipc.socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 500 });
    assert.deepEqual(result, { via: "ipc", ok: false, fieldErrors: { CODEX_CHAT_BASE_URL: "unknown configuration key" } });
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSetConfig treats wrong-token rejection as a failed IPC write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-auth-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    ipc = await startFakeCodexChatIpc(root, { expectedToken: fakeIpcToken("server") });
    await assert.rejects(
      sendSetConfig(ipc.socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 500 }),
      (error) => {
        assert.ok(error instanceof CodexChatIpcError);
        assert.equal(error.kind, "FAILED");
        assert.equal(error.code, "AUTH_REJECTED");
        assert.equal(error.mayHaveApplied, false);
        return true;
      },
    );
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSetConfig times out when codex-chat never replies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-timeout-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    ipc = await startFakeCodexChatIpc(root, { withholdResponse: true });
    await assert.rejects(
      sendSetConfig(ipc.socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 50 }),
      (error) => {
        assert.ok(error instanceof CodexChatIpcError);
        assert.equal(error.kind, "FAILED");
        assert.equal(error.code, "TIMEOUT");
        assert.equal(error.mayHaveApplied, true);
        return true;
      },
    );
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSetConfig marks connection loss after the request line as possibly applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-close-"));
  let ipc: FakeCodexChatIpcServer | undefined;
  try {
    ipc = await startFakeCodexChatIpc(root, { destroyAfterRead: true });
    await assert.rejects(
      sendSetConfig(ipc.socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 500 }),
      (error) => {
        assert.ok(error instanceof CodexChatIpcError);
        assert.equal(error.kind, "FAILED");
        assert.equal(error.code, "CONNECTION_CLOSED");
        assert.equal(error.mayHaveApplied, true);
        return true;
      },
    );
  } finally {
    if (ipc) await ipc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSetConfig marks pre-write socket unavailability as not applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-unavailable-"));
  try {
    const runDir = path.join(root, "codex-chat", "data", "run");
    const socketPath = path.join(runDir, "codex-chat.sock");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "ipc.token"), `${fakeIpcToken("client")}\n`, { mode: 0o600 });
    await assert.rejects(
      sendSetConfig(socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 50 }),
      (error) => {
        assert.ok(error instanceof CodexChatIpcError);
        assert.equal(error.kind, "UNAVAILABLE");
        assert.equal(error.code, "SOCKET_UNAVAILABLE");
        assert.equal(error.mayHaveApplied, false);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sendSetConfig reports a missing IPC token file as unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-ipc-client-token-"));
  try {
    const socketPath = path.join(root, "run", "codex-chat.sock");
    await assert.rejects(
      sendSetConfig(socketPath, { CODEX_CHAT_BASE_URL: "https://brain.example.com" }, { timeoutMs: 50 }),
      (error) => {
        assert.ok(error instanceof CodexChatIpcError);
        assert.equal(error.kind, "UNAVAILABLE");
        assert.equal(error.code, "TOKEN_UNAVAILABLE");
        assert.equal(error.mayHaveApplied, false);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
