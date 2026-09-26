# Upgrading Deckastra

**This release has no automatic updater.** That is a decision rather than an
omission: an updater that can replace the application on someone's machine is a
channel that has to be signed, and signing is not done in 0.9.0-beta.1. An
unsigned update channel is worse than no update channel, so there is not one.

Upgrading is therefore something you do, and this page is the supported way to
do it. It is short on purpose.

---

## How to upgrade

1. **Close Deckastra.** Use the window's close button or File → Exit rather than
   ending the process. Closing asks each window to save what is on screen and
   waits for the answer; ending the process does not.
2. **Back up** (File → Back up…). See below for what this is and is not.
3. **Run the new installer.** Install it over the version you have — do not
   uninstall first. Uninstalling is what would remove your decks.
4. **Open Deckastra.** The first launch after an upgrade brings the database up
   to the new version's schema, so it takes longer than usual. Let it finish.
5. **Allow agent access again** if you use Claude Code, Codex or another MCP
   client. This is off after every upgrade, on purpose — see below.

## What survives an upgrade

| | |
| --- | --- |
| Your decks, their history and their images | **Kept** |
| Paused outlines waiting for you to approve them | **Kept** |
| Your cloud API key | **Kept** |
| Which deck was open | **Kept** |
| Agent access (Claude Code, Codex, other MCP clients) | **Switched off** |
| Finished exports | Kept on disk, but not carried by a backup — see below |

**Agent access is switched off by every upgrade**, including going back to an
older version. Allowing it lets something else on your machine read and change
your decks, and that permission was given to a particular build. A new build is
a new thing to decide about; a permission that survives every upgrade is one
nobody ever revisits. Turning it on again takes one click in the window.

## Backing up, and what a backup is

**File → Back up…** writes a folder you choose. Take one before upgrading.

It contains everything in your workspace as **one moment**: the database is
copied with SQLite's online backup, so you do not have to close anything, and
the images copied are the ones that snapshot refers to. It also carries the
work you have typed and not yet saved, which lives in the window rather than in
the database.

**It does not contain your exports.** A finished PDF or PowerPoint is a file you
already have, and its record points at a location on this machine, so carrying
it to another one would restore a link to something that is not there. Exporting
again is a button.

**File → Restore from a backup…** puts one back. It checks the whole backup
before it replaces anything, so a damaged or incomplete one is refused rather
than discovered halfway through — and what it replaces is moved into a
`replaced-<date>` folder inside `%APPDATA%\Deckastra\workspace`, not deleted. If a restore was a
mistake, that folder is how you undo it.

## If something goes wrong

**"This workspace was written by a newer version of Deckastra."** You are
running an older version than the one that last opened this data. Deckastra
refuses rather than guessing, and **your data has not been changed**. Either
install the newer version again, or restore a backup taken with the version you
are running.

**The service will not start after an upgrade.** The window says why and offers
Try again. Nothing in Deckastra will ever offer to clear your workspace to make
the app start — if a migration failed, the data is the part that matters. Use
Help → Export diagnostics… and send the report.

**The install was interrupted.** Run the installer again. Your decks are in your
user profile, and installing does not touch that — so a failed install costs you
the install and not your work. If Deckastra will not start afterwards, install
it again over the top; if it still will not, uninstall, reinstall, and use File
→ Restore from a backup….

## Security updates

There is no automatic notification, so this is worth being deliberate about:
**check the release page for a new version periodically.** Deckastra bundles
Chromium (through Electron) and a Python runtime, and both receive security
fixes that only reach you through a new Deckastra build.

**Help → Export diagnostics…** records the exact build you are running — the
version, the commit and the hashes of what shipped — which is what to send if
you need to report something. (There is no About window in this release.)

## Where your data is

`%APPDATA%\Deckastra\workspace` on Windows. The database, its checkpoints and
your images are all under that one directory.

That is where the bytes are, and it is **not** a licence to copy the folder
while Deckastra is running: a database copied mid-write is a file that opens and
is sometimes wrong, which is worse than one that does not open. Use File → Back
up… That is what it is for.
