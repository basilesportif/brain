import { readFileSync } from "node:fs";
import path from "node:path";

export interface UserFacingFormatOptions {
  workspacePath?: string;
}

type JsonObject = Record<string, unknown>;

export function formatAssistantCommandOutput(input: {
  script?: string;
  stdout?: unknown;
  stderr?: string;
  ok?: boolean;
  workspacePath?: string;
}): string | undefined {
  const script = input.script ?? "";
  const stdout = unwrapStdout(input.stdout);
  if (!isObject(stdout)) return undefined;

  if (script.startsWith("todo-") || "todos" in stdout || "todo" in stdout || "deleted" in stdout && script.includes("todo")) {
    return formatTodoCommand(script, stdout, input.workspacePath);
  }
  if (script.startsWith("reminder-") || "reminders" in stdout || "reminder" in stdout && !("todo" in stdout)) {
    return formatReminderCommand(script, stdout, input.workspacePath);
  }
  if (isProjectDetailScript(script)) {
    return formatProjectDetailCommand(script, stdout);
  }
  if (script.startsWith("project-") || "projects" in stdout || "project" in stdout) {
    return formatProjectCommand(script, stdout);
  }
  if (isCrmDetailScript(script)) {
    return formatCrmDetailCommand(script, stdout);
  }
  if (script.startsWith("crm-") || "people" in stdout || "businesses" in stdout || "pipeline" in stdout) {
    return formatCrmCommand(script, stdout);
  }
  if (script.startsWith("calendar-") || looksLikeCalendarOutput(stdout)) {
    return formatCalendarOutput(stdout);
  }
  if (script.startsWith("gmail-") || script.startsWith("protonmail-") || script.startsWith("email-") || looksLikeEmailOutput(stdout)) {
    return formatEmailOutput(stdout);
  }
  return undefined;
}

export function sanitizeUserFacingText(text: string, options: UserFacingFormatOptions = {}): string {
  const fromJson = formatKnownJsonText(text, options);
  if (fromJson) return fromJson;

  let sanitized = text;
  sanitized = sanitized.replace(/```(?:json)?\s*({[\s\S]*?"(?:createdAt|updatedAt|todos|reminders)"[\s\S]*?})\s*```/gi, (_m, json) => {
    const formatted = formatKnownJsonText(String(json), options);
    return formatted ?? "";
  });

  // Last-resort guardrails for user-facing Telegram/entrypoint replies. The
  // formatter above handles known command JSON; this prevents accidental raw
  // todo/reminder/project/CRM internals from leaking if the provider paraphrases poorly.
  sanitized = sanitized.replace(/\b(?:td|rm)_[0-9a-f]{6,}\b/gi, "[internal id]");
  sanitized = sanitized.replace(/\b(?:pj|pt|pn|ct|bz|co)_[0-9a-f]{6,}\b/gi, "[internal id]");
  sanitized = sanitized.replace(/^\s*"(?:createdAt|updatedAt|lastTriggeredAt)"\s*:\s*".*?",?\s*$/gim, "");
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n").trim();
  return sanitized || text;
}

function formatKnownJsonText(text: string, options: UserFacingFormatOptions): string | undefined {
  const parsed = parsePossibleJson(text);
  if (!parsed) return undefined;
  if (isObject(parsed) && isObject(parsed.details)) {
    const details = parsed.details;
    const script = typeof details.script === "string" ? details.script : undefined;
    const workspacePath = typeof details.workspaceRoot === "string" ? details.workspaceRoot : options.workspacePath;
    const formatted = formatAssistantCommandOutput({
      script,
      stdout: details.stdout,
      stderr: typeof details.stderr === "string" ? details.stderr : undefined,
      ok: typeof parsed.ok === "boolean" ? parsed.ok : undefined,
      workspacePath,
    });
    if (formatted) return formatted;
  }
  if (isObject(parsed)) return formatAssistantCommandOutput({ stdout: parsed, workspacePath: options.workspacePath });
  if (Array.isArray(parsed)) {
    return formatCalendarOutput(parsed) ?? formatEmailOutput(parsed);
  }
  return undefined;
}

function parsePossibleJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!unfenced.startsWith("{") && !unfenced.startsWith("[")) return undefined;
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

function unwrapStdout(stdout: unknown): unknown {
  if (typeof stdout !== "string") return stdout;
  return parsePossibleJson(stdout) ?? stdout;
}

