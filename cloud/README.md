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
