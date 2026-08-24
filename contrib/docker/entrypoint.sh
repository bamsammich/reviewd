#!/bin/sh
# Two checks the daemon cannot make for itself, both guarding one failure: a
# container that starts, reports healthy, and answers nobody. The gate fails
# closed, so a daemon nothing can reach reads as reviewd being down rather than
# as a line in a config file.
set -e

config="${XDG_CONFIG_HOME:-/config}/reviewd/config.json"

read_key() {
  node -e '
    const fs = require("fs")
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.stdout.write(String(config[process.argv[2]] ?? ""))
  ' "$config" "$1"
}

if [ ! -f "$config" ]; then
  cat >&2 <<EOF
reviewd: no config at $config.

Copy contrib/docker/config.example.json into the directory mounted there, set
public_url to the address a reviewer's phone should open, and start again.
EOF
  exit 1
fi

# Loopback inside a container is the container's own loopback. A published port
# forwards to the container's external address, so a daemon bound to 127.0.0.1
# answers nothing outside itself.
case "$(read_key host)" in
  127.0.0.1 | ::1 | localhost | '')
    cat >&2 <<EOF
reviewd: host in $config is this container's own loopback, which a published
port does not reach. Set host to 0.0.0.0, and decide who may read and approve
reviews with the host address you publish the port on.
EOF
    exit 1
    ;;
esac

exec reviewd "$@"
