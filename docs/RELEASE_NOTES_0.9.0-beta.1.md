# Deckastra 0.9.0-beta.1 — Windows, local-only

A beta of the desktop app. Everything it does, it does on your computer.

## What it does

- **Write, edit and present decks.** A canvas with text, shapes, images, charts,
  diagrams and tables; slides you can reorder; speaker notes; motion with a
  timeline; present mode with a presenter view on a second window.
- **Keeps every version.** Every change is a version you can look at, compare
  with the deck as it is now, and restore. A restore is itself a change, so it
  can be undone.
- **Exports PDF and PowerPoint**, and tells you before you download what could
  not be carried into that format.
- **Has decks written for you**, two ways, both of which you set up under
  **Intelligence**:
  - **Your own Anthropic API key.** Your brief and any repositories you choose
    are sent to Anthropic. Nothing is sent until you save a key and press
    Generate. The key is encrypted by Windows for your account.
  - **An AI agent you already run** — Claude Code or Codex — driving the app
    over MCP. Agents propose; anything destructive waits for you to approve it.
    Agent access is off until you turn it on, and lapses after twelve hours.
- **Grounds a deck in a repository** you connect, so claims name the file they
  came from.

## What is not in this release

Each of these is deliberate, not missing by accident:

- **No cloud workspace, no sharing links, no sync between computers.** Decks
  live in this app's folder on this machine. To give someone a deck, export it.
- **No opening or saving `.mydeck` files.** Decks are created and kept inside
  the app.
- **No models that run on your own machine.** The code for it exists and is not
  shipped here: it needs a runtime and a model pack this installer does not
  carry, and neither has been measured on the hardware this release supports.
- **Windows only.** There is no macOS or Linux build.

## Where your data is

`%APPDATA%\Deckastra` — the database, the images and the exports.

**Use File → Back up… rather than copying that folder.** Copying a database
while the app is writing to it gives you a file that opens and is sometimes
wrong, which is worse than one that does not open. The backup takes a
consistent copy without you closing anything, carries the work you have typed
and not yet saved, and checks itself before File → Restore from a backup… puts
it back. What a restore replaces is kept beside your data, not deleted.

It does not carry finished exports: those are files you already have, and their
records point at this machine.

## Updating

Install the new version over the old one. Your decks and settings stay where
they are. Agent access turns itself off after an update, on purpose: a
permission granted to one build is not a permission granted to the next.

There is **no automatic updater** — an updater that can replace the application
has to be signed, and this build is not. So check for a new version yourself:
Deckastra bundles Chromium and a Python runtime, and their security fixes only
reach you through a new Deckastra build.

The full procedure, and what happens if it goes wrong, is in
[UPGRADING.md](UPGRADING.md).

## Known limits in this beta

- Not signed yet, so Windows will warn about an unknown publisher.
- Not tested with a screen reader, with an input method (Japanese, Chinese,
  Korean) or across two physical displays.
- An export of a very image-heavy deck can leave out pictures beyond a size
  budget; the export report names any it left out.
