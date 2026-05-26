#!/usr/bin/env node
const { getProfile } = require("./lib/whoop-service");

async function main() {
  const profile = await getProfile();
  console.log(JSON.stringify(profile, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
