import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);
const packageRoot = path.resolve(distRoot, "..");
const scriptsRoot = path.join(packageRoot, "scripts");


function runNode(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("server did not bind to tcp port"));
      else resolve(addr.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("vendored Composio command can run against a mock base URL without real credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-vendored-composio-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  let sawApiKey = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v3.1/auth_configs?limit=1000&show_disabled=true&toolkit_slug=gmail" && req.method === "GET") {
      sawApiKey = req.headers["x-api-key"] === "fake-composio-key";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [
        { id: "ac_gmail", name: "Gmail", toolkit: { slug: "gmail" }, auth_scheme: "OAUTH2", status: "ENABLED", created_at: "2026-05-26T00:00:00.000Z" },
      ] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const port = await listen(server);
    fs.writeFileSync(path.join(workspace, ".env"), `COMPOSIO_API_KEY=fake-composio-key\nCOMPOSIO_BASE_URL=http://127.0.0.1:${port}\n`);

    const result = await runNode([path.join(scriptsRoot, "composio-connect.js"), "--list-configs", "--app", "gmail"], {
      cwd: scriptsRoot,
      env: { ...process.env, ASSISTANT_WORKSPACE: workspace },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(sawApiKey, true);
    const parsed = JSON.parse(result.stdout) as Array<{ id: string; name: string; app: string; authScheme: string; status: string; createdAt: string }>;
    assert.deepEqual(parsed, [{ id: "ac_gmail", name: "Gmail", app: "gmail", authScheme: "OAUTH2", status: "ENABLED", createdAt: "2026-05-26T00:00:00.000Z" }]);
  } finally {
    await close(server).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