function formatTodoCommand(script: string, stdout: JsonObject, workspacePath?: string): string | undefined {
  if (Array.isArray(stdout.todos)) return `Current todos:\n${formatTodoList(stdout.todos)}`;
  if (isObject(stdout.todo)) {
    const title = stringField(stdout.todo, "title") || "todo";
    return [`Added todo: ${title}`, "", `Current todos:\n${formatTodoList(loadTodos(workspacePath) ?? [stdout.todo])}`].join("\n");
  }
  if (isObject(stdout.deleted) && (script.includes("todo") || !script)) {
    const title = stringField(stdout.deleted, "title") || "todo";
    return [`Removed todo: ${title}`, "", `Current todos:\n${formatTodoList(loadTodos(workspacePath) ?? [])}`].join("\n");
  }
  return undefined;
}

function formatTodoList(todos: unknown[]): string {
  if (todos.length === 0) return "No todos.";
  return todos.map((item, index) => {
    const todo = isObject(item) ? item : {};
    const title = stringField(todo, "title") || "(untitled)";
    const description = stringField(todo, "description");
    const project = stringField(todo, "_projectName");
    const suffix = [description, project ? `project: ${project}` : ""].filter(Boolean).join(" — ");
    return `${index + 1}. ${title}${suffix ? ` — ${suffix}` : ""}`;
  }).join("\n");
}

function loadTodos(workspacePath?: string): unknown[] | undefined {
  const store = readWorkspaceStore(workspacePath, "todos.json");
  return Array.isArray(store?.todos) ? store.todos : undefined;
}

function formatReminderCommand(script: string, stdout: JsonObject, workspacePath?: string): string | undefined {
  if (Array.isArray(stdout.reminders)) return `Current reminders:\n${formatReminderList(stdout.reminders)}`;
  if (isObject(stdout.reminder)) {
    const title = stringField(stdout.reminder, "title") || "reminder";
    const description = typeof stdout.description === "string" ? stdout.description : scheduleDescription(stdout.reminder);
    return [`Added reminder: ${title}${description ? ` — ${description}` : ""}`, "", `Current reminders:\n${formatReminderList(loadReminders(workspacePath) ?? [stdout.reminder])}`].join("\n");
  }
  if (isObject(stdout.deleted) && (script.includes("reminder") || !script)) {
    const title = stringField(stdout.deleted, "title") || "reminder";
    return [`Removed reminder: ${title}`, "", `Current reminders:\n${formatReminderList(loadReminders(workspacePath) ?? [])}`].join("\n");
  }
  return undefined;
}

function formatReminderList(reminders: unknown[]): string {
  if (reminders.length === 0) return "No reminders.";
  return reminders.map((item, index) => {
    const reminder = isObject(item) ? item : {};
    const title = stringField(reminder, "title") || "(untitled)";
    const description = stringField(reminder, "_description") || scheduleDescription(reminder);
    const enabled = reminder.enabled === false ? " (disabled)" : "";
    return `${index + 1}. ${title}${description ? ` — ${description}` : ""}${enabled}`;
  }).join("\n");
}

function scheduleDescription(reminder: JsonObject): string {
  const schedule = reminder.schedule;
  if (!isObject(schedule)) return "";
  const type = stringField(schedule, "type");
  const time = stringField(schedule, "time");
  const tz = stringField(schedule, "timezone");
  if (type === "daily" && time) return `daily at ${time}${tz ? ` ${tz}` : ""}`;
  if (type === "weekly" && time) return `every ${stringField(schedule, "day") || "week"} at ${time}${tz ? ` ${tz}` : ""}`;
  if (type === "once") return stringField(schedule, "datetime") || "";
  if (type === "cron") return `cron ${stringField(schedule, "expression") || ""}`.trim();
  return "";
}

function loadReminders(workspacePath?: string): unknown[] | undefined {
  const store = readWorkspaceStore(workspacePath, "reminders.json");
  return Array.isArray(store?.reminders) ? store.reminders : undefined;
}

function isProjectDetailScript(script: string): boolean {
  return ["project-view.js", "project-notes-list.js"].includes(script);
}

