import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const assistantPackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).default("0.0.0"),
  description: z.string().optional(),
  prompts: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  boundaries: z.object({
    entrypointNeutral: z.boolean().default(true),
    providerNeutral: z.boolean().default(true),
    containsPrivateData: z.boolean().default(false),
  }).default({ entrypointNeutral: true, providerNeutral: true, containsPrivateData: false }),
}).strict();

export type AssistantPackManifest = z.infer<typeof assistantPackManifestSchema>;

export interface AssistantPackValidationIssue {
  path: string;
  message: string;
}

export interface AssistantPackValidationResult {
  ok: boolean;
  manifest?: AssistantPackManifest;
  issues: AssistantPackValidationIssue[];
}

const disallowedPrivatePatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN|COMPOSIO_API_KEY)\b\s*[:=]/,
];

const personalPathPatterns = [
  /\/home\/tim\//,
  /me\.galebach\.com/i,
  /basilesportif/i,
];

export async function validateAssistantPack(packDir: string): Promise<AssistantPackValidationResult> {
  const root = path.resolve(packDir);
  const issues: AssistantPackValidationIssue[] = [];
  const manifestPath = path.join(root, "assistant-pack.json");
  let manifest: AssistantPackManifest | undefined;

  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = assistantPackManifestSchema.safeParse(parsed);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => ({ path: `assistant-pack.json:${issue.path.join(".")}`, message: issue.message })));
    } else {
      manifest = result.data;
    }
  } catch (error) {
    issues.push({ path: "assistant-pack.json", message: error instanceof SyntaxError ? "manifest is not valid JSON" : "missing assistant-pack.json" });
  }

  if (!manifest) return { ok: false, issues };

  if (manifest.boundaries.containsPrivateData) {
    issues.push({ path: "assistant-pack.json:boundaries.containsPrivateData", message: "assistant packs in source control must not contain private data" });
  }

  for (const rel of [...manifest.skills, ...manifest.prompts, ...manifest.workflows]) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(`${root}${path.sep}`)) {
      issues.push({ path: rel, message: "pack paths must stay inside the pack directory" });
      continue;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) issues.push({ path: rel, message: "manifest entry must point to a file" });
    } catch {
      issues.push({ path: rel, message: "manifest entry does not exist" });
      continue;
    }
    const text = await readFile(target, "utf8");
    for (const pattern of disallowedPrivatePatterns) {
      if (pattern.test(text)) issues.push({ path: rel, message: "secret-like content is not allowed in assistant packs" });
    }
    for (const pattern of personalPathPatterns) {
      if (pattern.test(text)) issues.push({ path: rel, message: "personal maintainer-specific references are not allowed in portable assistant packs" });
    }
  }

  for (const skillPath of manifest.skills) {
    if (!skillPath.endsWith("SKILL.md")) {
      issues.push({ path: skillPath, message: "skill entries should point to SKILL.md files" });
      continue;
    }
    const text = await readFile(path.join(root, skillPath), "utf8");
    if (!/^---\n[\s\S]*?\n---\n/.test(text)) {
      issues.push({ path: skillPath, message: "skill files must start with YAML frontmatter" });
    }
  }

  return { ok: issues.length === 0, manifest, issues };
}

export async function discoverPackFiles(packDir: string): Promise<string[]> {
  const root = path.resolve(packDir);
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      if (entry.isFile()) results.push(path.relative(root, full));
    }
  }
  await walk(root);
  return results.sort();
}
