# Runs the MCP server over HTTP, for hosting it somewhere other than the machine running
# the agent. Signing then happens on a phone over WalletConnect — a hosted server has no
# browser to open.
FROM node:22-slim AS build

WORKDIR /app
COPY package*.json ./
COPY mcp/package.json ./mcp/
COPY wallet-relay/package.json ./wallet-relay/
# `npm ci` runs prepare, which builds both workspaces, so the sources must be in place.
COPY mcp ./mcp
COPY wallet-relay ./wallet-relay
RUN npm ci

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/mcp/dist ./mcp/dist
COPY --from=build /app/mcp/package.json ./mcp/package.json
COPY --from=build /app/wallet-relay/dist ./wallet-relay/dist
COPY --from=build /app/wallet-relay/public ./wallet-relay/public
# node_modules/web3-wallet-relay is a workspace symlink to ./wallet-relay, which Node
# cannot resolve without the package manifest it points at.
COPY --from=build /app/wallet-relay/package.json ./wallet-relay/package.json
COPY package.json ./

# MCP_HTTP_PORT is what switches stdio off; hosts that inject PORT should map it to this.
ENV MCP_HTTP_PORT=8080
# The process drops to `node`, whose HOME stays /root, so the OAuth and WalletConnect
# stores would land somewhere it cannot write. This is also what the entrypoint chowns —
# mount a volume here (or override it, as fly.toml does) to keep a pairing across deploys.
ENV XDG_CONFIG_HOME=/home/node/.config
EXPOSE 8080

# Starts as root only long enough to take ownership of a mounted volume, then drops to the
# unprivileged `node` user. See docker-entrypoint.sh.
COPY docker-entrypoint.sh /usr/local/bin/
ENTRYPOINT ["docker-entrypoint.sh"]

CMD ["node", "mcp/dist/index.js"]