function formatProjectDetailCommand(script: string, stdout: JsonObject): string | undefined {
  if (script === "project-notes-list.js" && Array.isArray(stdout.notes)) {
    if (stdout.notes.length === 0) return "Project notes:\nNo matching notes.";
    return `Project notes:\n${stdout.notes.map((item, index) => {
      const note = isObject(item) ? item : {};
      const metadata = isObject(note.metadata) ? note.metadata : {};
      const title = stringField(metadata, "title") || "Project note";
      const parts = [stringField(note, "projectName"), stringField(metadata, "kind"), stringField(metadata, "category"), stringField(metadata, "summary")].filter(Boolean);
      const tags = Array.isArray(metadata.tags) && metadata.tags.length ? `tags: ${metadata.tags.join(", ")}` : "";
      if (tags) parts.push(tags);
      return `${index + 1}. ${title}${parts.length ? ` — ${parts.join(" — ")}` : ""}`;
    }).join("\n")}`;
  }

  if (script === "project-view.js" && isObject(stdout.project)) {
    const p = stdout.project;
    const lines = [`Project: ${stringField(p, "name") || "(untitled)"}`];
    pushField(lines, "Status", stringField(p, "status"));
    pushField(lines, "Description", stringField(p, "description"));
    pushField(lines, "Target", stringField(p, "targetDate"));
    if (Array.isArray(stdout.linkedPeople) && stdout.linkedPeople.length) lines.push("", `People:\n${formatPeople(stdout.linkedPeople)}`);
    if (Array.isArray(stdout.linkedBusinesses) && stdout.linkedBusinesses.length) lines.push("", `Businesses:\n${formatBusinesses(stdout.linkedBusinesses)}`);
    if (Array.isArray(stdout.openTasks) && stdout.openTasks.length) lines.push("", `Open tasks:\n${formatProjectTasks(stdout.openTasks)}`);
    if (Array.isArray(stdout.linkedTodos) && stdout.linkedTodos.length) lines.push("", `Linked todos:\n${formatTodoList(stdout.linkedTodos)}`);
    if (Array.isArray(p.resources) && p.resources.length) lines.push("", `Resources:\n${formatResources(p.resources)}`);
    if (Array.isArray(p.notes) && p.notes.length) lines.push("", `Notes:\n${formatProjectNotes(p.notes)}`);
    return lines.join("\n");
  }

  return undefined;
}

function formatProjectCommand(_script: string, stdout: JsonObject): string | undefined {
  if (Array.isArray(stdout.projects)) {
    if (stdout.projects.length === 0) return "Projects:\nNo projects.";
    return `Projects:\n${stdout.projects.map((item, index) => {
      const p = isObject(item) ? item : {};
      const parts = [stringField(p, "name") || "(untitled)", `status: ${stringField(p, "status") || "unknown"}`];
      const target = stringField(p, "targetDate");
      if (target) parts.push(`target: ${target}`);
      return `${index + 1}. ${parts.join(" — ")}`;
    }).join("\n")}`;
  }
  if (isObject(stdout.project)) {
    const p = stdout.project;
    const name = stringField(p, "name") || "project";
    return `Project saved: ${name}${stringField(p, "status") ? ` — status: ${stringField(p, "status")}` : ""}`;
  }
  return undefined;
}

function isCrmDetailScript(script: string): boolean {
  return ["crm-view.js", "crm-history.js", "crm-follow-ups.js", "crm-log.js"].includes(script);
}

function formatCrmDetailCommand(script: string, stdout: JsonObject): string | undefined {
  if (script === "crm-log.js" && isObject(stdout.correspondence)) {
    const entry = stdout.correspondence;
    const lines = [`Logged CRM ${stringField(entry, "type") || "correspondence"}: ${stringField(entry, "summary") || "(no summary)"}`];
    pushField(lines, "Date", stringField(entry, "date"));
    if (entry.followUpNeeded) pushField(lines, "Follow-up", stringField(entry, "followUpDate") || "needed");
    pushField(lines, "Notes", stringField(entry, "notes"));
    return lines.join("\n");
  }

  if (script === "crm-history.js" && Array.isArray(stdout.correspondence)) {
    if (stdout.correspondence.length === 0) return "CRM history:\nNo correspondence found.";
    return `CRM history:\n${formatCorrespondence(stdout.correspondence)}`;
  }

  if (script === "crm-follow-ups.js" && Array.isArray(stdout.followUps)) {
    if (stdout.followUps.length === 0) return "CRM follow-ups:\nNo pending follow-ups.";
    return `CRM follow-ups:\n${formatCorrespondence(stdout.followUps)}`;
  }

  if (script === "crm-view.js" && isObject(stdout.person)) {
    const person = stdout.person;
    const lines = [`CRM person: ${stringField(person, "name") || "(unnamed)"}`];
    pushField(lines, "Email", stringField(person, "email"));
    pushField(lines, "Phone", stringField(person, "phone"));
    pushField(lines, "Company", stringField(person, "company"));
    pushField(lines, "Title", stringField(person, "title"));
    pushField(lines, "Status", stringField(person, "status"));
    pushField(lines, "Priority", stringField(person, "priority"));
    pushField(lines, "Source", stringField(person, "source"));
    pushField(lines, "Notes", stringField(person, "notes"));
    pushField(lines, "Last contacted", stringField(person, "lastContactedAt"));
    if (Array.isArray(stdout.businesses) && stdout.businesses.length) lines.push("", `Businesses:\n${formatBusinesses(stdout.businesses)}`);
    if (Array.isArray(stdout.pendingFollowUps) && stdout.pendingFollowUps.length) lines.push("", `Pending follow-ups:\n${formatCorrespondence(stdout.pendingFollowUps)}`);
    if (Array.isArray(stdout.correspondence) && stdout.correspondence.length) lines.push("", `History:\n${formatCorrespondence(stdout.correspondence)}`);
    return lines.join("\n");
  }

  if (script === "crm-view.js" && isObject(stdout.business)) {
    const business = stdout.business;
    const lines = [`CRM business: ${stringField(business, "name") || "(unnamed)"}`];
    pushField(lines, "Status", stringField(business, "status"));
    pushField(lines, "Description", stringField(business, "description"));
    const dealValue = moneyField(business, "dealValue");
    if (dealValue) lines.push(`Deal value: ${dealValue.replace(/^deal value: /, "")}`);
    pushField(lines, "Notes", stringField(business, "notes"));
    if (Array.isArray(stdout.people) && stdout.people.length) lines.push("", `People:\n${formatPeople(stdout.people)}`);
    if (Array.isArray(stdout.pendingFollowUps) && stdout.pendingFollowUps.length) lines.push("", `Pending follow-ups:\n${formatCorrespondence(stdout.pendingFollowUps)}`);
    if (Array.isArray(stdout.correspondence) && stdout.correspondence.length) lines.push("", `History:\n${formatCorrespondence(stdout.correspondence)}`);
    return lines.join("\n");
  }

  return undefined;
}

