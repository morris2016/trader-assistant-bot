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

# Persisted state directory (Railway volume should mount here)
RUN mkdir -p /app/state

# ───── Default env vars (override any of these in Railway dashboard) ─────
# Only DERIV_TOKEN must be set in Railway. All others have sensible defaults
# baked here so the dashboard stays clean — set only what you want to override.

# Lifecycle / infra
ENV STATE_DIR=/app/state
ENV LOG_LEVEL=info
ENV DERIV_APP_ID=1089

# Safety (flip to true after dry-run verification)
ENV LIVE_TRADING=false

# Risk caps (USD)
ENV STAKE=40
ENV DAILY_MAX_LOSS=50

# Contract config (matches validated strategies)
ENV CONTRACT_FAMILY=MULTIPLIER
ENV MULTIPLIER=30
ENV TP_SL_MODE=atr
ENV ATR_TP_MULT=2
ENV ATR_SL_MULT=1
ENV DURATION_TICKS=10
ENV TP_PCT=20
ENV SL_PCT=10

COPY --from=build /app/dist/bot.js /app/bot.js

# Health endpoint port — Railway injects PORT (overrides EXPOSE)
EXPOSE 3000

CMD ["node", "/app/bot.js"]
