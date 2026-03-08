# Stage 1: Build (native modules need build tools)
FROM node:20-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ src/
COPY tsconfig.json .
COPY skills/ skills/

# Stage 2: Runtime (slim image, no build tools)
FROM node:20-bookworm-slim

# Install gogcli (Google Workspace CLI)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz | tar -xz -C /usr/local/bin \
  && chmod +x /usr/local/bin/gog \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node/app

COPY --from=builder --chown=node:node /app/node_modules node_modules/
COPY --from=builder --chown=node:node /app/src src/
COPY --from=builder --chown=node:node /app/tsconfig.json .
COPY --from=builder --chown=node:node /app/package.json .
COPY --from=builder --chown=node:node /app/skills skills/

RUN chown node:node /home/node/app && mkdir -p .janus memory sessions && chown -R node:node .janus memory sessions

USER node

# Initialize workspace (creates EGO.md, AGENTS.md, etc.)
RUN npx tsx src/index.ts onboard .

ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD ["gateway"]
