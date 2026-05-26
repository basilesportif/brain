#!/usr/bin/env node
/**
 * Deploy a dictionary project into a prompt file.
 *
 * The project keeps:
 *   - one prompt note, prefixed with "Transcription prompt:", "Dictionary prompt:", or "Prompt:"
 *   - dictionary entries as bullet lines in normal notes
 *   - a deployment target resource, usually labelled "Dictionary deployment target"
 *
 * Output: JSON to stdout, errors to stderr.
 */
const fs = require("fs");
const path = require("path");
const { loadWorkspaceEnv } = require("./lib/runtime-env");
const { getProject, listProjects } = require("./lib/project-store");

const DEFAULT_PROJECT_NAME = "Dictionary";
const TARGET_LABEL_PATTERN = /\b(dictionary\s+)?(deployment\s+)?target\b/i;
const PROMPT_LABEL_PATTERN = /^(?:transcription\s+prompt|dictionary\s+prompt|prompt)\s*:\s*/i;
const TARGET_NOTE_PATTERN = /^(?:dictionary\s+deployment\s+target|deployment\s+target|target\s+path)\s*:\s*(.+)$/i;

const DEFAULT_PROMPT = [
  "Use this as transcription vocabulary and correction guidance. Preserve the speaker's meaning.",
  "Prefer the spellings and replacements below when audio is ambiguous. Remove filler words.",
  "",
  "USER DICTIONARY:",
].join("\n");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    print: false,
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--project-id" && argv[i + 1]) {
      args.projectId = argv[++i];
      i++;
    } else if (arg === "--project-name" && argv[i + 1]) {
      args.projectName = argv[++i];
      i++;
    } else if (arg === "--target" && argv[i + 1]) {
      args.target = argv[++i];
      i++;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
      i++;
    } else if (arg === "--print") {
      args.print = true;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    "Usage: dictionary-deploy.js [--project-id pj_...] [--project-name Dictionary] [--target /abs/path] [--dry-run] [--print]",
    "",
    "Deploys prompt + bullet dictionary entries from a project to its stored target path.",
    "If --target is omitted, the target is read from a project resource labelled like 'Dictionary deployment target'.",
  ].join("\n");
}

function loadProject({ projectId, projectName } = {}) {
  if (projectId) return getProject(projectId);

  const resolvedProjectName = projectName || DEFAULT_PROJECT_NAME;
  const matches = listProjects({ query: resolvedProjectName, all: true }).filter(
    (project) => project.name.toLowerCase() === resolvedProjectName.toLowerCase()
  );

  if (matches.length > 1) {
    throw new Error(
      `Multiple projects named ${JSON.stringify(resolvedProjectName)} found; use --project-id.`
    );
  }

  return matches[0] || null;
}

function loadDictionaryConfig({ args, processEnv = process.env, loadEnv = true } = {}) {
  const env = loadEnv
    ? loadWorkspaceEnv({ env: processEnv, processEnv }).env
    : processEnv;

  return {
    projectId: args.projectId || env.DICTIONARY_PROJECT_ID || null,
    projectName: args.projectName || env.DICTIONARY_PROJECT_NAME || DEFAULT_PROJECT_NAME,
    target: args.target || env.DICTIONARY_TARGET_PATH || null,
    dryRun: Boolean(args.dryRun),
    print: Boolean(args.print),
  };
}

function normalizeTargetPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (raw.startsWith("file://")) {
    const url = new URL(raw);
    return decodeURIComponent(url.pathname);
  }

  return raw;
}

function findTargetPath(project) {
  const resources = Array.isArray(project.resources) ? project.resources : [];
  const matchingResources = resources.filter((resource) =>
    TARGET_LABEL_PATTERN.test(resource.label || "")
  );

  for (let i = matchingResources.length - 1; i >= 0; i--) {
    const targetPath = normalizeTargetPath(matchingResources[i].url);
    if (targetPath) return targetPath;
  }

  const notes = Array.isArray(project.notes) ? project.notes : [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const lines = String(notes[i].text || "").split(/\r?\n/);
    for (const line of lines) {
      const match = line.trim().match(TARGET_NOTE_PATTERN);
      if (match) {
        const targetPath = normalizeTargetPath(match[1]);
        if (targetPath) return targetPath;
      }
    }
  }

  return null;
}

function isPromptNote(text) {
  return PROMPT_LABEL_PATTERN.test(String(text || "").trimStart());
}

function stripPromptLabel(text) {
  return String(text || "").trimStart().replace(PROMPT_LABEL_PATTERN, "").trim();
}

function extractPrompt(project) {
  const notes = Array.isArray(project.notes) ? project.notes : [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const text = notes[i].text || "";
    if (isPromptNote(text)) {
      return {
        text: stripPromptLabel(text),
        createdAt: notes[i].createdAt || null,
        source: "project-note",
      };
    }
  }

  return {
    text: DEFAULT_PROMPT,
    createdAt: null,
    source: "default",
  };
}

function extractEntries(project) {
  const entries = [];
  const seen = new Set();
  const notes = Array.isArray(project.notes) ? project.notes : [];

  for (const note of notes) {
    const text = String(note.text || "");
    if (isPromptNote(text)) continue;

    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(/^[-*]\s+(.+)$/);
      if (!match) continue;

      const entry = match[1].trim();
      if (!entry || seen.has(entry)) continue;

      seen.add(entry);
      entries.push(entry);
    }
  }

  return entries;
}

function composeDictionary({ prompt, entries }) {
  let output = String(prompt || "").trim();
  if (!output) output = DEFAULT_PROMPT;

  if (!/USER DICTIONARY:\s*$/i.test(output)) {
    output = `${output.replace(/\s+$/, "")}\n\nUSER DICTIONARY:`;
  }

  if (entries.length) {
    output += `\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
  }

  return `${output}\n`;
}

function deployDictionary({ project, targetPath, dryRun = false }) {
  const prompt = extractPrompt(project);
  const entries = extractEntries(project);
  const content = composeDictionary({ prompt: prompt.text, entries });

  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }

  return {
    projectId: project.id,
    projectName: project.name,
    targetPath,
    promptSource: prompt.source,
    promptNoteCreatedAt: prompt.createdAt,
    entryCount: entries.length,
    content,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(1);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  try {
    const config = loadDictionaryConfig({ args });
    const project = loadProject(config);
    if (!project) {
      const selector = config.projectId || config.projectName;
      throw new Error(`Project not found: ${selector}`);
    }

    const targetPath = normalizeTargetPath(config.target) || findTargetPath(project);
    if (!targetPath) {
      throw new Error(
        "No deployment target found. Add a project resource labelled 'Dictionary deployment target' with the absolute target path."
      );
    }
    if (!path.isAbsolute(targetPath)) {
      throw new Error(`Deployment target must be an absolute path: ${targetPath}`);
    }

    const result = deployDictionary({
      project,
      targetPath,
      dryRun: config.dryRun,
    });

    const response = {
      ok: true,
      projectId: result.projectId,
      projectName: result.projectName,
      targetPath: result.targetPath,
      promptSource: result.promptSource,
      promptNoteCreatedAt: result.promptNoteCreatedAt,
      entryCount: result.entryCount,
      wrote: !config.dryRun,
    };
    if (config.print) response.content = result.content;

    console.log(JSON.stringify(response, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_PROMPT,
  composeDictionary,
  deployDictionary,
  extractEntries,
  extractPrompt,
  findTargetPath,
  loadDictionaryConfig,
  loadProject,
  normalizeTargetPath,
  parseArgs,
};
