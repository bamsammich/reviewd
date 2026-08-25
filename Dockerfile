# The daemon runs no subprocesses and reads no repository. Clients compute
# their own diffs and upload the blobs, so all that has to be in here is node,
# this package, and somewhere to put a database. Nothing needs git.

FROM node:22-bookworm-slim AS build

# better-sqlite3 ships prebuilt bindings for glibc and compiles from source when
# there is no prebuild for the platform. The toolchain covers that fallback and
# is left behind in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `prepare` compiles TypeScript during install, so the sources have to be here
# before npm ci rather than after it.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY src ./src

RUN npm ci

# Removes the devDependencies without rerunning install scripts, which leaves
# the better-sqlite3 binding built above exactly as it is.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

# The daemon finds its config and database through the XDG variables, so using
# them here gives a container the same layout as a laptop instead of a second
# one to remember.
ENV XDG_CONFIG_HOME=/config \
    XDG_STATE_HOME=/state \
    NODE_ENV=production

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY contrib/docker/entrypoint.sh /usr/local/bin/reviewd-entrypoint

RUN chmod +x /app/dist/cli.js /usr/local/bin/reviewd-entrypoint \
 && ln -s /app/dist/cli.js /usr/local/bin/reviewd \
 && install -d -o node -g node /config/reviewd /state/reviewd

# A fresh named volume takes its ownership from the image, so /state belongs to
# the node user before the volume exists rather than after.
USER node

EXPOSE 7777

# node makes the request because the alternative is installing curl, and a
# health check is a thin reason to carry a package manager into the runtime
# image. The port is the default one: change it in config.json and this needs
# the same edit.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7777/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["reviewd-entrypoint"]

# `--bind-public` stays out of the image on purpose.
#
# The daemon asks for that flag so that opening itself to a network is a
# decision someone makes on the day rather than a config key edited months
# earlier. Baking it in satisfies the check for every container that ever runs,
# including a bare `docker run -p 7777:7777`, which Docker publishes on every
# interface. compose.yaml passes it next to the `ports:` line it belongs with,
# where the two halves of the decision are read together.
CMD ["serve"]
