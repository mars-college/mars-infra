FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=mcp_source package.json package-lock.json tsconfig.json ./
COPY --from=mcp_source src/ ./src/
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ARG MARS_MCP_REV
LABEL org.opencontainers.image.source="https://github.com/mars-college/mars-mcp" org.opencontainers.image.revision="$MARS_MCP_REV"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && echo '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795  /usr/local/bin/yt-dlp' | sha256sum -c - \
 && chmod 755 /usr/local/bin/yt-dlp \
 && apt-get purge -y --auto-remove curl && rm -rf /var/lib/apt/lists/* \
 && install -d -m 700 -o node -g node /state
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
ENV NODE_ENV=production
USER node
EXPOSE 4400
CMD ["node", "--experimental-sqlite", "dist/index.js"]
