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

WORKDIR /home/janus/app

RUN groupadd -g 1000 janus && useradd -u 1000 -g janus -m janus

COPY --from=builder --chown=janus:janus /app/node_modules node_modules/
COPY --from=builder --chown=janus:janus /app/src src/
COPY --from=builder --chown=janus:janus /app/tsconfig.json .
COPY --from=builder --chown=janus:janus /app/package.json .
COPY --from=builder --chown=janus:janus /app/skills skills/

RUN mkdir -p .janus memory sessions && chown -R janus:janus .janus memory sessions

USER janus

# Initialize workspace (creates EGO.md, AGENTS.md, etc.)
RUN npx tsx src/index.ts onboard .

ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD ["gateway"]
