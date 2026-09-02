# Сборка TypeScript. NODE_IMAGE можно подменить зеркалом, если Docker Hub недоступен.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS builder

ARG GIT_COMMIT=unknown

# Node 17+ предпочитает IPv6; в Docker это часто зависает ~100с, npm падает с "Exit handler never called"
ENV NODE_OPTIONS=--dns-result-order=ipv4first \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=600000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# better-sqlite3: на Alpine нет готовых prebuild — нужен node-gyp (python + toolchain)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

# GIT_COMMIT сбрасывает кэш builder при каждом новом деплое (см. scripts/deploy.sh)
RUN echo "build commit: ${GIT_COMMIT}" && npm run build && npm prune --omit=dev

# Продакшен-рантайм
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS production

ARG GIT_COMMIT=unknown

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache curl

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# GIT_COMMIT меняется на каждый deploy — сбрасывает кэш статики admin/miniapp
RUN echo "git commit: ${GIT_COMMIT}" >/dev/null
COPY miniapp ./miniapp
COPY admin-panel ./admin-panel

LABEL org.opencontainers.image.revision="${GIT_COMMIT}"

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
