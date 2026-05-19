# ── Stage 1: build React app ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

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
ENV VITE_UMAMI_URL=$VITE_UMAMI_URL \
    VITE_UMAMI_WEBSITE_ID=$VITE_UMAMI_WEBSITE_ID

RUN npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
