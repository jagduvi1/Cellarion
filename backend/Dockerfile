FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev \
 # sharp ships its native binary + libvips as platform-specific optional deps.
 # The committed lockfile only references the linuxmusl-x64 binaries inside
 # sharp's optionalDependencies — it has no installable package entries for
 # them — so `npm ci` leaves sharp unloadable on Alpine/musl. Install the exact
 # locked versions explicitly so the image can load sharp.
 && npm install --no-save \
      @img/sharp-linuxmusl-x64@0.34.5 \
      @img/sharp-libvips-linuxmusl-x64@1.2.4

COPY . .

RUN mkdir -p /app/uploads/originals /app/uploads/processed /app/uploads/wine-list-logos \
 && chown -R node:node /app/uploads

USER node

EXPOSE 5000

CMD ["node", "server.js"]
