#!/bin/sh
set -e

# Hosts mount volumes owned by root, but this process runs unprivileged — it holds API keys
# and can ask a wallet to sign. So when started as root, take ownership of the data
# directory and immediately drop to `node`; when started as `node` already, just run.
DATA_DIR="${XDG_CONFIG_HOME:-/home/node/.config}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
