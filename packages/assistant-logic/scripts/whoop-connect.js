#!/usr/bin/env node
const crypto = require("crypto");
const http = require("http");
const { URL } = require("url");
const {
  WHOOP_AUTHORIZE_URL,
  WHOOP_SCOPES,
  exchangeAuthorizationCode,
  getWhoopConfig,
} = require("./lib/whoop-auth");

function parseArgs(argv) {
  const args = {
    mode: "localhost",
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mode":
        args.mode = argv[++i] || "";
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        console.error("Usage: node scripts/whoop-connect.js [--mode localhost|manual]");
        process.exit(1);
    }
  }

  if (!["localhost", "manual"].includes(args.mode)) {
    console.error(`Invalid mode: ${args.mode}`);
    console.error("Usage: node scripts/whoop-connect.js [--mode localhost|manual]");
    process.exit(1);
  }

  return args;
}

function buildAuthUrl(config, state) {
  const url = new URL(WHOOP_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", WHOOP_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

function promptForInput(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (chunk) => {
      cleanup();
      resolve(String(chunk || "").trim());
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    function cleanup() {
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
    }

    process.stdin.once("data", onData);
    process.stdin.once("error", onError);
  });
}

function extractAuthorizationFromInput(input) {
  if (!input) {
    throw new Error("No authorization code provided.");
  }

  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const redirectUrl = new URL(trimmed);
    const code = redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Redirect URL does not include a code parameter.");
    }
    return {
      code,
      state: redirectUrl.searchParams.get("state"),
    };
  }

  return {
    code: trimmed,
    state: null,
  };
}

async function runManualMode(config) {
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(config, state);
  console.log("Open this URL in your browser to authorize WHOOP:");
  console.log(authUrl);
  const input = await promptForInput(
    "\nPaste the full redirect URL or the authorization code: "
  );
  const authorization = extractAuthorizationFromInput(input);
  if (authorization.state && authorization.state !== state) {
    throw new Error("WHOOP OAuth state mismatch.");
  }
  await exchangeAuthorizationCode(authorization.code, { config });
  console.log("WHOOP connection saved successfully.");
}

async function runLocalhostMode(config) {
  const redirectUrl = new URL(config.redirectUri);
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(config, state);
  const timeoutMs = 120000;

  if (redirectUrl.hostname !== "localhost" && redirectUrl.hostname !== "127.0.0.1") {
    throw new Error(
      `Localhost mode requires WHOOP_REDIRECT_URI to use localhost or 127.0.0.1. Current value: ${config.redirectUri}`
    );
  }

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close(() => {
        reject(new Error("Timed out waiting for WHOOP OAuth callback after 120 seconds."));
      });
    }, timeoutMs);

    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url, config.redirectUri);
        if (requestUrl.pathname !== redirectUrl.pathname) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code");
        const returnedState = requestUrl.searchParams.get("state");
        const error = requestUrl.searchParams.get("error");

        if (error) {
          res.statusCode = 400;
          res.end("WHOOP authorization failed. You can close this window.");
          clearTimeout(timeout);
          server.close(() => reject(new Error(`WHOOP authorization error: ${error}`)));
          return;
        }

        if (!code) {
          res.statusCode = 400;
          res.end("Missing authorization code. You can close this window.");
          return;
        }

        if (returnedState !== state) {
          res.statusCode = 400;
          res.end("State validation failed. You can close this window.");
          clearTimeout(timeout);
          server.close(() => reject(new Error("WHOOP OAuth state mismatch.")));
          return;
        }

        await exchangeAuthorizationCode(code, { config });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("WHOOP authorization completed. You can close this window.");
        clearTimeout(timeout);
        server.close(() => resolve({ ok: true }));
      } catch (error) {
        res.statusCode = 500;
        res.end("WHOOP authorization failed. You can close this window.");
        clearTimeout(timeout);
        server.close(() => reject(error));
      }
    });

    server.listen(Number(redirectUrl.port) || 80, redirectUrl.hostname, () => {
      console.log("Open this URL in your browser to authorize WHOOP:");
      console.log(authUrl);
      console.log(
        `Waiting for callback on ${redirectUrl.hostname}:${redirectUrl.port || "80"}${redirectUrl.pathname} ...`
      );
    });

    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  if (result?.ok) {
    console.log("WHOOP connection saved successfully.");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = getWhoopConfig({
    processEnv: {
      ...process.env,
      WHOOP_REDIRECT_URI:
        process.env.WHOOP_REDIRECT_URI || "http://localhost:8787/callback",
    },
  });

  if (args.mode === "manual") {
    await runManualMode(config);
    return;
  }

  await runLocalhostMode(config);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