function formatCrmCommand(_script: string, stdout: JsonObject): string | undefined {
  if (Array.isArray(stdout.people)) {
    if (stdout.people.length === 0) return "CRM people:\nNo matching people.";
    return `CRM people:\n${stdout.people.map((item, index) => {
      const p = isObject(item) ? item : {};
      const details = [stringField(p, "email"), stringField(p, "company"), stringField(p, "status") && `status: ${stringField(p, "status")}`, Array.isArray(p._missingFields) && p._missingFields.length ? `missing: ${p._missingFields.join(", ")}` : ""].filter(Boolean);
      return `${index + 1}. ${stringField(p, "name") || "(unnamed)"}${details.length ? ` — ${details.join(" — ")}` : ""}`;
    }).join("\n")}`;
  }
  if (Array.isArray(stdout.businesses)) {
    if (stdout.businesses.length === 0) return "CRM businesses:\nNo matching businesses.";
    return `CRM businesses:\n${stdout.businesses.map((item, index) => {
      const b = isObject(item) ? item : {};
      const details = [stringField(b, "status") && `status: ${stringField(b, "status")}`, moneyField(b, "dealValue")].filter(Boolean);
      return `${index + 1}. ${stringField(b, "name") || "(unnamed)"}${details.length ? ` — ${details.join(" — ")}` : ""}`;
    }).join("\n")}`;
  }
  if (isObject(stdout.person)) return `CRM person saved: ${stringField(stdout.person, "name") || "person"}`;
  if (isObject(stdout.business)) return `CRM business saved: ${stringField(stdout.business, "name") || "business"}`;
  return undefined;
}

function formatPeople(items: unknown[]): string {
  if (items.length === 0) return "No matching people.";
  return items.map((item, index) => {
    const p = isObject(item) ? item : {};
    const details = [stringField(p, "email"), stringField(p, "phone"), stringField(p, "company"), stringField(p, "title"), stringField(p, "status") && `status: ${stringField(p, "status")}`].filter(Boolean);
    return `${index + 1}. ${stringField(p, "name") || "(unnamed)"}${details.length ? ` — ${details.join(" — ")}` : ""}`;
  }).join("\n");
}

function formatBusinesses(items: unknown[]): string {
  if (items.length === 0) return "No matching businesses.";
  return items.map((item, index) => {
    const b = isObject(item) ? item : {};
    const details = [stringField(b, "status") && `status: ${stringField(b, "status")}`, moneyField(b, "dealValue")].filter(Boolean);
    return `${index + 1}. ${stringField(b, "name") || "(unnamed)"}${details.length ? ` — ${details.join(" — ")}` : ""}`;
  }).join("\n");
}

