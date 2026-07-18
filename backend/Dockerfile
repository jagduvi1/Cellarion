# Digest-pinned (security audit L-11) so a moved tag can't swap the base out
# from under a build. Dependabot's docker ecosystem bumps this. Tag kept for
# readability; the @sha256 is what's resolved.
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66

# Bake production mode into the image: the refresh-cookie Secure flag and
# 5xx error redaction key off NODE_ENV, and Express itself runs faster with
# it set. Self-hosters previously ran with NODE_ENV undefined (audit L-22).
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/uploads/originals /app/uploads/processed /app/uploads/wine-list-logos \
 && chown -R node:node /app/uploads

USER node

EXPOSE 5000

CMD ["node", "server.js"]
