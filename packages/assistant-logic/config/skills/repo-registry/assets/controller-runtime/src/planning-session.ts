import path from "node:path";

import { nowIso, pathExists, readYaml, slugify, writeYaml } from "./fs-utils.js";
import { PlanningSessionSchema, type Engine, type PlanningSession, type PlanningSessionStatus, type RepoState } from "./schema.js";

export function sessionsDirForState(state: RepoState): string {
  return state.sessions_dir ?? path.join(path.dirname(state.artifacts_dir), "sessions");
}

export function sessionPathForTitle(state: RepoState, title: string): string {
  return path.join(sessionsDirForState(state), `${slugify(title)}.yaml`);
}

export async function readPlanningSessionIfExists(sessionPath: string): Promise<PlanningSession | null> {
  if (!(await pathExists(sessionPath))) {
    return null;
  }

  return readYaml(sessionPath, PlanningSessionSchema);
}

export function summarizeSessionText(text: string, maxLength = 400): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export async function upsertPlanningSession(options: {
  state: RepoState;
  title: string;
  artifactPath: string;
  promptPath: string;
  backend: Engine;
  status?: PlanningSessionStatus;
  codexThreadId?: string | null;
  lastResponseSummary?: string | null;
  openDecisions?: string[];
}): Promise<{
  session: PlanningSession;
  sessionPath: string;
}> {
  const sessionPath = sessionPathForTitle(options.state, options.title);
  const existing = await readPlanningSessionIfExists(sessionPath);
  const timestamp = nowIso();

  const session = PlanningSessionSchema.parse({
    version: 1,
    alias: options.state.alias,
    title: options.title,
    plan_slug: slugify(options.title),
    plan_artifact_path: options.artifactPath,
    status: options.status ?? existing?.status ?? "open",
    backend: options.backend,
    codex_thread_id: options.codexThreadId ?? existing?.codex_thread_id ?? null,
    last_prompt_path: options.promptPath,
    last_response_summary: options.lastResponseSummary ?? existing?.last_response_summary ?? null,
    open_decisions: options.openDecisions ?? existing?.open_decisions ?? [],
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  });

  await writeYaml(sessionPath, session);
  return { session, sessionPath };
}
