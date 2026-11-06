# Starwake relay (and game files) for Fly.io, Railway or any container host.
#   docker build -t starwake . && docker run -p 8080:8080 -e RELAY_ONLY=1 starwake
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY index.html ./
COPY css ./css
COPY js ./js
COPY vendor ./vendor
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server/server.mjs"]
