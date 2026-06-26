FROM node:24-alpine

# Upgrade all Alpine packages to patch OS-level vulnerabilities (e.g. zlib CVEs)
RUN apk upgrade --no-cache

# Upgrade npm to patch vulnerabilities in its bundled packages
# (node-tar, minimatch, glob, cross-spawn, brace-expansion, jsdiff)
RUN npm install -g npm@latest

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

EXPOSE 3000

USER node

CMD ["node", "server.js"]
