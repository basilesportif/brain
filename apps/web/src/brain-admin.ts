#!/usr/bin/env node
import { createBrainAdminServer, initializeBrainAdminCapabilityStore, loadBrainAdminServiceConfig } from "./admin-service.js";

const config = loadBrainAdminServiceConfig();
await initializeBrainAdminCapabilityStore(config);
const server = createBrainAdminServer(config);
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ ok: true, service: "brain-admin", host: config.host, port: config.port, routePath: config.routePath, authFailClosed: true }));
});
