# Runs the MCP server over HTTP, for hosting it somewhere other than the machine running
# the agent. Signing then happens on a phone over WalletConnect — a hosted server has no
# browser to open.
FROM node:22-slim AS build

WORKDIR /app
COPY package*.json ./
COPY wallet/package.json ./wallet/
# `npm ci` runs prepare, which builds both workspaces, so the sources must be in place.
COPY tsconfig.json ./
COPY src ./src
COPY wallet ./wallet
RUN npm ci

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/wallet/dist ./wallet/dist
COPY --from=build /app/wallet/public ./wallet/public
# node_modules/web3-wallet-relay is a workspace symlink to ./wallet, which Node cannot
# resolve without the package manifest it points at.
COPY --from=build /app/wallet/package.json ./wallet/package.json
COPY package.json ./

# MCP_HTTP_PORT is what switches stdio off; hosts that inject PORT should map it to this.
ENV MCP_HTTP_PORT=8080
EXPOSE 8080

# Runs unprivileged: this process holds API keys and can ask a wallet to sign.
USER node

CMD ["node", "dist/index.js"]
