const crypto = require("crypto");
const { createStateStore } = require("./state-stores");

const SCHEMA_VERSION = 1;

function generateId() {
  return `pj_${crypto.randomBytes(8).toString("hex")}`;
}

function generateTaskId() {
  return `pt_${crypto.randomBytes(8).toString("hex")}`;
}

function ensureTasks(project) {
  if (!Array.isArray(project.tasks)) project.tasks = [];
  return project;
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    projects: [],
  };
}

function getProjectStore(options = {}) {
  return createStateStore("projects", {
    ...options,
    defaultValue: createEmptyStore,
    onLoad(store) {
      const next = store && typeof store === "object" ? store : createEmptyStore();
      if (!Array.isArray(next.projects)) next.projects = [];
      next.projects.forEach(ensureTasks);
      return next;
    },
  });
}

function loadStore(options = {}) {
  return getProjectStore(options).load();
}

function saveStore(store, options = {}) {
  store.updatedAt = new Date().toISOString();
  return getProjectStore(options).save(store);
}

function addProject(input, options = {}) {
  const name = (input.name || "").trim();
  if (!name) throw new Error("Name is required");
  const store = loadStore(options);
  const now = new Date().toISOString();
  const project = {
    id: generateId(),
    name,
    description: (input.description || "").trim() || null,
    status: input.status || "active",
    targetDate: input.targetDate || null,
    personIds: Array.isArray(input.personIds) ? input.personIds : [],
    businessIds: Array.isArray(input.businessIds) ? input.businessIds : [],
    notes: [],
    resources: [],
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
  if (input.initialNote) {
    project.notes.push({ text: input.initialNote.trim(), createdAt: now });
  }
  store.projects.push(project);
  saveStore(store, options);
  return project;
}

function updateProject(id, updates, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  const allowed = ["name", "description", "status", "targetDate"];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      project[key] = updates[key];
    }
  }
  if (updates._addPersonIds) {
    for (const pid of updates._addPersonIds) {
      if (!project.personIds.includes(pid)) project.personIds.push(pid);
    }
  }
  if (updates._removePersonIds) {
    project.personIds = project.personIds.filter(
      (pid) => !updates._removePersonIds.includes(pid)
    );
  }
  if (updates._addBusinessIds) {
    for (const bid of updates._addBusinessIds) {
      if (!project.businessIds.includes(bid)) project.businessIds.push(bid);
    }
  }
  if (updates._removeBusinessIds) {
    project.businessIds = project.businessIds.filter(
      (bid) => !updates._removeBusinessIds.includes(bid)
    );
  }
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return project;
}

function listProjects({ query, status, all } = {}, options = {}) {
  const store = loadStore(options);
  let projects = store.projects;
  if (!all) {
    if (status) {
      projects = projects.filter((p) => p.status === status);
    } else {
      projects = projects.filter((p) => p.status !== "archived");
    }
  }
  if (query) {
    const lowerQuery = query.toLowerCase();
    projects = projects.filter(
      (p) =>
        p.name.toLowerCase().includes(lowerQuery) ||
        (p.description && p.description.toLowerCase().includes(lowerQuery))
    );
  }
  return projects;
}

function getProject(id, options = {}) {
  const store = loadStore(options);
  return store.projects.find((p) => p.id === id) || null;
}

function addNote(id, text, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  const now = new Date().toISOString();
  const note = { text: text.trim(), createdAt: now };
  project.notes.push(note);
  project.updatedAt = now;
  saveStore(store, options);
  return { project, note };
}

function addResource(id, { label, url }, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  const now = new Date().toISOString();
  const resource = { label: label.trim(), url: url.trim(), addedAt: now };
  project.resources.push(resource);
  project.updatedAt = now;
  saveStore(store, options);
  return { project, resource };
}

function removeResource(id, { index, label } = {}, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  let removeIndex = -1;
  if (index !== undefined && index !== null) {
    removeIndex = Number(index);
  } else if (label) {
    const lowerLabel = label.toLowerCase();
    removeIndex = project.resources.findIndex(
      (r) => r.label.toLowerCase() === lowerLabel
    );
  }
  if (removeIndex < 0 || removeIndex >= project.resources.length) {
    return { project, removed: null, error: "Resource not found" };
  }
  const [removed] = project.resources.splice(removeIndex, 1);
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return { project, removed };
}

function addTask(id, title, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === id);
  if (!project) return null;
  ensureTasks(project);
  const now = new Date().toISOString();
  const task = {
    id: generateTaskId(),
    title: title.trim(),
    status: "open",
    createdAt: now,
    completedAt: null,
  };
  project.tasks.push(task);
  project.updatedAt = now;
  saveStore(store, options);
  return { project, task };
}

function completeTask(projectId, taskId, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return { project, task: null, error: "Task not found" };
  const now = new Date().toISOString();
  task.status = "done";
  task.completedAt = now;
  project.updatedAt = now;
  saveStore(store, options);
  return { project, task };
}

function reopenTask(projectId, taskId, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return { project, task: null, error: "Task not found" };
  task.status = "open";
  task.completedAt = null;
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return { project, task };
}

function removeTask(projectId, taskId, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  const index = project.tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return { project, removed: null, error: "Task not found" };
  const [removed] = project.tasks.splice(index, 1);
  project.updatedAt = new Date().toISOString();
  saveStore(store, options);
  return { project, removed };
}

function listTasks(projectId, { status } = {}, options = {}) {
  const store = loadStore(options);
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;
  ensureTasks(project);
  let tasks = project.tasks;
  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }
  return tasks;
}

function deleteProject(id, options = {}) {
  const store = loadStore(options);
  const index = store.projects.findIndex((p) => p.id === id);
  if (index === -1) return { found: false };
  const [removed] = store.projects.splice(index, 1);
  saveStore(store, options);
  return { found: true, deleted: { id: removed.id, name: removed.name } };
}

module.exports = {
  getProjectStore,
  loadStore,
  saveStore,
  addProject,
  updateProject,
  listProjects,
  getProject,
  addNote,
  addResource,
  removeResource,
  deleteProject,
  addTask,
  completeTask,
  reopenTask,
  removeTask,
  listTasks,
};
