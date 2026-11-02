# The relay (decision 4 of the mobile spec, lane E of the mobile wave): one
# process the team runs behind a TLS proxy. Built from the repository root:
#
#   docker build -f packages/server/relay.Dockerfile -t clave-relay .
#   docker run -d --name clave-relay --restart unless-stopped \
#     -p 127.0.0.1:8787:8787 -v clave-relay-data:/data \
#     -e RELAY_ISSUER=https://account.antasphere.com clave-relay
#
# The proxy terminates TLS and forwards to 8787, WebSocket upgrades included
# (`docs/mobile-relay.md`). Bun runs the TypeScript as it is: the contract
# package is copied in as a module and only what the relay imports is
# installed (`relay.package.json`), so the image carries neither Electron
# nor the server's other dependencies.
FROM oven/bun:1.4.1-slim@sha256:887d0f37f674c69984be4e397fef29ca0d74df1e75155431abbe857258bffde5
WORKDIR /app
COPY package-lock.json /inputs/package-lock.json
COPY packages/server/relay.package.json packages/server/relay-dependencies.mjs /inputs/
RUN bun /inputs/relay-dependencies.mjs /inputs/package-lock.json /inputs/relay.package.json /app \
  && bun install --production --frozen-lockfile --ignore-scripts \
  && bun /inputs/relay-dependencies.mjs --verify /app
COPY packages/contract ./node_modules/@clave/contract
COPY packages/server/src/relay ./packages/server/src/relay
ENV RELAY_PORT=8787 RELAY_HOST=0.0.0.0 RELAY_DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:' + process.env.RELAY_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "packages/server/src/relay/main.ts"]
