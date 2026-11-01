#!/usr/bin/env bash
# Puts OpenSmith's online side on a Firebase project, or deploys a new version of the server:
#   ./deploy.sh <project-id> [billing-account-id]
# The billing account (Cloud Run needs one) is linked, and a 5-unit monthly budget alert set on
# it, only when given. Uses your own `gcloud` and `firebase` logins. Run from anywhere.
set -euo pipefail
P=${1:?usage: ./deploy.sh <project-id> [billing-account-id]}
BILLING=${2:-}
REGION=europe-west1
SERVICE=opensmith-api
SA="$SERVICE@$P.iam.gserviceaccount.com"
cd "$(dirname "$0")"
gc() { gcloud --project "$P" --quiet "$@"; }

if [ -n "$BILLING" ]; then
  gcloud billing projects link "$P" --billing-account "$BILLING" --quiet
  gcloud billing budgets create --billing-account "$BILLING" --display-name "OpenSmith" --budget-amount 5 \
    --filter-projects "projects/$P" --threshold-rule percent=0.5 --threshold-rule percent=1.0 --quiet || true
fi

echo "== Services"
gc services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com identitytoolkit.googleapis.com apikeys.googleapis.com

echo "== Firestore (europe-west1), closed to direct access"
gc firestore databases describe --database='(default)' >/dev/null 2>&1 || gc firestore databases create --location "$REGION"
firebase deploy --only firestore --project "$P" --non-interactive

echo "== Sign-in by e-mail and password"
curl -sf -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$P/config?updateMask=signIn.email" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $P" -H "Content-Type: application/json" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}' >/dev/null \
  || echo "!! Turn it on by hand: https://console.firebase.google.com/project/$P/authentication/providers (Email/Password)"

echo "== The server's own account: Firestore only"
gc iam service-accounts describe "$SA" >/dev/null 2>&1 || gc iam service-accounts create "$SERVICE" --display-name "OpenSmith server"
gc projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role roles/datastore.user --condition None >/dev/null

echo "== Cloud Run"
gc run deploy "$SERVICE" --source . --region "$REGION" --service-account "$SA" --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --memory 256Mi --cpu 1 --concurrency 80 --timeout 30s \
  --set-env-vars "OPENSMITH_PROJECT=$P"
URL=$(gc run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
curl -sf "$URL/health" >/dev/null && echo "health: ok"

echo "== The app's public key (sign-in and token refresh only)"
APP=$(firebase apps:list WEB --project "$P" --json | python3 -c "import json,sys; a=json.load(sys.stdin).get('result',[]); print(a[0]['appId'] if a else '')")
[ -n "$APP" ] || APP=$(firebase apps:create WEB OpenSmith --project "$P" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['appId'])")
KEY=$(firebase apps:sdkconfig WEB "$APP" --project "$P" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['sdkConfig']['apiKey'])")
KEY_NAME=$(gc services api-keys lookup "$KEY" --format 'value(name)')
gc services api-keys update "$KEY_NAME" --api-target=service=identitytoolkit.googleapis.com --api-target=service=securetoken.googleapis.com

echo
echo "In app/src-tauri/src/cloud.rs:"
echo "  const FIREBASE_KEY: &str = \"$KEY\";"
echo "  const SERVER: &str = \"$URL\";"
