FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.326
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -m 700 -o node -g node /state /context
WORKDIR /app
COPY agents/package.json agents/package-lock.json agents/tsconfig.json ./
COPY agents/src/ ./src/
COPY agents/scripts/provision.ts ./scripts/
RUN npm ci --no-audit --no-fund && npm run build && curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh
ENV PATH=/home/node/.local/bin:$PATH DISABLE_AUTOUPDATER=1 NODE_ENV=production
USER node
RUN bash /tmp/claude-install.sh "$CLAUDE_CODE_VERSION" && claude --version
COPY deploy/run-gateway.mjs ./run-gateway.mjs
CMD ["node", "--experimental-sqlite", "run-gateway.mjs"]
