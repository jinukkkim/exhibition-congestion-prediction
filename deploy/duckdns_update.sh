#!/usr/bin/env bash
# Keeps the duckdns hostname pointed at this box. Installed as a cron job on the
# server (see README "DNS renewal"); deploy.sh does not call it.
#
# The token lives in a file rather than inline in the crontab because cron logs
# every command it runs to the journal verbatim:
#
#   CRON[411116]: (ubuntu) CMD (curl -fsS "https://…&token=<the actual token>…")
#
# That is a permanent, greppable copy of the credential in `journalctl -u cron`,
# which no amount of care elsewhere undoes. Same treatment as .backup_par.
set -euo pipefail

DOMAIN=exhibition-traffic   # public; it is in deploy/Caddyfile
CONF="${CONF:-/home/ubuntu/.duckdns}"

[ -r "$CONF" ] || { echo "missing $CONF — see README 'DNS renewal'" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONF"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN is not set in $CONF}"

# --config - reads the request off stdin, so the token never appears in curl's
# argv either. It would otherwise be visible to `ps` for the life of the call.
# Empty ip= tells duckdns to use the source address of this request.
response="$(curl -fsS --max-time 30 --config - <<CURL
url = "https://www.duckdns.org/update?domains=$DOMAIN&token=$DUCKDNS_TOKEN&ip="
CURL
)"

# duckdns answers 200 with a body of "KO" for a bad or rotated token, so -f
# alone would call that a success and the hostname would quietly stop being
# renewed until it expired. The body is the only real signal here.
if [ "$response" != "OK" ]; then
  echo "duckdns refused the update for $DOMAIN: ${response:-<empty>}" >&2
  exit 1
fi
