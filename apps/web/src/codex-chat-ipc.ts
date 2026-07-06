import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

export const DEFAULT_CODEX_CHAT_IPC_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type CodexChatSetConfigResult =
  | { via: "ipc"; ok: true; restartRequired: boolean }
  | { via: "ipc"; ok: false; fieldErrors: Record<string, string> };

export type CodexChatIpcErrorKind = "UNAVAILABLE" | "FAILED";
export type CodexChatIpcErrorCode =
  | "TOKEN_UNAVAILABLE"
  | "TOKEN_READ_FAILED"
  | "TOKEN_INVALID"
  | "SOCKET_UNAVAILABLE"
  | "CONNECTION_ERROR"
  | "CONNECTION_CLOSED"
  | "TIMEOUT"
  | "IPC_REJECTED"
  | "AUTH_REJECTED"
  | "MALFORMED_RESPONSE";

export class CodexChatIpcError extends Error {
  constructor(
    readonly kind: CodexChatIpcErrorKind,
    readonly code: CodexChatIpcErrorCode,
    message: string,
    readonly cause?: unknown,
    readonly mayHaveApplied = false,
  ) {
    super(message);
    this.name = "CodexChatIpcError";
  }
}

export function isCodexChatIpcError(error: unknown): error is CodexChatIpcError {
  return error instanceof CodexChatIpcError;
}

export async function sendSetConfig(
  socketPath: string,
  entries: Record<string, string>,
  options: { timeoutMs?: number } = {},
): Promise<CodexChatSetConfigResult> {
  const token = await readIpcToken(socketPath);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CODEX_CHAT_IPC_TIMEOUT_MS);
  const requestLine = `${JSON.stringify({ type: "set_config", entries, token })}\n`;

  return new Promise<CodexChatSetConfigResult>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let connected = false;
    let requestLineWritten = false;
    let buffer = "";

    const timer = setTimeout(() => {
      fail(new CodexChatIpcError("FAILED", "TIMEOUT", "codex-chat IPC set_config timed out", undefined, requestLineWritten));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
    }

    function succeed(result: CodexChatSetConfigResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function fail(error: CodexChatIpcError): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    socket.once("connect", () => {
      connected = true;
      socket.write(requestLine, () => {
        requestLineWritten = true;
      });
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_RESPONSE_BYTES) {
        fail(new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC response was too large", undefined, requestLineWritten));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        succeed(parseSetConfigResponse(line, requestLineWritten));
      } catch (error) {
        fail(asIpcError(error, "MALFORMED_RESPONSE", "codex-chat IPC response was malformed", requestLineWritten));
      }
    });

    socket.once("error", (error) => {
      const code = errnoCode(error);
      if (!connected && (code === "ENOENT" || code === "ECONNREFUSED")) {
        fail(new CodexChatIpcError("UNAVAILABLE", "SOCKET_UNAVAILABLE", "codex-chat IPC socket is unavailable", error));
        return;
      }
      fail(new CodexChatIpcError("FAILED", "CONNECTION_ERROR", "codex-chat IPC connection failed", error, requestLineWritten));
    });

    socket.once("close", () => {
      fail(new CodexChatIpcError("FAILED", "CONNECTION_CLOSED", "codex-chat IPC connection closed before a response line", undefined, requestLineWritten));
    });
  });
}

async function readIpcToken(socketPath: string): Promise<string> {
  const tokenPath = join(dirname(socketPath), "ipc.token");
  let tokenText: string;
  try {
    tokenText = await readFile(tokenPath, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      throw new CodexChatIpcError("UNAVAILABLE", "TOKEN_UNAVAILABLE", "codex-chat IPC token file is unavailable", error);
    }
    throw new CodexChatIpcError("FAILED", "TOKEN_READ_FAILED", "codex-chat IPC token file could not be read", error);
  }
  const token = tokenText.trim();
  if (!token) throw new CodexChatIpcError("FAILED", "TOKEN_INVALID", "codex-chat IPC token file is empty");
  return token;
}

function parseSetConfigResponse(line: string, requestLineWritten: boolean): CodexChatSetConfigResult {
  if (!line) throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC response was empty", undefined, requestLineWritten);
  const parsed = parseJsonObject(line, requestLineWritten);
  if (parsed.ok === false) {
    const message = typeof parsed.error === "string" ? parsed.error : "";
    const responseCode = typeof parsed.code === "string" ? parsed.code : "";
    const unauthorized = responseCode === "unauthorized" || message.toLowerCase().includes("unauthorized");
    throw new CodexChatIpcError(
      "FAILED",
      unauthorized ? "AUTH_REJECTED" : "IPC_REJECTED",
      unauthorized ? "codex-chat IPC authorization failed" : "codex-chat IPC request was rejected",
    );
  }
  if (parsed.ok !== true) throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC response missing ok flag", undefined, requestLineWritten);

  const result = parsed.result;
  if (!isRecord(result)) throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC response missing result", undefined, requestLineWritten);
  if (result.ok === true) {
    return { via: "ipc", ok: true, restartRequired: result.restartRequired === true };
  }
  if (result.ok === false) {
    return { via: "ipc", ok: false, fieldErrors: parseFieldErrors(result.fieldErrors, requestLineWritten) };
  }
  throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC result missing ok flag", undefined, requestLineWritten);
}

function parseJsonObject(line: string, requestLineWritten: boolean): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC response was not JSON", error, requestLineWritten);
  }
  if (!isRecord(parsed)) throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC response was not an object", undefined, requestLineWritten);
  return parsed;
}

function parseFieldErrors(value: unknown, requestLineWritten: boolean): Record<string, string> {
  if (!isRecord(value)) throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC validation response missing field errors", undefined, requestLineWritten);
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(value)) {
    if (typeof message !== "string") {
      throw new CodexChatIpcError("FAILED", "MALFORMED_RESPONSE", "codex-chat IPC field error was malformed", undefined, requestLineWritten);
    }
    out[key] = message;
  }
  return out;
}

function asIpcError(error: unknown, code: CodexChatIpcErrorCode, message: string, mayHaveApplied: boolean): CodexChatIpcError {
  if (error instanceof CodexChatIpcError) return error;
  return new CodexChatIpcError("FAILED", code, message, error, mayHaveApplied);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}
