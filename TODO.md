# TODO

- **Live-test from-scratch provisioning on a fresh server.** The full "get it up
  and running" flow (P1–P8: self-locating config + contract, `brainctl canary`
  gate, brain-admin deploy, owner bootstrap, registry generator, generic behavior
  pack + workspace seed, bare-server prereqs + secret helpers) is BUILT and
  verified in-repo (canary 7/7 against Tim's live instance), but NOT yet run
  end-to-end on a clean box. Next: stand up a fresh Ubuntu server, provision a new
  owner by running the setup flow (`setup-self-host` SKILL.md — an agent-in-the-repo
  prompts for secrets), and confirm `brainctl canary --config <toml>` goes green.
  Expect a few rough edges the live run will surface; those are the fast-follows.
  Then Slack + public admin UI + TLS (deferred; Telegram-only first). See memory
  `brain-provisioning.md`.
