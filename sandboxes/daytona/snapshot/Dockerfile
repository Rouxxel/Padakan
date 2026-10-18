# Padakan base snapshot for Daytona trees: tooling only, ZERO secrets.
#
# Bake:  daytona snapshot create "$DAYTONA_SNAPSHOT" --dockerfile sandboxes/daytona/snapshot/Dockerfile \
#          --cpu "$DAYTONA_CPU" --memory "$DAYTONA_MEMORY" --disk "$DAYTONA_DISK"
# Plant: `padakan plant <KEY>` (seconds, because everything below is already here)
#
# Rules Daytona enforces on a snapshot base image:
#   · linux/amd64
#   · an explicit tag; `latest`/`lts`/`stable` are rejected
#   · a long-running entrypoint (Daytona defaults it to `sleep infinity`)
# CPU, memory and disk are fixed at bake time: `daytona create` refuses them next to --snapshot.
FROM --platform=linux/amd64 ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ── system packages ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git jq sudo unzip xz-utils \
      openssh-client procps less ripgrep python3 python3-venv \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# ── node 22 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# ── github cli (official apt repo) ─────────────────────────────────────────
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# ── browsers and their system deps, world-readable ─────────────────────────
# BOTH matter: Playwright MCP's --browser defaults to chrome (there is no "chromium" channel),
# and the bundled Chromium is what plain Playwright scripts launch.
RUN npx -y playwright@latest install --with-deps chromium \
 && npx -y playwright@latest install --with-deps chrome \
 && npm cache clean --force

# Playwright MCP pre-fetched, and the playwright library global so evidence scripts can import it.
RUN npm install -g @playwright/mcp playwright
ENV NODE_PATH=/usr/lib/node_modules

# ── the sandbox user ───────────────────────────────────────────────────────
# ubuntu:24.04 ships a stock `ubuntu` user on uid 1000; reclaim it for daytona.
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupadd -g 1000 daytona \
 && useradd -u 1000 -g 1000 -m -d /home/daytona -s /bin/bash daytona \
 && echo 'daytona ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/daytona \
 && chmod 0440 /etc/sudoers.d/daytona

USER daytona
WORKDIR /home/daytona
ENV PATH=/home/daytona/.local/bin:$PATH

# ── claude code ────────────────────────────────────────────────────────────
# The installer lands on a stale build; `claude install latest` is the upgrade path that works.
# The interactive TUI ignores CLAUDE_CODE_OAUTH_TOKEN before 2.1.220, so this step is load-bearing.
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && /home/daytona/.local/bin/claude install latest \
 && /home/daytona/.local/bin/claude --version

# ── herdr and its claude integration hook ──────────────────────────────────
# The hook makes `herdr agent list` report real state; it only fires when the herdr server owns
# the PTY locally, which is why the server runs inside the tree.
RUN curl -fsSL https://herdr.dev/install.sh | sh \
 && /home/daytona/.local/bin/herdr --version \
 && mkdir -p /home/daytona/.claude \
 && /home/daytona/.local/bin/herdr integration install claude || true

# Onboarding gates pre-cleared: no theme picker, no bypass-permissions modal.
# Folder trust is still prompted per directory; the attach step clears it.
RUN printf '%s' '{"hasCompletedOnboarding":true,"theme":"dark","installMethod":"native","autoUpdates":false,"numStartups":5,"bypassPermissionsModeAccepted":true}' \
      > /home/daytona/.claude.json

RUN mkdir -p /home/daytona/trees /home/daytona/.padakan

CMD ["sleep", "infinity"]
