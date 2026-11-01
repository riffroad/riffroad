#!/usr/bin/env bash
# Lets GitHub Actions deploy the server (.github/workflows/deploy-cloud.yml) without any key:
# Google trusts the repository's own tokens (workload identity federation), for its main branch
# only, and lends them an account that can push an image and update the service, nothing else.
# Once per project, after deploy.sh:
#   ./github-deploy.sh <project-id> [owner/repo]
# Uses your own `gcloud` and `gh` logins (`CLOUDSDK_CORE_ACCOUNT=…` picks the gcloud one).
set -euo pipefail
P=${1:?usage: ./github-deploy.sh <project-id> [owner/repo]}
REPO=${2:-riffroad/riffroad}
REGION=europe-west1
SERVICE=opensmith-api
RUNTIME="$SERVICE@$P.iam.gserviceaccount.com"
DEPLOYER=github-deployer
SA="$DEPLOYER@$P.iam.gserviceaccount.com"
POOL=github
IMAGES=server
cd "$(dirname "$0")"
gc() { gcloud --project "$P" --quiet "$@"; }
NUMBER=$(gcloud projects describe "$P" --format 'value(projectNumber)')
# The repository's number, not its name: a name can be taken by someone else after a rename.
REPO_ID=$(gh api "repos/$REPO" -q .id)

gc services enable iamcredentials.googleapis.com sts.googleapis.com artifactregistry.googleapis.com

echo "== The server's images, the last five kept"
gc artifacts repositories describe "$IMAGES" --location "$REGION" >/dev/null 2>&1 \
  || gc artifacts repositories create "$IMAGES" --repository-format docker --location "$REGION"
POLICY=$(mktemp)
cat >"$POLICY" <<'EOF'
[
  { "name": "keep-last-five", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 5 } },
  { "name": "drop-the-rest", "action": { "type": "Delete" }, "condition": { "tagState": "ANY" } }
]
EOF
gc artifacts repositories set-cleanup-policies "$IMAGES" --location "$REGION" --policy "$POLICY" --no-dry-run >/dev/null
rm -f "$POLICY"

echo "== The deployer: push an image, update the service, run it as the server's own account"
gc iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || gc iam service-accounts create "$DEPLOYER" --display-name "Deploys the server from GitHub"
gc artifacts repositories add-iam-policy-binding "$IMAGES" --location "$REGION" \
  --member "serviceAccount:$SA" --role roles/artifactregistry.writer >/dev/null
for role in roles/run.developer roles/serviceusage.serviceUsageConsumer; do
  gc projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
done
gc iam service-accounts add-iam-policy-binding "$RUNTIME" --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null

echo "== GitHub's tokens, for $REPO's main branch only"
gc iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1 \
  || gc iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions"
gc iam workload-identity-pools providers describe github --location global --workload-identity-pool "$POOL" >/dev/null 2>&1 \
  || gc iam workload-identity-pools providers create-oidc github --location global --workload-identity-pool "$POOL" \
    --display-name "GitHub" --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main'"
gc iam service-accounts add-iam-policy-binding "$SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository_id/$REPO_ID" >/dev/null

echo
echo "In .github/workflows/deploy-cloud.yml:"
echo "  workload_identity_provider: projects/$NUMBER/locations/global/workloadIdentityPools/$POOL/providers/github"
echo "  service_account: $SA"
