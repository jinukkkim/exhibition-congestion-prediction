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

# Every failure line is stamped. Without it a log of "502" repeated fifty times
# cannot distinguish one upstream outage from a chronic rate, which is the first
# question anyone asks when they open this file.
log() { echo "$(TZ=Asia/Seoul date -Is) $*" >&2; }

[ -r "$CONF" ] || { log "missing $CONF — see README 'DNS renewal'"; exit 1; }
# shellcheck source=/dev/null
. "$CONF"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN is not set in $CONF}"

# --config - reads the request off stdin, so the token never appears in curl's
# argv either. It would otherwise be visible to `ps` for the life of the call.
# Empty ip= tells duckdns to use the source address of this request.
#
# --retry because duckdns returns 502 for a fifth of these calls (measured: 55
# failures in 276 runs over 23 hours, 52 of them 502). Ten consecutive manual
# requests during that period all returned 200, so the errors are short and
# scattered rather than sustained outages — exactly the shape a retry absorbs.
# curl already treats 5xx as retryable, so this needs no --retry-all-errors.
if ! response="$(curl -fsS --retry 3 --max-time 30 --config - <<CURL
url = "https://www.duckdns.org/update?domains=$DOMAIN&token=$DUCKDNS_TOKEN&ip="
CURL
)"; then
  # curl has already printed its own reason to stderr; this adds the timestamp
  # and says which name failed, so the log line stands on its own.
  log "curl could not reach duckdns for $DOMAIN — see the line above"
  exit 1
fi

# duckdns answers 200 with a body of "KO" for a bad or rotated token, so -f
# alone would call that a success and the hostname would quietly stop being
# renewed until it expired. The body is the only real signal here.
if [ "$response" != "OK" ]; then
  log "duckdns refused the update for $DOMAIN: ${response:-<empty>}"
  exit 1
fi
