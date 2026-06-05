const crypto = require("crypto");
const { createStateStore } = require("./state-stores");

const SCHEMA_VERSION = 1;

function generateId() {
  return `td_${crypto.randomBytes(8).toString("hex")}`;
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    todos: [],
  };
}

function getTodoStore(options = {}) {
  return createStateStore("todos", {
    ...options,
    defaultValue: createEmptyStore,
    onLoad(store) {
      const next = store && typeof store === "object" ? store : createEmptyStore();
      if (!Array.isArray(next.todos)) next.todos = [];
      return next;
    },
  });
}

function loadStore(options = {}) {
  return getTodoStore(options).load();
}

function saveStore(store, options = {}) {
  store.updatedAt = new Date().toISOString();
  return getTodoStore(options).save(store);
}

function addTodo({ title, description, projectId }, options = {}) {
  const normalizedTitle = (title || "").trim();
  if (!normalizedTitle) throw new Error("Title is required");
  return getTodoStore(options).transaction((store) => {
    const now = new Date().toISOString();
    const todo = {
      id: generateId(),
      title: normalizedTitle,
      description: (description || "").trim(),
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    if (projectId) todo.projectId = projectId;
    store.todos.push(todo);
    store.updatedAt = now;
    return todo;
  });
}

function listTodos({ query } = {}, options = {}) {
  const store = loadStore(options);
  let todos = store.todos;
  if (query) {
    const lowerQuery = query.toLowerCase();
    todos = todos.filter(
      (todo) =>
        todo.title.toLowerCase().includes(lowerQuery) ||
        (todo.description && todo.description.toLowerCase().includes(lowerQuery))
    );
  }
  return todos;
}

function deleteTodoById(id, options = {}) {
  return getTodoStore(options).transaction((store, tx) => {
    const index = store.todos.findIndex((todo) => todo.id === id);
    if (index === -1) {
      tx.skipSave();
      return { found: false };
    }
    const [removed] = store.todos.splice(index, 1);
    store.updatedAt = new Date().toISOString();
    return { found: true, deleted: { id: removed.id, title: removed.title } };
  });
}

function deleteTodoByTitle(titleQuery, options = {}) {
  return getTodoStore(options).transaction((store, tx) => {
    const lowerQuery = titleQuery.toLowerCase();
    const matches = store.todos.filter((todo) =>
      todo.title.toLowerCase().includes(lowerQuery)
    );
    if (matches.length === 0) {
      tx.skipSave();
      return { found: false, matches: [] };
    }
    if (matches.length > 1) {
      tx.skipSave();
      return { found: false, ambiguous: true, matches };
    }
    const target = matches[0];
    const index = store.todos.findIndex((todo) => todo.id === target.id);
    store.todos.splice(index, 1);
    store.updatedAt = new Date().toISOString();
    return { found: true, deleted: { id: target.id, title: target.title } };
  });
}

module.exports = {
  getTodoStore,
  loadStore,
  saveStore,
  addTodo,
  listTodos,
  deleteTodoById,
  deleteTodoByTitle,

};
