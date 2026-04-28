# ── Stage 1: build React app ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .

ARG APP_VERSION=
# Umami analytics (optional): if these are set at build time, the Analytics component
# injects the tracker script. Empty values are a no-op (no script, no CSP impact).
ARG REACT_APP_UMAMI_URL=
ARG REACT_APP_UMAMI_WEBSITE_ID=
RUN export REACT_APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}" \
    REACT_APP_UMAMI_URL="${REACT_APP_UMAMI_URL}" \
    REACT_APP_UMAMI_WEBSITE_ID="${REACT_APP_UMAMI_WEBSITE_ID}" \
 && npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
