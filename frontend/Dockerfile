# ── Stage 1: build React app ──────────────────────────────────────────────────
# Digest-pinned (security audit L-11); Dependabot's docker ecosystem bumps it.
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .

# APP_VERSION is passed by CI but not read by the frontend (useVersion hook
# fetches /api/health instead). Kept as a placeholder for future image labels.
ARG APP_VERSION=

# Umami analytics (optional): if these are set at build time, the Analytics component
# injects the tracker script. Empty values are a no-op (no script, no CSP impact).
ARG VITE_UMAMI_URL=
ARG VITE_UMAMI_WEBSITE_ID=
# Public site URL baked into canonical/SEO meta tags (config/siteUrl.js).
# Empty falls back to https://cellarion.app — self-hosters set their own domain.
ARG VITE_SITE_URL=
ENV VITE_UMAMI_URL=$VITE_UMAMI_URL \
    VITE_UMAMI_WEBSITE_ID=$VITE_UMAMI_WEBSITE_ID \
    VITE_SITE_URL=$VITE_SITE_URL

RUN npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────────────────────
# Unprivileged variant: master + workers run as the non-root `nginx` user
# (uid 101), so an nginx compromise never holds root in the container (audit
# L-25). Non-root cannot bind <1024, so the server listens on 8080 — compose
# and Traefik map onto that port.
FROM nginxinc/nginx-unprivileged:alpine@sha256:a718212f9cf21e241f14067333000a3f0930292f5354fe0db269e9a2a2596b9e

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared security-header snippet, include'd by every HTML-serving location.
# Lives outside conf.d/ so nginx does not auto-load it a second time at the
# http{} level.
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
