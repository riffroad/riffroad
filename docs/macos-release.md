# Building and shipping the macOS app

## Build

```bash
cd app && npm ci && npm run tauri build
```

The app and a disk image land in `app/src-tauri/target/release/bundle/` (`macos/Riffroad.app`,
`dmg/Riffroad_<version>_aarch64.dmg`). Apple Silicon only.

**A release build** reads two things kept off the repository, in `~/.config/riffroad/release.env`:

- `RIFFROAD_GOOGLE_CLIENT_SECRET`: the desktop OAuth client's secret, for signing in with Google
  (`app/src-tauri/src/google.rs` has the client's id; Google Cloud → Google Auth Platform →
  Clients → « Riffroad desktop app »). Without it, no Google button (e-mail sign-in stays).
- `APPLE_SIGNING_IDENTITY="Riffroad Code Signing"`: the app signed with Riffroad's own
  certificate instead of ad hoc, so that macOS can tell every version is the same app (what the
  player allowed it, the microphone first, is meant to carry over). Without it, the build is
  signed ad hoc, as `tauri.conf.json` says. The account's sign-in is not in the keychain:
  without an Apple team, macOS asked for the player's password after each update, even signed.

```bash
set -a; . ~/.config/riffroad/release.env; set +a; cd app && npm run tauri build
```

The certificate is self-signed (10 years), in the login keychain, with its backup in
`~/.config/riffroad/signing.p12` (password in `signing.p12.pass`). Keep that backup: a new
certificate would make macOS ask every player again. On another Mac:
`security import ~/.config/riffroad/signing.p12 -k ~/Library/Keychains/login.keychain-db -P "$(cat ~/.config/riffroad/signing.p12.pass)" -T /usr/bin/codesign`.
It does not replace a Developer ID: Gatekeeper still asks on first launch (below).

## What a built app uses on the player's Mac

| What | Where |
|---|---|
| Song library | `~/Music/OpenSmith` (`OPENSMITH_LIBRARY` to change it) |
| Song converter (Python pipeline) | carried inside the app, installed on the first import into `~/Library/Application Support/app.opensmith.desktop/pipeline-ingest` |
| Settings | the app's web storage |
| Progress, career | the library folder: `progress.json`, `career.json` |
| Account sign-in (e-mail, refresh token) | `~/Library/Application Support/app.opensmith.desktop/account.json`, readable by the player only (0600); signing out deletes it |

The first import installs the converter: `uv sync` downloads Python 3.11, PyTorch, Demucs and
Basic Pitch (about 2 GB, a few minutes on a good connection). The imports screen shows it as an
extra first step. A new version of the app installs its own copy again on its first import.

The player needs [uv](https://docs.astral.sh/uv/) and ffmpeg (`brew install uv ffmpeg`). Without uv, the game works but imports fail with a message
saying what to install.

A development build (`npm run tauri dev`) keeps using the repository: `pipeline-ingest` through
`uv run`, and the repository's `out/` folder as the library when it exists.

## Signing and notarisation

Today the app is only ad-hoc signed. A copy downloaded from the internet is quarantined, and
Gatekeeper refuses to open it ("Riffroad cannot be opened because Apple cannot check it for
malicious software", or "is damaged").

### Workaround for players (unsigned builds)

1. Move `Riffroad.app` to `/Applications`.
2. Open it once; when macOS refuses, open **System Settings → Privacy & Security**, scroll down
   and click **Open Anyway** (macOS 15 and later; on macOS 13–14, right-click the app → Open).
3. Or, in a terminal: `xattr -dr com.apple.quarantine /Applications/Riffroad.app`

### Proper fix: Developer ID + notarisation

Needs a paid [Apple Developer Program](https://developer.apple.com/programs/) membership
(99 USD a year). Then:

1. Create a **Developer ID Application** certificate (Xcode → Settings → Accounts, or the
   developer website) and install it in the login keychain.
2. Create an **App Store Connect API key** (Users and Access → Integrations → Keys) for
   notarisation.
3. Build with these environment variables; Tauri signs with the hardened runtime, notarises
   and staples the app and the disk image on its own:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAM_ID>)"
   export APPLE_API_ISSUER=<issuer id>
   export APPLE_API_KEY=<key id>
   export APPLE_API_KEY_PATH=/path/to/AuthKey_<key id>.p8
   npm run tauri build
   ```

   (Or `APPLE_ID`, `APPLE_PASSWORD` — an app-specific password — and `APPLE_TEAM_ID`.)
   In CI, `APPLE_CERTIFICATE` (the .p12, base64) and `APPLE_CERTIFICATE_PASSWORD` import the
   certificate into a temporary keychain.
4. Check: `spctl -a -vv /path/to/Riffroad.app` must say `source=Notarized Developer ID`.

`app/src-tauri/Entitlements.plist` grants `com.apple.security.device.audio-input`: under the
hardened runtime that comes with a Developer ID signature, the guitar input would otherwise be
silently muted. The app starts `uv` and the Python pipeline as child processes, which the
hardened runtime allows; they are not signed by us and do not need to be.
