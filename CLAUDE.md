# CLAUDE.md — docker-info

## Project Overview

**docker-info** — A Node.js/Express dashboard that displays Docker container and host information by communicating with a Docker socket proxy. Designed to work with a socket proxy (e.g. Tecnativa's docker-socket-proxy) rather than mounting the Docker socket directly.

## Running the App

```bash
# Recommended: Docker Compose
docker compose up -d

# Node directly (requires DOCKER_HOST pointing to a socket proxy)
npm start
# App runs at http://localhost:3000
```

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `DOCKER_HOST` | `tcp://socket-proxy:2375` | Docker socket proxy URL |

## Project Structure

```
server.js           Main Express application
package.json        Node dependencies (express, axios)
package-lock.json   Lockfile
Dockerfile          Node 20-alpine image, runs as node user
compose.yaml        Docker Compose config
public/
  index.html        Dashboard HTML
  app.js            Frontend JavaScript
  style.css         Styles
```

## Key Routes

| Route | Purpose |
|---|---|
| `/` | Main dashboard (static HTML) |
| `/api/*` | Docker info API endpoints (proxied from Docker daemon) |

## Key Internals

- **Socket proxy:** Connects to Docker daemon via HTTP (no direct socket mount)
- **CSRF protection:** Validates Origin/Referer headers on all `/api` requests
- **Static serving:** `public/` directory served as static files

## Dependencies

```bash
npm ci --omit=dev
# express, axios
```

## No Tests

There is no automated test suite. CI testing validates Docker build succeeds and the web app responds with HTTP 200.

## Docker

```bash
docker build -t docker-info .
docker compose up -d
```

- Runs as non-root `node` user
- Port: 3000
- Requires a Docker socket proxy accessible at `DOCKER_HOST`

## CI/CD

GitHub Actions workflow (`.github/workflows/docker-ci.yml`):

1. **Triggers:** Push to `main` or PR against `main` (only when `server.js`, `Dockerfile`, `package.json`, or `public/` change)
2. **Build:** Docker image built with BuildX and GHA cache
3. **Test:** Container started on port 3000, HTTP 200 check on homepage (static HTML served regardless of Docker connection)
4. **Version:** Auto semantic version bump on push to main
5. **Release:** GitHub Release created with changelog
6. **Security:** Trivy vulnerability scan (CRITICAL/HIGH) with SARIF upload
7. **Publish:** Image pushed to `ghcr.io/johnfawkes/docker-info`
