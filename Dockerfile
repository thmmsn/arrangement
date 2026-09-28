# Trinn 1: installer avhengigheter.
# better-sqlite3 kompileres fra kildekode og trenger Python, make og en C++-kompilator.
# Det fulle node-bildet har alt dette; det lille bildet under har det ikke.
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Trinn 2: selve appen, i et lite bilde uten byggeverktøy.
# Samme Debian-versjon som over, så den kompilerte modulen virker her.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public

# Databasen ligger i et volum, så den overlever nye versjoner av containeren.
# Settes her (ikke i .env), slik at databasen alltid havner i volumet.
ENV DATABASE_PATH=/data/arrangement.db
VOLUME /data
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
