#!/usr/bin/env node
/**
 * validate-repo.js — Lightweight repo structure validation.
 *
 * Checks that checked-in docs, skills, and scripts are consistent:
 *   - Required top-level files exist
 *   - Every script referenced in skill docs maps to an actual file
 *   - Workspace template files exist
 *   - Skill docs don't reference stale file names
 *
 * Usage:  node scripts/validate-repo.js
 * Exit 0 = all OK, exit 1 = issues found.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let issues = 0;

function check(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    issues++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ── 1. Required top-level files ──────────────────────────────────────
console.log("\n1. Required top-level files");
for (const f of ["CLAUDE.md", "README.md", "package.json", ".gitignore"]) {
  check(fileExists(f), f);
}

// ── 2. Config structure ──────────────────────────────────────────────
console.log("\n2. Config structure");
for (const f of [
  "config/TELEGRAM.md",
  "config/SEARCH.md",
  "config/skills/composio.md",
  "config/skills/dictionary.md",
  "config/skills/messaging.md",
  "config/skills/protonmail.md",
  "config/skills/web-page-design.md",
  "config/skills/generated-web-page.md",
  "config/skills/file-save.md",
  "config/skills/setup.md",
  "config/skills/setup-composio.md",
  "config/skills/setup-github.md",
  "config/skills/setup-telegram.md",
  "config/skills/setup-telegram-bot.md",
  "config/skills/setup-repo-registry.md",
  "config/prompts/email-reply-preferences.md",
]) {
  check(fileExists(f), f);
}

// ── 3. Workspace template files ──────────────────────────────────────
console.log("\n3. Workspace template");
for (const f of [
  "config/workspace-template/composio.yaml",
  "config/workspace-template/telegram.yaml",
  "config/workspace-template/messaging.yaml",
  "config/workspace-template/.env.example",
  "config/workspace-template/.gitignore",
  "config/workspace-template/instructions/README.md",
  "config/workspace-template/instructions/skills/composio.md",
  "config/workspace-template/instructions/skills/messaging.md",
  "config/workspace-template/instructions/skills/protonmail.md",
  "config/workspace-template/instructions/skills/file-save.md",
  "config/workspace-template/instructions/prompts/email-reply-preferences.md",
  "config/workspace-template/tasks/README.md",
]) {
  check(fileExists(f), f);
}

// Template skills
const templateSkillsDir = path.join(ROOT, "config/workspace-template/skills");
if (fs.existsSync(templateSkillsDir)) {
  const templateSkills = fs.readdirSync(templateSkillsDir).filter(f => f.endsWith(".md"));
  for (const f of templateSkills) {
    check(fileExists(`config/workspace-template/skills/${f}`), `template skill: ${f}`);
  }
}

// ── 4. Scripts referenced in skill docs ──────────────────────────────
console.log("\n4. Script references in skill docs");
const skillDocs = [
  "config/skills/composio.md",
  "config/skills/dictionary.md",
  "config/skills/messaging.md",
  "config/skills/protonmail.md",
  "config/skills/file-save.md",
];
const scriptRefPattern = /node scripts\/([a-z0-9-]+\.js)/g;

for (const doc of skillDocs) {
  const content = fs.readFileSync(path.join(ROOT, doc), "utf-8");
  let match;
  const seen = new Set();
  while ((match = scriptRefPattern.exec(content)) !== null) {
    const script = match[1];
    if (seen.has(script)) continue;
    seen.add(script);
    check(fileExists(`scripts/${script}`), `${doc} -> scripts/${script}`);
  }
}

// ── 5. Cross-references: cron skill file names in docs ───────────────
console.log("\n5. Cron skill file name references");
const cronRefPattern = /workspace\/skills\/([a-z0-9-]+\.md)/g;

const docsToCheck = [
  "config/skills/composio.md",
  "config/skills/messaging.md",
  "config/skills/setup-telegram-bot.md",
];
for (const doc of docsToCheck) {
  const content = fs.readFileSync(path.join(ROOT, doc), "utf-8");
  let match;
  const seen = new Set();
  while ((match = cronRefPattern.exec(content)) !== null) {
    const skillFile = match[1];
    if (seen.has(skillFile)) continue;
    seen.add(skillFile);
    // Cron skills live in the workspace template
    check(
      fileExists(`config/workspace-template/skills/${skillFile}`),
      `${doc} -> workspace/skills/${skillFile} (template)`
    );
  }
}

// ── 6. Placeholder consistency in templates ──────────────────────────
console.log("\n6. Placeholder consistency");
const templateDir = path.join(ROOT, "config/workspace-template");
const expectedPlaceholders = {
  "telegram.yaml": "YOUR_TELEGRAM_CHAT_ID",
  "composio.yaml": "ca_XXXX",
};

for (const [file, placeholder] of Object.entries(expectedPlaceholders)) {
  const filePath = path.join(templateDir, file);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    check(content.includes(placeholder), `${file} contains placeholder ${placeholder}`);
  }
}

// ── 7. Overlay reference consistency ─────────────────────────────────
console.log("\n7. Overlay reference consistency");
const overlayRefs = [
  ["CLAUDE.md", "workspace/instructions/skills/composio.md"],
  ["CLAUDE.md", "workspace/instructions/skills/protonmail.md"],
  ["CLAUDE.md", "workspace/instructions/skills/file-save.md"],
  ["CLAUDE.md", "workspace/instructions/prompts/email-reply-preferences.md"],
  ["config/skills/composio.md", "workspace/instructions/skills/composio.md"],
  ["config/skills/messaging.md", "workspace/instructions/skills/messaging.md"],
  ["config/skills/protonmail.md", "workspace/instructions/skills/protonmail.md"],
  ["config/skills/protonmail.md", "workspace/instructions/prompts/email-reply-preferences.md"],
  ["config/skills/file-save.md", "workspace/instructions/skills/file-save.md"],
  ["config/prompts/email-reply-preferences.md", "workspace/instructions/prompts/email-reply-preferences.md"],
  ["config/workspace-template/skills/email-check.md", "workspace/instructions/skills/composio.md"],
  ["config/workspace-template/skills/message-check.md", "workspace/instructions/skills/messaging.md"],
  ["config/workspace-template/skills/urgent-check.md", "workspace/instructions/skills/composio.md"],
  ["config/workspace-template/skills/urgent-check.md", "workspace/instructions/skills/messaging.md"],
  ["config/workspace-template/skills/flagged-event-check.md", "workspace/instructions/skills/composio.md"],
];

for (const [file, expectedRef] of overlayRefs) {
  const content = fs.readFileSync(path.join(ROOT, file), "utf-8");
  check(content.includes(expectedRef), `${file} references ${expectedRef}`);
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${issues === 0 ? "All checks passed." : `${issues} issue(s) found.`}`);
process.exit(issues > 0 ? 1 : 0);
