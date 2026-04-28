# Headless trading bot — Railway-friendly Node 20 image.
FROM node:20-slim AS build
WORKDIR /app

# Cache deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

# Source
COPY tsconfig.json tsconfig.node.json ./
COPY src/ ./src/

# Bundle bot to a single file (no electron-store, electron excluded)
RUN npx esbuild src/bot/index.ts \
    --bundle --platform=node --format=cjs --target=node20 \
    --alias:@shared=./src/shared \
    --external:electron --external:electron-store \
    --outfile=dist/bot.js

# Runtime stage — slim, no build tools
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Persisted state directory (Railway volume mounts here)
RUN mkdir -p /app/state

# Only NON-CONFIGURABLE infra paths baked in. Everything else (stake, R:R,
# multiplier, etc.) is set in Railway dashboard via .env.railway paste —
# keeps every value visible and editable in the Railway UI.
ENV STATE_DIR=/app/state

COPY --from=build /app/dist/bot.js /app/bot.js

# Health endpoint port — Railway injects PORT (overrides EXPOSE)
EXPOSE 3000

CMD ["node", "/app/bot.js"]