function formatCorrespondence(items: unknown[]): string {
  return items.map((item, index) => {
    const entry = isObject(item) ? item : {};
    const summary = stringField(entry, "summary") || "(no summary)";
    const details = [stringField(entry, "date"), stringField(entry, "type"), stringField(entry, "personName"), stringField(entry, "businessName"), entry.followUpNeeded ? `follow-up: ${stringField(entry, "followUpDate") || "needed"}` : "", entry.resolved === true ? "resolved" : ""].filter(Boolean);
    const notes = stringField(entry, "notes");
    return `${index + 1}. ${summary}${details.length ? ` — ${details.join(" — ")}` : ""}${notes ? `\n   Notes: ${notes}` : ""}`;
  }).join("\n");
}

function formatProjectTasks(items: unknown[]): string {
  return items.map((item, index) => {
    const task = isObject(item) ? item : {};
    return `${index + 1}. ${stringField(task, "title") || "(untitled task)"}${stringField(task, "status") ? ` — status: ${stringField(task, "status")}` : ""}`;
  }).join("\n");
}

function formatResources(items: unknown[]): string {
  return items.map((item, index) => {
    const resource = isObject(item) ? item : {};
    const label = stringField(resource, "label") || stringField(resource, "url") || "resource";
    const url = stringField(resource, "url");
    return `${index + 1}. ${label}${url && url !== label ? ` — ${url}` : ""}`;
  }).join("\n");
}

function formatProjectNotes(items: unknown[]): string {
  return items.map((item, index) => {
    const note = isObject(item) ? item : {};
    const metadata = isObject(note.metadata) ? note.metadata : {};
    const title = stringField(metadata, "title") || cleanTitleLine(firstNonEmptyLine(stringField(note, "text"))) || "Project note";
    const summary = stringField(metadata, "summary");
    return `${index + 1}. ${title}${summary && summary !== title ? ` — ${summary}` : ""}`;
  }).join("\n");
}

function pushField(lines: string[], label: string, value: string): void {
  if (value) lines.push(`${label}: ${value}`);
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function cleanTitleLine(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/^title\s*[:—-]\s*/i, "")
    .trim();
}

function formatCalendarOutput(stdout: unknown): string | undefined {
  const events = Array.isArray(stdout) ? stdout : isObject(stdout) && Array.isArray(stdout.events) ? stdout.events : undefined;
  if (!events) return undefined;
  const first = events[0];
  if (first !== undefined && !(isObject(first) && ("summary" in first || "title" in first || "start" in first || "end" in first || "htmlLink" in first))) return undefined;
  if (events.length === 0) return "Calendar events:\nNo matching events.";
  return `Calendar events:\n${events.slice(0, 20).map((item, index) => {
    const e = isObject(item) ? item : {};
    const title = stringField(e, "summary") || stringField(e, "title") || "(untitled)";
    const start = dateLike(e.start) || stringField(e, "start") || stringField(e, "date");
    const end = dateLike(e.end) || stringField(e, "end");
    const location = stringField(e, "location");
    return `${index + 1}. ${[title, start && end ? `${start}–${end}` : start, location].filter(Boolean).join(" — ")}`;
  }).join("\n")}`;
}

function formatEmailOutput(stdout: unknown): string | undefined {
  const messages = Array.isArray(stdout) ? stdout : isObject(stdout) && Array.isArray(stdout.messages) ? stdout.messages : undefined;
  if (!messages) return undefined;
  if (messages.length === 0) return "Emails:\nNo matching emails.";
  return `Emails:\n${messages.slice(0, 20).map((item, index) => {
    const m = isObject(item) ? item : {};
    const parts = [stringField(m, "from"), stringField(m, "subject") || "(no subject)", stringField(m, "date"), stringField(m, "reason")].filter(Boolean);
    const snippet = stringField(m, "snippet");
    return `${index + 1}. ${parts.join(" — ")}${snippet ? `\n   ${snippet}` : ""}`;
  }).join("\n")}`;
}

function readWorkspaceStore(workspacePath: string | undefined, file: string): JsonObject | undefined {
  if (!workspacePath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path.join(workspacePath, "data", file), "utf8")) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeCalendarOutput(value: unknown): boolean {
  const sample = Array.isArray(value) ? value[0] : isObject(value) && Array.isArray(value.events) ? value.events[0] : undefined;
  return isObject(sample) && ("summary" in sample || "start" in sample || "htmlLink" in sample);
}

function looksLikeEmailOutput(value: unknown): boolean {
  const sample = Array.isArray(value) ? value[0] : isObject(value) && Array.isArray(value.messages) ? value.messages[0] : undefined;
  return isObject(sample) && ("subject" in sample || "from" in sample || "snippet" in sample) && !("summary" in sample);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value.trim() : "";
}

function moneyField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "number" ? `deal value: $${value.toLocaleString("en-US")}` : "";
}

function dateLike(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  return stringField(value, "dateTime") || stringField(value, "date");
}
