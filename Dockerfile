FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/src ./dist/src
# setup-db.js (migrations + seed) roda no serviço `setup` do compose e no
# comando de pré-deploy; as migrations são lidas de /app/migrations.
COPY --from=build /app/dist/scripts ./dist/scripts
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
