FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/uploads/originals /app/uploads/processed /app/uploads/wine-list-logos \
 && chown -R node:node /app/uploads

USER node

EXPOSE 5000

CMD ["node", "server.js"]
