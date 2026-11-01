#!/usr/bin/env bash
# An e-mail when the server breaks: server errors (5xx), or answers slow for ten minutes. Both
# are read from real requests only: nothing pings the server, so it still sleeps at zero
# instances when nobody plays. Once per project:
#   ./alerts.sh <project-id> <e-mail>
# Uses your own `gcloud` login (`CLOUDSDK_CORE_ACCOUNT=…` picks it).
set -euo pipefail
P=${1:?usage: ./alerts.sh <project-id> <e-mail>}
EMAIL=${2:?usage: ./alerts.sh <project-id> <e-mail>}
SERVICE=opensmith-api
gc() { gcloud --project "$P" --quiet "$@"; }

gc services enable monitoring.googleapis.com
CHANNEL=$(gc beta monitoring channels list --filter "type=\"email\" AND labels.email_address=\"$EMAIL\"" --format 'value(name)' | head -1)
[ -n "$CHANNEL" ] || CHANNEL=$(gc beta monitoring channels create --display-name "Riffroad: $EMAIL" --type email \
  --channel-labels "email_address=$EMAIL" --format 'value(name)')

policy() { # <name> <condition JSON>
  local file
  file=$(mktemp)
  cat >"$file" <<EOF
{
  "displayName": "Riffroad: $1",
  "combiner": "OR",
  "conditions": [$2],
  "notificationChannels": ["$CHANNEL"],
  "alertStrategy": { "autoClose": "86400s" }
}
EOF
  local existing
  existing=$(gc alpha monitoring policies list --filter "display_name=\"Riffroad: $1\"" --format 'value(name)' | head -1)
  if [ -n "$existing" ]; then gc alpha monitoring policies update "$existing" --policy-from-file "$file" >/dev/null
  else gc alpha monitoring policies create --policy-from-file "$file" >/dev/null; fi
  rm -f "$file"
  echo "alert: $1"
}

policy "server errors" '{
  "displayName": "More than 3 answers 5xx in 5 minutes",
  "conditionThreshold": {
    "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"'"$SERVICE"'\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\"",
    "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM" }],
    "comparison": "COMPARISON_GT",
    "thresholdValue": 3,
    "duration": "0s"
  }
}'

policy "slow answers" '{
  "displayName": "95 % of the answers slower than 2 s, for 10 minutes",
  "conditionThreshold": {
    "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"'"$SERVICE"'\" AND metric.type=\"run.googleapis.com/request_latencies\"",
    "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_PERCENTILE_95", "crossSeriesReducer": "REDUCE_MAX" }],
    "comparison": "COMPARISON_GT",
    "thresholdValue": 2000,
    "duration": "600s"
  }
}'
