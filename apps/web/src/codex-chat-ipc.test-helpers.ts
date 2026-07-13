import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { writeMergedEnvFile } from "./env-file.js";

export interface FakeCodexChatIpcRequest {
  type: unknown;
  keys: string[];
  brainSubjectIdPresent: boolean;
}

export interface FakeCodexChatIpcServer {
  socketPath: string;
  requests: FakeCodexChatIpcRequest[];
  close: () => Promise<void>;
}

export interface FakeCodexChatIpcOptions {
  clientToken?: string;
  expectedToken?: string;
  persistEnvFile?: string;
  fieldErrors?: Record<string, string>;
  capabilityRegistry?: Record<string, unknown>;
  capabilityCheck?: (message: Record<string, unknown>) => { allowed: boolean; reason: string };
  responseDelayMs?: number;
  response?: Record<string, unknown>;
  withholdResponse?: boolean;
  destroyAfterRead?: boolean;
}

export async function startFakeCodexChatIpc(root: string, options: FakeCodexChatIpcOptions = {}): Promise<FakeCodexChatIpcServer> {
  const runDir = path.join(root, "codex-chat", "data", "run");
  const socketPath = path.join(runDir, "codex-chat.sock");
  const clientToken = options.clientToken ?? fakeIpcToken("client");
  const expectedToken = options.expectedToken ?? clientToken;
  const requests: FakeCodexChatIpcRequest[] = [];
  const sockets = new Set<Socket>();
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "ipc.token"), `${clientToken}\n`, { mode: 0o600 });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      void handleFakeIpcLine(socket, line, expectedToken, requests, options).catch(() => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: false, error: "invalid IPC message" })}\n`);
      });
    });
  });
  await listenUnixServer(server, socketPath);
  return {
    socketPath,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function fakeIpcToken(kind: "client" | "server"): string {
  return (kind === "client" ? "a" : "b").repeat(64);
}

async function handleFakeIpcLine(
  socket: Socket,
  line: string,
  expectedToken: string,
  requests: FakeCodexChatIpcRequest[],
  options: FakeCodexChatIpcOptions,
): Promise<void> {
  const message = JSON.parse(line) as Record<string, unknown>;
  const entries = isRecord(message.entries) ? stringEntries(message.entries) : {};
  requests.push({ type: message.type, keys: Object.keys(entries), brainSubjectIdPresent: Object.prototype.hasOwnProperty.call(message, "brainSubjectId") });
  if (message.type === "get_capability_registry") {
    if (options.destroyAfterRead) {
      setTimeout(() => socket.destroy(), 5);
      return;
    }
    if (options.withholdResponse) return;
    if (options.responseDelayMs) await delay(options.responseDelayMs);
    socket.write(`${JSON.stringify({ ok: true, result: options.capabilityRegistry ?? { registryVersion: 1, capabilities: [] } })}\n`);
    return;
  }
  if (message.type === "check_capability") {
    if (options.destroyAfterRead) {
      setTimeout(() => socket.destroy(), 5);
      return;
    }
    if (options.withholdResponse) return;
    if (options.responseDelayMs) await delay(options.responseDelayMs);
    const result = options.capabilityCheck?.(message) ?? { allowed: false, reason: "actor_not_linked_to_brain_subject" };
    socket.write(`${JSON.stringify({ ok: true, result })}\n`);
    return;
  }
  if (message.token !== expectedToken) {
    socket.write(`${JSON.stringify({ ok: false, error: "unauthorized: valid IPC token required", code: "unauthorized" })}\n`);
    return;
  }
  if (options.destroyAfterRead) {
    setTimeout(() => socket.destroy(), 5);
    return;
  }
  if (options.withholdResponse) return;
  if (options.fieldErrors) {
    socket.write(`${JSON.stringify({ ok: true, result: { ok: false, fieldErrors: options.fieldErrors } })}\n`);
    return;
  }
  if (options.persistEnvFile) await writeMergedEnvFile(options.persistEnvFile, entries, "fake codex-chat IPC test server");
  socket.write(`${JSON.stringify(options.response ?? { ok: true, result: { ok: true, restartRequired: true } })}\n`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stringEntries(entries: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) if (typeof value === "string") out[key] = value;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function listenUnixServer(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
