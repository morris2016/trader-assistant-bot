# Headless trading bot + web UI — Railway-friendly Node 20 image.
FROM node:20-slim AS build
WORKDIR /app

# Cache deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

# Source — include all tsconfigs (root references web/node)
COPY tsconfig.json tsconfig.node.json tsconfig.web.json vite.web.config.ts ./
COPY src/ ./src/

# Bundle bot (Node) — single CJS file
RUN npx esbuild src/bot/index.ts \
    --bundle --platform=node --format=cjs --target=node20 \
    --alias:@shared=./src/shared \
    --external:electron --external:electron-store \
    --outfile=dist/bot.js

# Build web UI (React) — static bundle to dist/web/
RUN npx vite build --config vite.web.config.ts

# Runtime stage — slim, no build tools
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Persisted state directory (Railway volume mounts here)
RUN mkdir -p /app/state /app/web

# Infra-only env (everything else configurable via Railway dashboard)
ENV STATE_DIR=/app/state
ENV WEB_DIR=/app/web

COPY --from=build /app/dist/bot.js /app/bot.js
COPY --from=build /app/dist/web/ /app/web/

# Health endpoint port — Railway injects PORT (overrides EXPOSE)
EXPOSE 3000

CMD ["node", "/app/bot.js"]
