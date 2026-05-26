const fs = require("fs");
const dotenv = require("dotenv");
const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath));
}

function loadWorkspaceEnv(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const processEnv = options.processEnv || process.env;
  const workspaceEnv = readEnvFile(paths.workspaceEnvPath);

  return {
    context,
    workspaceEnvPath: paths.workspaceEnvPath,
    env: {
      ...workspaceEnv,
      ...processEnv,
    },
  };
}

function requireEnv(env, key, message) {
  const value = env[key];
  if (!value) {
    throw new Error(message || `${key} is required`);
  }
  return value;
}

module.exports = {
  readEnvFile,
  loadWorkspaceEnv,
  requireEnv,
};
