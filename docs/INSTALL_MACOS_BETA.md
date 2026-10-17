# Installing the Deckastra beta on a Mac

For beta testers. This build runs on **Apple-silicon Macs** (M1 and later).
It does not run on Intel Macs.

## Why macOS asks first

This beta is **not signed by Apple or notarized**. That is deliberate for now:
signing needs an Apple Developer ID, and it will come before a public release.
Until then macOS cannot confirm who made the app. It blocks the first launch,
and you have to say you trust it once.

## Install

1. Open `Deckastra-<version>-mac-arm64.dmg`, and drag **Deckastra** into
   **Applications**.
2. Open Deckastra from Applications. macOS refuses and says it cannot verify
   the app. Press **Done** (or **OK**). Do not press **Move to Bin**.
3. Open **System Settings → Privacy & Security**, scroll to **Security**, and
   press **Open Anyway** beside the message about Deckastra. Confirm with your
   password or Touch ID.
4. Open Deckastra again and press **Open**. From then on it opens like any
   other app.

If **Open Anyway** does not appear, or macOS says the app "is damaged", run this
once in Terminal, then open the app again:

```bash
xattr -dr com.apple.quarantine /Applications/Deckastra.app
```

That removes the "downloaded from the internet" mark macOS checks. It does not
change the app.

The exact wording of these dialogs differs between macOS versions. The steps
above were written from macOS's documented behaviour for unsigned apps, and
have not yet been walked through on a downloaded copy of this build.

## The first sign-in, and every update

When you sign in, Deckastra stores your sign-in in the macOS **Keychain**.
Because this beta is not signed, macOS sees each new version as a different app.
After an update it may ask whether Deckastra may use its Keychain item. Choose
**Always Allow**. If you choose **Deny**, you will be asked to sign in again.

## Updating

There is no automatic updater in the beta. To update, quit Deckastra, then
drag the new version into Applications and replace the old one. Your decks are
not inside the app, so replacing it keeps them. Repeat steps 2–4 above for
the new version.

## Where your decks are

`~/Library/Application Support/Deckastra`: the database, the pictures and the
exports. To keep a copy, use **File → Back up…** rather than copying that
folder while the app is open (see [UPGRADING.md](UPGRADING.md)).

## Not in the Mac beta yet

- **Poster frames for generated video clips.** A generated clip plays in the
  deck, but has no still frame, and a PowerPoint export leaves it out. That
  needs an audited ffmpeg for macOS, which is not ready yet.
- **Intel Macs.**

## If something goes wrong

**Help → Export diagnostics…** writes a report you can send. It says which build
you have and why the app's service is not running. It never includes your
decks or the words in them.
