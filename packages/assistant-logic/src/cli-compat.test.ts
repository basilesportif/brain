import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const distRoot = path.resolve(new URL(".", import.meta.url).pathname);
const cliRoot = path.join(distRoot, "cli");

function runCli(workspace: string, script: string, args: string[] = []) {
  const privateRoot = path.join(workspace, "private");
  const result = spawnSync(process.execPath, [path.join(cliRoot, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_WORKSPACE: workspace, ASSISTANT_PRIVATE_DIR: privateRoot, BRAIN_PRIVATE_DIR: privateRoot },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result;
}

function parseStdout(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, String(result.stderr));
  return JSON.parse(String(result.stdout));
}

test("native CLI surfaces preserve JSON stdout for todos/projects/CRM/reminders/file-save", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-assistant-cli-"));
  try {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "data"), { recursive: true });

    const todo = parseStdout(runCli(workspace, "todo-add.js", ["--title", "Buy coffee"]));
    assert.equal(todo.ok, true);
    assert.match(todo.todo.id, /^td_[0-9a-f]{16}$/);
    const todos = parseStdout(runCli(workspace, "todo-list.js"));
    assert.equal(todos.count, 1);
    assert.equal(todos.todos[0].title, "Buy coffee");
    const deletedTodo = parseStdout(runCli(workspace, "todo-delete.js", ["--id", todo.todo.id]));
    assert.equal(deletedTodo.ok, true);
    const todosAfterDelete = parseStdout(runCli(workspace, "todo-list.js"));
    assert.equal(todosAfterDelete.count, 0);

    const project = parseStdout(runCli(workspace, "project-add.js", ["--name", "Parity Project"]));
    assert.equal(project.ok, true);
    assert.match(project.project.id, /^pj_[0-9a-f]{16}$/);
    const projects = parseStdout(runCli(workspace, "project-list.js"));
    assert.equal(projects.projects[0].name, "Parity Project");
    const resource = parseStdout(runCli(workspace, "project-resource.js", ["--id", project.project.id, "--add", "--label", "Spec", "--url", "https://example.test/spec"]));
    assert.equal(resource.ok, true);
    const task = parseStdout(runCli(workspace, "project-task.js", ["--id", project.project.id, "--add", "Draft outline"]));
    assert.equal(task.ok, true);
    const viewedProject = parseStdout(runCli(workspace, "project-view.js", ["--id", project.project.id]));
    assert.equal(viewedProject.project.resources[0].label, "Spec");
    assert.equal(viewedProject.openTasks[0].title, "Draft outline");

    const person = parseStdout(runCli(workspace, "crm-add-person.js", ["--name", "Jane Smith"]));
    assert.equal(person.ok, true);
    assert.match(person.person.id, /^ct_[0-9a-f]{16}$/);
    const people = parseStdout(runCli(workspace, "crm-list-people.js"));
    assert.equal(people.people[0].name, "Jane Smith");

    const reminder = parseStdout(runCli(workspace, "reminder-add.js", ["--title", "Weekly review", "--weekly", "friday", "--time", "17:00"]));
    assert.equal(reminder.ok, true);
    assert.match(reminder.reminder.id, /^rm_[0-9a-f]{16}$/);
    const reminders = parseStdout(runCli(workspace, "reminder-list.js"));
    assert.equal(reminders.reminders[0].title, "Weekly review");

    const sourceFile = path.join(root, "source.txt");
    fs.writeFileSync(sourceFile, "private source bytes\n");
    const saved = parseStdout(runCli(workspace, "file-save.js", ["--source", sourceFile, "--title", "Source note", "--project", "Parity Project"]));
    assert.equal(saved.ok, true);
    assert.equal(saved.document.title, "Source note");
    const files = parseStdout(runCli(workspace, "file-list.js"));
    assert.equal(files.documents[0].project, "Parity Project");
    assert.equal(files.metadataPath, path.join(workspace, "private", "documents", "metadata.jsonl"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
