# Release checklist — 0.9.0-beta.1

The gates that need a person, a machine, or a credential this session does not
have. Everything else in the final package fix register has been delivered and
its evidence recorded there.

Each item says **what to do**, **what passing looks like**, and **what has
already been done for it**, so none of these starts from nothing.

---

## 1. Install the candidate (item 26)

The installer asks for elevation, and an unattended `/S` returns **1223**
(cancelled) after about two minutes. That prompt is yours to answer.

```bash
"D:\Presentation_app\apps\desktop\release\Deckastra-0.9.0-beta.1-win-x64.exe" /S
```

**Passing:** `%LOCALAPPDATA%\Programs\Deckastra\Deckastra.exe` exists, and
`resources\build-manifest.json` reads `0.9.0-beta.1` with `complete: true`.

**Already done:** the same payload — 947 files, 729MB, byte-identical to what
the installer lays down — was copied outside the checkout and driven through 20
acceptance steps with no Python, Node, npm, npx or tsx on `PATH`. What is *not*
covered is the installer itself: its shortcuts, its uninstaller, its registry
entries, and installing over a previous version.

## 2. A clean account or Windows Sandbox (item 26)

Install on a machine — or a Windows Sandbox session — that has never had this
repository, Python, Node or Playwright on it.

**Passing:** the app opens a deck, edits it, exports a PDF and a PowerPoint, and
nothing in the logs mentions a path outside the install.

## 3. Failing saves (item 26)

Three cases, each while **overwriting a file you already have**:

- Cancel the save dialog.
- Choose a folder you do not have permission to write to.
- Fill the destination volume (a small USB stick is the easy way).

**Passing:** in all three, the file you were overwriting is **still there and
still complete**. No `.deck.pdf.NNNN.partial` is left behind.

**Already done:** the code no longer opens the target for writing at all — it
stages beside it and renames over it — with seven tests including an injected
`ENOSPC`. A real full volume is what this confirms.

## 4. Upgrading (item 16)

Install 0.9.0-beta.1 over a previous build, with decks and a cloud key already
in place.

**Passing:** decks, history, images, paused outlines, the cloud key and the open
deck all survive; **agent access is off**; the first launch migrates and opens.
Then interrupt an install and confirm one runnable version remains.

**Already done:** `docs/UPGRADING.md` states the procedure and what survives;
`tests/upgrade.test.ts` drives one profile across a version change. The two real
installers end to end are this.

## 5. Real MCP hosts (item 24)

Claude Code and Codex, against the installed app, using the setup text the app
shows.

**Passing:** each attaches, reads a deck, proposes a change, and is refused
approval and sharing. The two steps nobody else can take: **approving a pending
change**, and **undoing an applied one** — neither has ever been pressed by a
person.

**Already done:** the shipped MCP bundle passed the 16-step journey on a
credential obtained through the window's own consent.

## 6. Rich text and IME (item 27)

Japanese, Chinese or Korean input into speaker notes and canvas text. Paste
formatted content from Word and from a web page into the middle of a paragraph.
Native undo. The toolbar by keyboard. Switching slide, closing the window and
exporting **during** a composition.

**Passing:** no half-characters, no lost blank lines, numbering stays numbering,
the caret does not jump, and a close mid-composition keeps the text from before
it began.

## 7. Screen reader and scaling (item 29)

NVDA, Windows high contrast, and display scaling at 125%, 150% and 200%.

**Passing:** every region reachable and announced, no keyboard trap, nothing
clipped or overlapping at any scale.

## 8. Two displays (item 31)

Present across two physical monitors: sleep and wake, disconnect the second
display mid-talk, reconnect it.

**Passing:** the audience window stays on the projector, the presenter view
keeps its timer and step count, and a disconnect does not end the talk.

## 9. Figma comparison (item 28)

Frame by frame against the "DeckOS — Editor UI (Minimal)" file. The Figma
connector needs authorising first.

## 10. Signing (items 11 and 12)

Needs your certificate. With it present, from the repository root:

```bash
CSC_LINK=<pfx or path> CSC_KEY_PASSWORD=<password> DECKASTRA_SIGNING_PUBLISHER="CN=<your subject>" npm run release:win
```

`release:win` (`apps/desktop/scripts/release.mjs`) refuses to start without the
certificate and the publisher name. It empties `release/`, runs the package
build with `DECKASTRA_RELEASE=1`, then runs the strict gate
(`scripts/verify-release.mjs`) on that exact output and writes
`release/release-report.json`. `npm run package` stays the unsigned development
build and is never a release.

**What the gate checks, on the unpacked payload the installer carries:** exactly
one installer; the embedded build manifest is the current `dist` manifest (a
stale release fails); every worker, MCP and service file matches its recorded
hash with nothing added or missing (JavaScript bundles cannot carry Authenticode,
so their hash is the check); `Deckastra.exe`, the service executable and the
installer are validly signed by `DECKASTRA_SIGNING_PUBLISHER`; any native file
that changed since the build must carry a valid signature, and unchanged
unsigned third-party libraries are listed in the report. Tampering refusals are
covered by `apps/desktop/tests/verify-release.test.ts` (swapped service,
tampered bundle, foreign signer, stale release, extra installer, empty folder).

`npm run verify:release` runs the same checks in report mode against whatever is
in `release/`.

**Passing:** exit code 0, `ok: true` in the report, and the report's installer
SHA-256 is the file you distribute. Then install that file and run section 1.

**Not done and not claimed:** no certificate exists here, so no signed artifact
has ever been produced, and the gate has only been run against unsigned output,
where it correctly refuses. Notarization has never run.

## 11. Linux CI (item 32)

Push the candidate and let CI run the Linux jobs, including the pixel gate.

**Note:** the desktop job added in item 10 has still never run on a runner;
every command in it was run locally on this machine.

## 12. Third-party notices (item 33)

Every package build writes `THIRD_PARTY_NOTICES.txt` (`npm run notices`,
`scripts/notices.mjs`) and ships it beside the app; **Help > Third-party
notices** shows it. It is made from the same lists as the SBOM:

- JavaScript: the packages the bundlers actually read
  (`dist/bundled-packages.json`, written by `build.mjs` from esbuild's metafiles
  and Vite's output) — 14 today, including the Inter and Jost fonts (OFL-1.1).
- The workspace service: every distribution in `sidecar-requirements.lock`, read
  from the build environment (`dist/.venv`), plus CPython's licence for the
  embedded interpreter — 97 today. A lock entry the environment lacks is a
  failure.
- Electron and Chromium: `LICENSE.electron.txt` and `LICENSES.chromium.html`,
  which electron-builder places beside `Deckastra.exe`.
- Models: none ship in this release, and the file says so.

**Yours to decide:** two service dependencies ship **no licence file** —
`langsmith 0.13.0` (MIT) and `sqlite-vec 0.1.9` (MIT or Apache-2.0). MIT asks
for its copyright notice to travel with copies, so the declared name is not
enough. Fetch each project's licence text into the notices, or record another
decision, in `apps/desktop/notices-review.json`. A release build
(`DECKASTRA_RELEASE=1`, which `release:win` sets) **fails** while either has no
entry there. Whether every licence permits redistribution is the release
owner's review; the tooling only makes sure the texts are present to review.

The release gate refuses a package whose shipped notices differ from the ones
the build wrote.
