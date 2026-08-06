# Shared image for both the API server and the BullMQ worker — the two
# processes run from the same build, just with a different start command
# (see docker-compose.yml, which overrides CMD for the worker service).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/data-access/migrations ./src/data-access/migrations

EXPOSE 3001
CMD ["node", "dist/entry-points/api/server.js"]
