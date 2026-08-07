#!/usr/bin/env bash
# Server di sviluppo di VIBE FPS.
#
# Non è più `python3 -m http.server`: quello risponde con header cacheabili e
# il browser può servire un modulo vecchio insieme ad altri aggiornati. Con gli
# ES module l'import si risolve al link, quindi un export mancante blocca il
# boot e l'overlay resta allo 0% senza errori in pagina. Questo server manda
# `Cache-Control: no-store` su tutto e rende quella condizione impossibile.
#
#   ./startServer.sh          → http://localhost:8080
#   ./startServer.sh 3000     → porta esplicita
set -euo pipefail
cd "$(dirname "$0")"
exec node tools/dev-server.mjs "$@"
