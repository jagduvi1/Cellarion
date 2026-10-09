# ── Stage 1: build React app ──────────────────────────────────────────────────
# Digest-pinned (security audit L-11); Dependabot's docker ecosystem bumps it.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

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
FROM nginxinc/nginx-unprivileged:alpine@sha256:26b0bf6fbf07297983cb341998d79c831508787de26627dd2a112321b9c3a4af

COPY --from=builder /app/dist /usr/share/nginx/html
# The stock main config with more connections per worker (see its header).
COPY nginx-main.conf /etc/nginx/nginx.conf
# A template, not the config itself: the image's entrypoint renders it into
# conf.d/default.conf at start, filling ${NGINX_LOCAL_RESOLVERS} from the
# container's /etc/resolv.conf (see the upstream block in nginx.conf). Only
# names of set environment variables are substituted, so nginx's own
# $variables are left alone. The entrypoint fills the variable only when
# asked to (NGINX_ENTRYPOINT_LOCAL_RESOLVERS); a value set in the
# environment wins over the file.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY nginx.conf /etc/nginx/templates/default.conf.template
# Shared security-header snippet, include'd by every HTML-serving location.
# Lives outside conf.d/ so nginx does not auto-load it a second time at the
# http{} level.
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
