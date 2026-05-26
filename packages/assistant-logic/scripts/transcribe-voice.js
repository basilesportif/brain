#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");
const { loadWorkspaceEnv, requireEnv } = require("./lib/runtime-env");

function parseArgs(argv) {
  const args = { filePath: null };

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--file") {
      args.filePath = argv[++i];
    } else if (!args.filePath && !argv[i].startsWith("--")) {
      args.filePath = argv[i];
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      console.error("Usage: node scripts/transcribe-voice.js [--file] <path-to-ogg>");
      process.exit(1);
    }
  }

  if (!args.filePath) {
    console.error("Error: file path is required");
    console.error("Usage: node scripts/transcribe-voice.js [--file] <path-to-ogg>");
    process.exit(1);
  }

  return args;
}

function transcribe(filePath, apiKey) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      return reject(new Error(`File not found: ${resolvedPath}`));
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    // Telegram voice notes use .oga extension which OpenAI rejects — rename to .ogg
    let fileName = path.basename(resolvedPath);
    if (fileName.endsWith(".oga")) {
      fileName = fileName.replace(/\.oga$/, ".ogg");
    }

    // Build multipart/form-data body
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const parts = [];

    // model field
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `gpt-4o-transcribe\r\n`
    );

    // file field
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: audio/ogg\r\n\r\n`
    );

    const header = Buffer.from(parts.join(""), "utf-8");
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
    const body = Buffer.concat([header, fileBuffer, footer]);

    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `OpenAI API error (${res.statusCode}): ${responseBody}`
            )
          );
        }
        try {
          const json = JSON.parse(responseBody);
          resolve(json.text || "");
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${responseBody}`));
        }
      });
    });

    req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const { env } = loadWorkspaceEnv();
  const apiKey = requireEnv(
    env,
    "OPENAI_API_KEY",
    "OPENAI_API_KEY not set. Add it to workspace/.env or export it in the shell."
  );

  const text = await transcribe(args.filePath, apiKey);
  console.log(text);

  // Clean up the audio file after successful transcription
  try {
    fs.unlinkSync(path.resolve(args.filePath));
  } catch (_) {
    // Ignore cleanup errors
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
