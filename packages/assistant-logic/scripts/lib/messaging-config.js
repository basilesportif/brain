const fs = require("fs");
const yaml = require("yaml");
const { getWorkspaceContext, getWorkspacePaths } = require("./workspace");
const { loadWorkspaceEnv } = require("./runtime-env");

function loadMessagingConfig(options = {}) {
  const context = options.context || getWorkspaceContext(options);
  const paths = getWorkspacePaths(context);
  const { env } = loadWorkspaceEnv({
    context,
    processEnv: options.processEnv,
  });

  let messagingConfig = {};
  if (fs.existsSync(paths.messagingPath)) {
    messagingConfig = yaml.parse(fs.readFileSync(paths.messagingPath, "utf-8")) || {};
  }

  return {
    context,
    paths,
    env,
    messagingPath: paths.messagingPath,
    messagingConfig,
    TELEGRAM_USER: messagingConfig.telegram || {},
  };
}

module.exports = {
  loadMessagingConfig,
};
