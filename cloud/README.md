# OpenSmith online

The player's saves kept online, so a career goes on from one Mac to another: an account by
e-mail (Firebase Authentication), the career and the progress stored per player (Firestore),
and a small server between the two (Rust, on Cloud Run). The app works the same without it.

- `api/`: what the app and the server say to each other (routes, formats, limits), shared by
  both (`app/src-tauri` depends on it).
- `server/`: the server. Every route but `/health` wants a Firebase ID token; a save is written
  only over the version it was based on, so two Macs never overwrite each other (409 instead,
  and the app asks which to keep). 30 requests a minute per player, 512 KB a save.
- `firestore.rules`: no direct access, only the server's own account reads and writes.

## Tests, against the Firebase emulators

Firebase's tools (`npm install -g firebase-tools`) and Java 21:

```bash
firebase emulators:exec --project demo-opensmith --only auth,firestore 'cargo test'
```

The app's side, against this server and the emulators (from here too):

```bash
firebase emulators:exec --project demo-opensmith --only auth,firestore 'cargo test --manifest-path ../app/src-tauri/Cargo.toml cloud'
```

Without the emulators, these tests say they were skipped and pass.

## Deploy

```bash
./deploy.sh <project-id> [billing-account-id]
```

Services, Firestore in europe-west1 with its rules, sign-in by e-mail, the server's own account,
Cloud Run (0 to 2 instances), and the app's public key restricted to sign-in. It ends with the
two values to put in `app/src-tauri/src/cloud.rs` (until then the app hides the account).

Then, once, so that GitHub deploys the server itself:

```bash
./github-deploy.sh <project-id> [owner/repo]
```

A push to `main` that changes `cloud/` runs `.github/workflows/deploy-cloud.yml`: the tests
against the emulators, then the image built on GitHub, pushed to the project (the last five
kept) and put on Cloud Run, its address unchanged. No key is stored on GitHub: Google trusts the
repository's own tokens, for its main branch only (workload identity federation), and lends them
an account that can push an image and update the service, nothing else. `deploy.sh` stays for
the first setup and for Firestore's rules.

Once per project too: an e-mail when the server breaks (server errors, or slow answers for ten
minutes, read from real requests only: the server still sleeps at zero instances), and the
e-mails Firebase sends signed « Riffroad » (the app asks for them in the player's language):

```bash
./alerts.sh <project-id> <e-mail>
python3 emails.py <project-id>
```

## Events

`server/events.json` says what is on for every player: a festival that pays the career's gigs
more (`"career": { "fans": 1.5, "money": 1.5 }`, 1 to 3), or a weekly challenge picked by hand
(`"challenge": { "song": …, "level": … }`, a shipped song, the event spanning its week from
Monday 00:00 UTC). Dates are `YYYY-MM-DDTHH:MM:SSZ`; titles and texts in French and English. The
file is built into the server: edit it, push, and the deployment carries it, once the tests have
checked every event. The app hears of events on now or within two weeks.

## What the server keeps

Per player (`users/{uid}`): the two saves and the five before each (`saves/{slot}`, `history`),
a name for the boards, a friend code (`codes/{code}`), a card for friends (band, act, fans, fans
won this week), the friends followed. Per week (`challenges/w{week}/scores/{uid}`): each
player's best run of the weekly challenge and its trace (points at each second, the ghost
others race). All of it goes with the account (`DELETE /v1/account`). Firestore can be read
back as it was at any minute of the last seven days (point-in-time recovery).

