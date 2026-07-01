# ── Stage 1: Dependencies ──
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production

# ── Stage 2: Final tiny image ──
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY index.ts ./
EXPOSE 3001
CMD ["bun", "index.ts"]
