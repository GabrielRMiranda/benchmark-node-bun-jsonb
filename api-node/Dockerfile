ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-alpine

WORKDIR /app
COPY shared ./shared

WORKDIR /app/api-node
COPY api-node/package.json api-node/package-lock.json ./
RUN npm ci --omit=dev

COPY api-node/src ./src

CMD ["node", "src/server-b.js"]
