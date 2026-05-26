const { listActionableGmail } = require("./gmail-service");
const { listActionableProtonmail } = require("./protonmail-service");

async function listActionableEmail(options = {}) {
  const maxResults = options.maxResults || 10;

  const [gmail, protonmail] = await Promise.all([
    listActionableGmail({ ...options, maxResults }).catch((error) => {
      process.stderr.write(`[email-actionable] gmail failed: ${error.message}\n`);
      return [];
    }),
    listActionableProtonmail({ ...options, maxResults }).catch((error) => {
      process.stderr.write(`[email-actionable] protonmail failed: ${error.message}\n`);
      return [];
    }),
  ]);

  return [...gmail, ...protonmail].sort(
    (left, right) => new Date(right.date) - new Date(left.date)
  );
}

module.exports = {
  listActionableEmail,
};
