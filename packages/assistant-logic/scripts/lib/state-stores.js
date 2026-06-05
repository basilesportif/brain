const { getWorkspaceContext } = require("./workspace");
const { createJsonStore } = require("./json-store");
const { getStateDescriptor } = require("./state-files");

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

module.exports = {
  createStateStore,

};
