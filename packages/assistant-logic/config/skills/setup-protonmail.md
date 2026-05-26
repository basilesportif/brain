# Setup ProtonMail Bridge

Interactive setup skill for Proton Mail Bridge in Docker.

## Prerequisites

Before starting:

- **Paid Proton plan required** — Plus, Professional, or Visionary. Custom domain accounts (e.g. user@customdomain.com) already qualify.
- **TOTP 2FA only** — If 2FA is enabled, it must be a TOTP authenticator app. FIDO2/hardware security keys are **not supported** in Bridge CLI mode.
- **Docker** must be installed on the server.
- **No official Proton Docker image exists** — community images are used. This skill uses `shenxn/protonmail-bridge:latest`. Image names change over time — if the pull fails, search Docker Hub for a current `protonmail-bridge` image.
- **Docker group** — If Docker was just installed, the user's group membership may not be active in the current shell. Commands should use `sg docker -c "..."` to run under the docker group, or the user needs to run `newgrp docker` first.

## Pre-check

Check if `workspace/protonmail.yaml` exists and has a non-placeholder `email:` value, AND `workspace/.env` contains a non-empty `PROTONMAIL_BRIDGE_PASSWORD`.

If both are configured, print:
> ProtonMail Bridge is already configured — connection details and credentials are set.

Then stop.

## Step 1: Verify Docker is installed

```bash
docker --version
```

If Docker is not available, refer the user to the server setup skill which includes Docker installation.

## Step 2: Start Bridge Docker container

Pull and run the Bridge container. Ports are bound to **localhost only** — never expose them on `0.0.0.0`:

```bash
docker run -d \
  --name proton-bridge \
  --restart unless-stopped \
  -p 127.0.0.1:1143:1143 \
  -p 127.0.0.1:1025:1025 \
  -v proton-bridge-data:/root/.config/protonmail/bridge-v3 \
  shenxn/protonmail-bridge:latest
```

The `--restart unless-stopped` policy ensures the container auto-restarts on reboot or crash. The named volume `proton-bridge-data` persists login credentials across container restarts.

Confirm it started:
```bash
docker ps --filter name=proton-bridge --format '{{.Status}}'
```

## Step 3: Install libfido2

Bridge auto-updates inside the container (e.g. 3.19 to 3.22) and newer versions require `libfido2-1`. Install it now to prevent startup failures later:

```bash
docker exec proton-bridge apt-get update -qq && docker exec proton-bridge apt-get install -y -qq libfido2-1
```

## Step 4: Install and initialize password manager

The container has no keychain, and Bridge refuses to start without one. Install `pass` and create a GPG key for it:

```bash
docker exec proton-bridge bash -c 'apt-get install -y -qq pass gpg && gpg --batch --passphrase "" --quick-gen-key "ProtonBridge" default default never && pass init "ProtonBridge"'
```

## Step 5: Log in to Proton account (interactive — cannot be automated)

The first login **must** be done interactively. The Bridge CLI is a REPL that accepts credentials only via interactive stdin prompts — there is no CLI flag or pipe-friendly mode, so this step cannot be scripted.

Tell the user:
> Attach to the Bridge container CLI and log in. If you are in a Claude Code session, use the `!` prefix to run the command in-session so you don't need a separate terminal:
> ```
> ! sg docker -c "docker exec -it proton-bridge protonmail-bridge --cli"
> ```
> If you are in a regular terminal with docker group active:
> ```
> docker exec -it proton-bridge protonmail-bridge --cli
> ```
> Inside the Bridge CLI:
> 1. Run `login` and enter your ProtonMail email address
> 2. Enter your Proton account password (not the Bridge password — that comes later)
> 3. If 2FA is enabled, enter your TOTP code (hardware keys won't work here)
> 4. After login, run `info` to see the **Bridge-generated password**
> 5. Copy that password — it is **different from your Proton account password** and is what goes in the workspace config
> 6. Note the IMAP port (default 1143) and SMTP port (default 1025)

Prompt for:
- ProtonMail email address
- Bridge-generated password (from `info` output)
- IMAP port (default: 1143)
- SMTP port (default: 1025)

### Post-login headless operation

After the initial interactive login, the container runs headless. Credentials persist in the Docker volume (`proton-bridge-data`), so the container can restart without re-authentication. IMAP stays on `localhost:1143` and SMTP on `localhost:1025`.

## Step 6: Configure IMAP/SMTP ports

Verify Bridge is listening on localhost:
```bash
ss -tlnp | grep -E '1143|1025'
```

Confirm both ports are bound to `127.0.0.1` only (not `0.0.0.0`).

## Step 7: Write workspace config

Write `workspace/protonmail.yaml`:
```yaml
protonmail:
  bridge_host: "127.0.0.1"
  bridge_imap_port: <imap_port>
  bridge_smtp_port: <smtp_port>
  bridge_docker_image: "shenxn/protonmail-bridge:latest"
  accounts:
    - email: <email>
      label: "<display name>"
```

Append to `workspace/.env` (or replace existing empty placeholders):
```
PROTONMAIL_BRIDGE_USER=<email>
PROTONMAIL_BRIDGE_PASSWORD=<bridge-generated-password>
```

## Step 8: Verify Bridge connectivity

Test IMAP (list folders and confirm read access):
```bash
node -e "
const { ImapFlow } = require('imapflow');
const c = new ImapFlow({ host:'127.0.0.1', port:<imap_port>, secure:false, auth:{user:'<email>', pass:process.env.PROTONMAIL_BRIDGE_PASSWORD}, tls:{rejectUnauthorized:false} });
c.connect().then(async () => { const folders = await c.list(); console.log('IMAP OK — folders:', folders.map(f=>f.path).join(', ')); return c.logout(); }).catch(e => { console.error('IMAP FAIL:', e.message); process.exit(1); });
"
```

Test SMTP (verify can send):
```bash
node -e "
const nm = require('nodemailer');
const t = nm.createTransport({ host:'127.0.0.1', port:<smtp_port>, secure:false, auth:{user:'<email>', pass:process.env.PROTONMAIL_BRIDGE_PASSWORD}, tls:{rejectUnauthorized:false} });
t.verify().then(() => console.log('SMTP OK')).catch(e => { console.error('SMTP FAIL:', e.message); process.exit(1); });
"
```

Custom domain addresses (e.g. `user@customdomain.com`) work automatically through Bridge — no additional configuration needed.

If both succeed, print:
> ProtonMail Bridge setup complete. IMAP read and SMTP send are working.

If either fails, show the error and suggest checking that the Docker container is running and credentials are correct.

## Rules

- Never log the Bridge-generated password in output — only confirm it was saved.
- `workspace/.env` is gitignored — never commit it.
- `workspace/protonmail.yaml` may contain the email address but never the password.
- All ports must be verified as bound to `127.0.0.1` only before marking setup as complete.
