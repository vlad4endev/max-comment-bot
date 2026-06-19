# Сборка TypeScript
FROM node:22-alpine AS builder

# better-sqlite3: на Alpine нет готовых prebuild — нужен node-gyp (python + toolchain)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# Продакшен-рантайм
FROM node:22-alpine AS production

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
