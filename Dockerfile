# ---- Build stage: install production dependencies ----
FROM node:26-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ---- Runtime stage ----
FROM node:26-alpine

# Upgrade all Alpine packages to patch OS-level vulnerabilities (e.g. zlib CVEs)
RUN apk upgrade --no-cache

# npm/npx/corepack are not needed at runtime (the app runs with plain `node`).
# Removing them drops their bundled packages (glob, minimatch, tar, ...) from
# the image, which are a recurring source of vulnerability scanner findings.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public/ ./public/

EXPOSE 3000

USER node

CMD ["node", "server.js"]
