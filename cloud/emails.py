"""The e-mails Firebase sends for Riffroad (a new password, the address to confirm), in French
then English, from « Riffroad ». Once per project, and after any change here:

    python3 emails.py <project-id>

Uses your own `gcloud` login (`CLOUDSDK_CORE_ACCOUNT=…` picks it)."""

import json
import subprocess
import sys
import urllib.error
import urllib.request

FOOT = "<p style='color:#888'>Riffroad · un jeu de guitare libre pour macOS · a free guitar game for macOS</p>"

TEMPLATES = {
    "resetPasswordTemplate": {
        "subject": "Riffroad : nouveau mot de passe · new password",
        "body": (
            "<p>Bonjour,</p>"
            "<p>Pour choisir un nouveau mot de passe pour ton compte Riffroad (%EMAIL%), ouvre ce lien :</p>"
            "<p><a href='%LINK%'>Choisir un nouveau mot de passe</a></p>"
            "<p>Tu n’as rien demandé ? Ignore ce message : ton mot de passe ne change pas.</p>"
            "<hr>"
            "<p>Hi,</p>"
            "<p>To choose a new password for your Riffroad account (%EMAIL%), open this link:</p>"
            "<p><a href='%LINK%'>Choose a new password</a></p>"
            "<p>Didn’t ask for it? Ignore this message: your password stays the same.</p>" + FOOT
        ),
    },
    "verifyEmailTemplate": {
        "subject": "Riffroad : confirme ton e-mail · confirm your e-mail",
        "body": (
            "<p>Bonjour,</p>"
            "<p>Un clic pour confirmer ton adresse (%EMAIL%) et garder ta carrière et ta progression en ligne, sur tous tes Mac :</p>"
            "<p><a href='%LINK%'>Confirmer mon e-mail</a></p>"
            "<p>Puis reviens dans Riffroad, Réglages → Compte.</p>"
            "<hr>"
            "<p>Hi,</p>"
            "<p>One click to confirm your address (%EMAIL%) and keep your career and progress online, on all your Macs:</p>"
            "<p><a href='%LINK%'>Confirm my e-mail</a></p>"
            "<p>Then back in Riffroad, Settings → Account.</p>" + FOOT
        ),
    },
}


def main() -> None:
    project = sys.argv[1]
    token = subprocess.run(["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True).stdout.strip()
    templates = {name: {**t, "senderDisplayName": "Riffroad", "senderLocalPart": "noreply", "bodyFormat": "HTML"} for name, t in TEMPLATES.items()}
    mask = ",".join(f"notification.sendEmail.{name}" for name in templates)
    request = urllib.request.Request(
        f"https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/config?updateMask={mask}",
        data=json.dumps({"notification": {"sendEmail": templates}}).encode(),
        method="PATCH",
        headers={"Authorization": f"Bearer {token}", "x-goog-user-project": project, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as reply:
            sent = json.load(reply)["notification"]["sendEmail"]
    except urllib.error.HTTPError as e:
        sys.exit(f"refused: {e.code} {e.read().decode()}")
    for name in templates:
        print(f"{name}: {sent[name]['subject']} (from {sent[name]['senderDisplayName']})")


if __name__ == "__main__":
    main()
