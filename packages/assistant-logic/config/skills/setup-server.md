# Setup Server Skill

Bootstrap a fresh remote Ubuntu server via SSH. This is a standalone skill — no dependency on a specific assistant workspace path.

## Inputs

Collect these from the user before starting:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `SERVER_IP` | Server IP address | `203.0.113.42` |
| `USERNAME` | Desired non-root user | `your-username` |
| `SERVER_NAME` | Label for SSH config and GitHub key | `my-server` |

Store them as shell variables for the duration of the session:

```bash
SERVER_IP="<ip>"
USERNAME="<username>"
SERVER_NAME="<server-name>"
```

---

## Phase 1: Root Bootstrap

### 1.1 Connect as root

```bash
ssh -o StrictHostKeyChecking=accept-new root@$SERVER_IP "echo 'root access OK'"
```

If this fails, stop and report — the server is not reachable or root SSH is not configured.

### 1.2 Create user

Run these commands over SSH as root. They are idempotent — safe to re-run.

```bash
ssh root@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

USERNAME="__USERNAME__"

# Create user if not exists
id "$USERNAME" &>/dev/null || useradd -m -s /bin/bash "$USERNAME"

# Add to sudo group
usermod -aG sudo "$USERNAME"

# Passwordless sudo
echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$USERNAME"
chmod 0440 "/etc/sudoers.d/$USERNAME"

# Copy root's authorized_keys to new user
USER_HOME=$(eval echo "~$USERNAME")
mkdir -p "$USER_HOME/.ssh"
cp /root/.ssh/authorized_keys "$USER_HOME/.ssh/authorized_keys"
chown -R "$USERNAME:$USERNAME" "$USER_HOME/.ssh"
chmod 700 "$USER_HOME/.ssh"
chmod 600 "$USER_HOME/.ssh/authorized_keys"

echo "User $USERNAME created and configured"
REMOTE
```

Replace `__USERNAME__` with the actual `$USERNAME` value before executing (use variable substitution in the heredoc or sed).

### 1.3 Verify user access

```bash
ssh -o StrictHostKeyChecking=accept-new $USERNAME@$SERVER_IP "whoami && sudo whoami"
```

Expected output: the username on the first line, `root` on the second. If sudo prompts for a password, Phase 1.2 failed.

---

## Phase 2: Base Packages

All remaining commands run as the new user.

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y unzip curl git build-essential tmux libatomic1

echo "Base packages installed"
dpkg -l | grep -E 'unzip|curl|git|build-essential|tmux' | awk '{print $2, $3}'
REMOTE
```

### Verify

Confirm the output lists all five packages with version numbers.

---

## Phase 3: Docker

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

# Install Docker if not present
if command -v docker &>/dev/null; then
  echo "Docker already installed"
  docker --version
else
  sudo apt-get install -y docker.io
  sudo systemctl enable --now docker
  echo "Docker installed"
  docker --version
fi

# Add user to docker group (allows running docker without sudo)
sudo usermod -aG docker "$USER"
echo "User added to docker group (re-login required for group to take effect)"
REMOTE
```

### Verify

```bash
ssh $USERNAME@$SERVER_IP "docker --version"
```

---

## Phase 4: Bun

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

curl -fsSL https://bun.sh/install | bash

# Source the updated profile so bun is on PATH
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

bun --version
REMOTE
```

### Verify

Output should show a bun version number.

---

## Phase 5: nvm + Node.js

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

# Install nvm
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Load nvm for this session
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Install latest LTS and set as default
nvm install --lts
nvm alias default lts/*
nvm use default

node --version
npm --version
REMOTE
```

### Verify

Output should show node and npm versions.

---

## Phase 6: Claude Code CLI

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

npm install -g @anthropic-ai/claude-code

claude --version
REMOTE
```

### Verify

Output should show the Claude Code version.

---

## Phase 7: Codex CLI

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

npm install -g @openai/codex

codex --version
REMOTE
```

### Verify

Output should show the Codex version.

---

## Phase 8: SSH Key for GitHub

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

KEY_FILE="$HOME/.ssh/id_ed25519"

