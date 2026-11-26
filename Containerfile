# CoinKiwi: dependency-free single-container Pocket running as the non-root
# "node" user. Copies server.js, lib/, and public/ with no npm install needed.
FROM docker.io/library/node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# Podman/Docker initialize a fresh named volume mounted at /data from this
# directory, so giving it to "node" here keeps the volume writable for the
# unprivileged runtime user.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080

CMD ["node", "server.js"]
