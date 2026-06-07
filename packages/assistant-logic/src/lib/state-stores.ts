// @ts-nocheck
import { getWorkspaceContext } from "./workspace.js";
import { createJsonStore } from "./json-store.js";
import { getStateDescriptor } from "./state-files.js";

function createStateStore(key, options = {}) {
  const descriptor = getStateDescriptor(key);
  const context = options.context || getWorkspaceContext(options);
  return createJsonStore({
    context,
    relativePath: descriptor.relativePath,
    legacyRelativePaths: descriptor.legacyRelativePaths,
    defaultValue: options.defaultValue,
    label: descriptor.label,
    onLoad: options.onLoad,
    lock: options.lock,
  });
}

export {
  createStateStore,

};
