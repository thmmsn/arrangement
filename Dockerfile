FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY views ./views
COPY public ./public

# Databasen ligger i et volum, så den overlever nye versjoner av containeren.
ENV DATABASE_PATH=/data/booking.db
VOLUME /data
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
