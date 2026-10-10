ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}

WORKDIR /app
COPY shared ./shared

WORKDIR /app/api-bun
COPY api-bun/package.json ./package.json

RUN bun install --production

COPY api-bun/src ./src

CMD ["bun", "run", "src/server-b.js"]