if [ -f "$KEY_FILE" ]; then
  echo "SSH key already exists, skipping generation"
else
  ssh-keygen -t ed25519 -N "" -f "$KEY_FILE"
  echo "SSH key generated"
fi

cat "$KEY_FILE.pub"
REMOTE
```

Save the public key output for the next step.

### Add key to GitHub

Read the public key from the remote, then add it via the GitHub CLI on the local machine:

```bash
PUB_KEY=$(ssh $USERNAME@$SERVER_IP cat ~/.ssh/id_ed25519.pub)
gh ssh-key add - --title "$SERVER_NAME" <<< "$PUB_KEY"
```

If `gh` is not available locally, the user can add the key manually at https://github.com/settings/ssh/new.

---

## Phase 9: GitHub CLI

### 9.1 Install gh

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

if command -v gh &>/dev/null; then
  echo "gh already installed"
  gh --version
else
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y gh
  echo "gh installed"
  gh --version
fi
REMOTE
```

### 9.2 Authenticate

`gh auth login` requires interactive input, so the user must run it manually. Tell the user:

> SSH into the server and authenticate with GitHub:
> 1. `ssh <server-name>`
> 2. `gh auth login`
> 3. Choose **GitHub.com**, **SSH**, and authenticate via browser or token

### Verify

```bash
ssh $SERVER_NAME "gh auth status"
```

---

## Phase 10: Dotfiles

### 10.1 Copy dotfiles

```bash
scp "$REPO_ROOT/dotfiles/.tmux.conf" $USERNAME@$SERVER_IP:~/.tmux.conf
scp "$REPO_ROOT/dotfiles/.bashrc" $USERNAME@$SERVER_IP:~/.bashrc
```

### 10.2 Install TPM and plugins

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

# Install TPM if not present
if [ ! -d "$HOME/.tmux/plugins/tpm" ]; then
  git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
  echo "TPM installed"
else
  echo "TPM already installed"
fi

# Install plugins non-interactively
~/.tmux/plugins/tpm/bin/install_plugins

echo "tmux plugins installed"
REMOTE
```

### Verify

```bash
ssh $USERNAME@$SERVER_IP "ls ~/.tmux/plugins/"
```

Expected: `tpm` and `tmux-resurrect` directories.

---

## Phase 11: Local SSH Config

Append an entry to the local machine's SSH config so `ssh <server-name>` works.

```bash
# Ensure ~/.ssh/config exists
touch ~/.ssh/config
chmod 600 ~/.ssh/config

# Check if entry already exists
if grep -q "^Host $SERVER_NAME$" ~/.ssh/config; then
  echo "SSH config entry for $SERVER_NAME already exists, skipping"
else
  cat >> ~/.ssh/config <<EOF

Host $SERVER_NAME
    HostName $SERVER_IP
    User $USERNAME
    IdentityFile ~/.ssh/id_ed25519
EOF
  echo "SSH config entry added for $SERVER_NAME"
fi
```

### Verify

```bash
ssh $SERVER_NAME "echo 'SSH config alias works'"
```

---

## Phase 12: Clone Assistant Repo

Clone the assistant logic repo onto the remote server so it's ready for `/setup`.

```bash
ssh $SERVER_NAME bash <<'REMOTE'
set -euo pipefail

# Replace these defaults for your deployment before running.
REPO_DIR="$HOME/pkg/assistant-agent-logic"
REPO_GIT_URL="git@github.com:<owner>/assistant-agent-logic.git"

if [ -d "$REPO_DIR/.git" ]; then
  echo "Repo already cloned at $REPO_DIR, pulling latest"
  cd "$REPO_DIR" && git pull
else
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_GIT_URL" "$REPO_DIR"
  echo "Repo cloned to $REPO_DIR"
fi

cd "$REPO_DIR"

# Load nvm for npm install
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

npm install
echo "Dependencies installed"
REMOTE
```

### Verify

```bash
ssh $SERVER_NAME "ls ~/pkg/tim/assistant-agent-logic/CLAUDE.md"
```

After this, the user can run `/setup` on the remote server to initialize the workspace.

---

## Phase 13: Claude Settings

Create a `.claude/settings.local.json` on the remote server so Claude can operate without permission prompts for routine operations.

```bash
ssh $SERVER_NAME bash <<'REMOTE'
set -euo pipefail

