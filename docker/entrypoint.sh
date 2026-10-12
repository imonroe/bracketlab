#!/bin/bash
# Container entrypoint, run under tini.
#
#   all     (default) web server and worker together. If either exits, the other is
#           stopped and the container exits with that status, so the restart policy
#           brings both back. A container with a dead worker never looks healthy.
#   web     Next.js server only.
#   worker  queue worker only.
#   smoke-test  check the native toolchain and exit.
#
# web and worker exist so a later release can run this same image as separate
# containers sharing the /data volume.
set -euo pipefail

web() { exec node /app/server.js; }
worker() { exec node /app/dist/worker.mjs; }

case "${1:-all}" in
  web) web ;;
  worker) worker ;;
  smoke-test) exec /usr/local/bin/bracketlab-smoke-test "${@:2}" ;;
  all)
    node /app/server.js &
    web_pid=$!
    node /app/dist/worker.mjs &
    worker_pid=$!

    stopping=0
    stop() {
      kill -TERM "$web_pid" "$worker_pid" 2>/dev/null || true
    }
    trap 'stopping=1; stop' TERM INT

    status=0
    # Returns when the first child exits, or when a trapped signal interrupts it.
    wait -n "$web_pid" "$worker_pid" || status=$?
    for pid in "$web_pid" "$worker_pid"; do
      if [ "$stopping" = 0 ] && ! kill -0 "$pid" 2>/dev/null; then
        name=$([ "$pid" = "$web_pid" ] && echo web || echo worker)
        echo "{\"role\":\"supervisor\",\"event\":\"child_exited\",\"child\":\"$name\",\"status\":$status}" >&2
      fi
    done
    stop
    wait "$web_pid" "$worker_pid" 2>/dev/null || true
    # A requested stop is a clean exit; a child dying on its own is not.
    [ "$stopping" = 1 ] && exit 0
    exit "$status"
    ;;
  *)
    echo "usage: bracketlab-entrypoint [all|web|worker|smoke-test]" >&2
    exit 64
    ;;
esac
