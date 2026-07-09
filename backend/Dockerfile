FROM node:20-alpine

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