cd ~/pkg/tim/assistant-agent-logic
mkdir -p .claude

cat > .claude/settings.local.json << 'SETTINGS'
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": [
      "Bash(bun *)",
      "Bash(node *)",
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(git *)",
      "Bash(ssh *)",
      "Bash(scp *)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm *)",
      "Bash(chmod *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(wc *)",
      "Bash(sort *)",
      "Bash(grep *)",
      "Bash(find *)",
      "Bash(curl *)",
      "Bash(jq *)",
      "Bash(date *)",
      "Bash(echo *)",
      "Bash(printf *)",
      "Bash(test *)",
      "Bash(diff *)",
      "Bash(tmux *)",
      "Bash(docker *)",
      "Bash(bash scripts/*)",
      "Bash(cd * && *)",
      "Bash(ASSISTANT_WORKSPACE=*)",
      "Bash(export *)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "Skill(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "mcp__plugin_telegram_telegram__*"
    ]
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS

echo "Claude settings configured at .claude/settings.local.json"
REMOTE
```

### Verify

```bash
ssh $SERVER_NAME "cat ~/pkg/tim/assistant-agent-logic/.claude/settings.local.json | head -5"
```

---

## Phase 14: Telegram Plugin

The Telegram plugin enables Claude to send and receive messages via Telegram. This phase has a manual prerequisite.

### 14.1 Install the plugin (manual)

The user must add the Telegram plugin through Claude's plugin system on the remote server. This cannot be automated — tell the user:

> Before continuing, SSH into the server and add the Telegram plugin in Claude settings:
> 1. `ssh <server-name>`
> 2. Start Claude: `claude`
> 3. Type `/plugins` and add the official Telegram plugin
> 4. Exit Claude

### 14.2 Configure bot token

The stock Telegram plugin reads its bot token from `~/.claude/channels/telegram/.env`. Create the file with the token:

```bash
ssh $SERVER_NAME bash <<'REMOTE'
set -euo pipefail

mkdir -p ~/.claude/channels/telegram
# The user must supply their actual bot token here
echo "TELEGRAM_BOT_TOKEN=<token>" > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env
echo "Telegram bot token configured"
REMOTE
```

Ask the user for their bot token before running this step.

### 14.3 Next steps

After running `/setup` on the remote to initialize the workspace, the user should run the **setup-telegram-bot** skill to configure their Telegram chat ID. This is needed for bot notifications and cron job messages.

---

## Phase 15: Final Verification

Run a single comprehensive check:

```bash
ssh $SERVER_NAME bash <<'REMOTE'
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

echo "=== User ==="
whoami

echo "=== Sudo ==="
sudo whoami

echo "=== Node ==="
node --version

echo "=== npm ==="
npm --version

echo "=== Docker ==="
docker --version

echo "=== Bun ==="
bun --version

echo "=== Claude Code ==="
claude --version

echo "=== Codex ==="
codex --version

echo "=== Git ==="
git --version

echo "=== GitHub CLI ==="
gh --version

echo "=== GitHub SSH ==="
ssh -T git@github.com 2>&1 || true

echo "=== tmux ==="
tmux -V

echo "All checks complete"
REMOTE
```

The GitHub SSH test should print "Hi <username>! You've been authenticated" (exit code 1 is normal for `ssh -T`).

---

## Summary

After completion, the server has:

- A non-root user with passwordless sudo
- Base dev packages (git, curl, build-essential, tmux, unzip)
- Docker (user added to docker group)
- Bun runtime
- Node.js LTS via nvm
- Claude Code CLI
- Codex CLI
- GitHub CLI (`gh`) installed and authenticated
- An ed25519 SSH key registered with GitHub
- tmux configured with TPM and tmux-resurrect
- A local SSH config alias for quick access
- The assistant logic repo cloned and dependencies installed (ready for `/setup`)
- Claude settings configured for unattended operation (no permission prompts)
- Telegram plugin installed with bot token at `~/.claude/channels/telegram/.env`
