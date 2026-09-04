# Digest-pinned (security audit L-11) so a moved tag can't swap the base out
# from under a build. Dependabot's docker ecosystem bumps this. Tag kept for
# readability; the @sha256 is what's resolved — if you edit the tag by hand,
# re-resolve the digest too, or the digest silently wins and you ship the old
# major.
#
# Stay on an Active/Maintenance LTS line: Node 20 went EOL 2026-04-30, and 24
# (Krypton) is Active LTS until 2026-10-20, maintenance to 2028-04-30.
# Dependabot will offer Current releases (26 before 2026-10-28) — those are
# ignored in .github/dependabot.yml rather than tracked.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# Bake production mode into the image: the refresh-cookie Secure flag and
# 5xx error redaction key off NODE_ENV, and Express itself runs faster with
# it set. Self-hosters previously ran with NODE_ENV undefined (audit L-22).
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# Fail the BUILD, not prod, if sharp's musl prebuilt didn't land. `npm ci`
# exiting 0 does not prove this: the binary is chosen by detect-libc at
# require() time from the @img/sharp-linuxmusl-* optional deps, so a lockfile
# regenerated off-alpine (which drops them) breaks only when the first image
# upload hits imageProcessor. A Node major bump is exactly when that can slip.
RUN node -e "require('sharp')"

COPY . .

RUN mkdir -p /app/uploads/originals /app/uploads/processed /app/uploads/wine-list-logos \
 && chown -R node:node /app/uploads

USER node

EXPOSE 5000

CMD ["node", "server.js"]
