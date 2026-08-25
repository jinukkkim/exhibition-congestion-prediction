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
# Not `: "${DUCKDNS_TOKEN:?…}"`: that exits through bash's own message, with no
# timestamp, which would make the claim above false for the one case most likely
# to happen — the file present but its token line emptied during a rotation.
[ -n "${DUCKDNS_TOKEN:-}" ] || { log "DUCKDNS_TOKEN is not set in $CONF"; exit 1; }

# --config - reads the request off stdin, so the token never appears in curl's
# argv either. It would otherwise be visible to `ps` for the life of the call.
# Empty ip= tells duckdns to use the source address of this request.
#
# --retry because duckdns returns 502 for a fifth of these calls (measured: 55
# failures in 276 runs over 23 hours, 52 of them 502). Ten consecutive manual
# requests during that period all returned 200, so the errors are short and
# scattered rather than sustained outages — exactly the shape a retry absorbs.
# curl already treats 5xx as retryable, so this needs no --retry-all-errors.
#
# curl's own stderr is held back rather than let through. It prints a line for
# every failed attempt — including the ones --retry then absorbs, because it
# prints them before the outcome is known — so letting it reach the log filled
# the file with complaints from runs that had in fact succeeded. Verified: one
# request answering 502 and its retry answering 200 exits 0 and still emits
# `curl: (22) … error: 502`. A log that reports success as failure is worse
# than no log, so the message is only surfaced when the whole call failed.
#
# It cannot simply be merged with 2>&1 either: the absorbed error would then be
# part of `$response`, and the "OK" body check below would never match.
curl_err="$(mktemp)"
trap 'rm -f "$curl_err"' EXIT
if ! response="$(curl -fsS --retry 3 --max-time 30 --config - 2>"$curl_err" <<CURL
url = "https://www.duckdns.org/update?domains=$DOMAIN&token=$DUCKDNS_TOKEN&ip="
CURL
)"; then
  log "curl could not reach duckdns for $DOMAIN: $(tr '\n' ' ' < "$curl_err")"
  exit 1
fi

# duckdns answers 200 with a body of "KO" for a bad or rotated token, so -f
# alone would call that a success and the hostname would quietly stop being
# renewed until it expired. The body is the only real signal here.
if [ "$response" != "OK" ]; then
  log "duckdns refused the update for $DOMAIN: ${response:-<empty>}"
  exit 1
fi
