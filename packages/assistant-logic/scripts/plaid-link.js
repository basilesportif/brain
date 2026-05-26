#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  loadPlaidConfig,
  createLinkToken,
  exchangePublicToken,
  removeItem,
} = require("./lib/finance-providers/plaid");
const { getWorkspaceContext, getWorkspacePaths } = require("./lib/workspace");
const {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  getSourcesPath,
} = require("./lib/finance-sources");

function usage() {
  console.error(
    "Usage: node plaid-link.js <command>\n" +
      "Commands:\n" +
      "  --create-link-token              Generate a Plaid Link token and HTML file\n" +
      '  --exchange <token> [--label <l>]  Exchange a public token for an access token\n' +
      "  --list-items                      Show configured Plaid items\n" +
      "  --remove-item <source_id>         Remove a Plaid item by source ID or legacy index"
  );
  process.exit(1);
}

function generateLinkHtml(linkToken) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Plaid Link - Connect Bank</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0; background: #f5f5f5;
    }
    .container {
      text-align: center; background: white; padding: 2rem;
      border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      max-width: 500px; width: 100%;
    }
    h1 { font-size: 1.5rem; color: #333; }
    .token-box {
      background: #f0f0f0; padding: 1rem; border-radius: 4px;
      word-break: break-all; font-family: monospace; font-size: 0.85rem;
      margin: 1rem 0; user-select: all;
    }
    .status { color: #666; margin: 1rem 0; }
    .success { color: #2e7d32; }
    .error { color: #c62828; }
    button {
      background: #0052cc; color: white; border: none; padding: 0.75rem 1.5rem;
      border-radius: 4px; font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #0041a3; }
    button:disabled { background: #ccc; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Connect Your Bank</h1>
    <p class="status" id="status">Click the button below to connect your bank account via Plaid.</p>
    <button id="link-btn" onclick="openLink()">Connect Bank Account</button>
    <div id="result" style="display:none">
      <p class="success">Bank connected successfully. Copy the public token below and paste it back:</p>
      <div class="token-box" id="public-token"></div>
      <p style="font-size:0.85rem;color:#666">
        Run: <code>node scripts/plaid-link.js --exchange &lt;token&gt;</code>
      </p>
    </div>
    <div id="error-box" style="display:none">
      <p class="error" id="error-msg"></p>
    </div>
  </div>
  <script>
    const handler = Plaid.create({
      token: '${linkToken}',
      onSuccess: function(public_token, metadata) {
        document.getElementById('link-btn').style.display = 'none';
        document.getElementById('status').style.display = 'none';
        document.getElementById('result').style.display = 'block';
        document.getElementById('public-token').textContent = public_token;
      },
      onExit: function(err) {
        if (err) {
          document.getElementById('error-box').style.display = 'block';
          document.getElementById('error-msg').textContent =
            'Link exited with error: ' + (err.display_message || err.error_message || JSON.stringify(err));
        }
      },
    });
    function openLink() { handler.open(); }
  </script>
</body>
</html>`;
}

async function handleCreateLinkToken() {
  const config = loadPlaidConfig();
  if (!config) {
    console.error(
      JSON.stringify({
        error:
          "Plaid credentials not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in workspace/.env.",
      })
    );
    process.exit(1);
  }

  const linkToken = await createLinkToken(config);
  const htmlPath = "/tmp/plaid-link.html";
  fs.writeFileSync(htmlPath, generateLinkHtml(linkToken));

  console.log(
    JSON.stringify(
      {
        linkToken,
        htmlPath,
        instructions:
          "Open /tmp/plaid-link.html in a browser to connect a bank. After connecting, copy the public token and run: node scripts/plaid-link.js --exchange <public_token>",
      },
      null,
      2
    )
  );
}

async function handleExchange(publicToken, label) {
  const config = loadPlaidConfig();
  if (!config) {
    console.error(
      JSON.stringify({ error: "Plaid credentials not configured." })
    );
    process.exit(1);
  }

  const { accessToken, itemId } = await exchangePublicToken(
    config,
    publicToken
  );

  // Store as an individual source in finance-sources.json
  const source = addSource(
    {
      provider: "plaid",
      label: label || "Plaid Bank",
      accessToken,
      itemId,
      cursor: null,
    },
    { sourcesPath: config.sourcesPath }
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        sourceId: source.id,
        itemId,
        message: `Plaid item saved as source '${source.id}' in finance-sources.json.`,
      },
      null,
      2
    )
  );
}

async function handleListItems() {
  const config = loadPlaidConfig();
  if (!config) {
    console.log(JSON.stringify({ items: [], message: "Plaid not configured." }));
    return;
  }

  const data = loadSources({ sourcesPath: config.sourcesPath });
  const items = [];

  for (const source of data.sources || []) {
    if (source.provider !== "plaid") continue;

    if (source.accessToken) {
      // New per-source format
      items.push({
        sourceId: source.id,
        label: source.label || "Plaid",
        enabled: source.enabled !== false,
        itemId: source.itemId || null,
        tokenPreview: source.accessToken.substring(0, 15) + "...",
        addedAt: source.addedAt,
      });
    } else if (Array.isArray(source.accessTokens)) {
      // Legacy grouped format
      for (let i = 0; i < source.accessTokens.length; i++) {
        items.push({
          sourceId: source.id || "plaid_legacy",
          legacyIndex: i,
          label: source.label || "Plaid",
          enabled: source.enabled !== false,
          tokenPreview: source.accessTokens[i].substring(0, 15) + "...",
          addedAt: source.addedAt,
        });
      }
    }
  }

  console.log(JSON.stringify({ items }, null, 2));
}

async function handleRemoveItem(identifier) {
  const config = loadPlaidConfig();
  if (!config) {
    console.error(
      JSON.stringify({ error: "Plaid credentials not configured." })
    );
    process.exit(1);
  }

  // Try to find by source ID first
  const data = loadSources({ sourcesPath: config.sourcesPath });
  const source = data.sources.find(
    (s) => s.provider === "plaid" && s.id === identifier
  );

  if (source && source.accessToken) {
    // New per-source format — remove from Plaid API and locally
    try {
      await removeItem(config, source.accessToken);
    } catch (err) {
      console.error(`Warning: Plaid API removal failed: ${err.message}`);
    }

    const removed = removeSource(identifier, { sourcesPath: config.sourcesPath });
    console.log(
      JSON.stringify(
        {
          success: true,
          message: `Source '${identifier}' removed.`,
          removed: { id: removed.id, label: removed.label },
        },
        null,
        2
      )
    );
    return;
  }

  // Legacy fallback: try numeric index into grouped accessTokens array
  const index = parseInt(identifier, 10);
  if (isNaN(index) || index < 0) {
    console.error(
      JSON.stringify({
        error: `Source not found: ${identifier}. Use --list-items to see available sources.`,
      })
    );
    process.exit(1);
  }

  const legacySource = data.sources.find(
    (s) => s.provider === "plaid" && Array.isArray(s.accessTokens)
  );

  if (!legacySource || index >= legacySource.accessTokens.length) {
    console.error(
      JSON.stringify({
        error: `Item index ${index} out of range.`,
      })
    );
    process.exit(1);
  }

  const accessToken = legacySource.accessTokens[index];

  try {
    await removeItem(config, accessToken);
  } catch (err) {
    console.error(`Warning: Plaid API removal failed: ${err.message}`);
  }

  legacySource.accessTokens.splice(index, 1);

  // Clean up sync cursor
  if (data.syncCursors && data.syncCursors[accessToken]) {
    delete data.syncCursors[accessToken];
  }

  saveSources(data, { sourcesPath: config.sourcesPath });

  console.log(
    JSON.stringify(
      {
        success: true,
        message: `Legacy item at index ${index} removed.`,
        remainingItems: legacySource.accessTokens.length,
      },
      null,
      2
    )
  );
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse optional --label flag
  let label = null;
  const labelIdx = args.indexOf("--label");
  if (labelIdx !== -1 && args[labelIdx + 1]) {
    label = args[labelIdx + 1];
  }

  switch (command) {
    case "--create-link-token":
      return handleCreateLinkToken();
    case "--exchange":
      if (!args[1] || args[1] === "--label") {
        console.error(
          JSON.stringify({ error: "Missing public token argument." })
        );
        process.exit(1);
      }
      return handleExchange(args[1], label);
    case "--list-items":
      return handleListItems();
    case "--remove-item":
      if (!args[1]) {
        console.error(
          JSON.stringify({ error: "Missing source ID or item index argument." })
        );
        process.exit(1);
      }
      return handleRemoveItem(args[1]);
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
