/**
 * Which profile directory this launch uses (`DECKASTRA_SMOKE_PROFILE`).
 *
 * One line of logic, in a file of its own, because getting it wrong is not
 * visible: the app starts, opens a deck, and the only sign that it opened the
 * *wrong person's* deck is that it is the wrong deck.
 *
 * Without an override the app uses Electron's own `userData`, which on Windows
 * is `%APPDATA%\Deckastra` — the directory holding a real user's work. Several
 * acceptance steps change the deck they find and leave the change there on
 * purpose (`edit` adds a shape for `verify` to find), so a run that loses its
 * override edits someone's real deck. That happened on 2026-09-19, when a
 * profile had been renamed aside to get a "fresh" one and the path resolved to
 * the real data instead.
 *
 * **It is honoured whenever it is set**, and deliberately not gated on
 * `DECKASTRA_SMOKE_DIR` being set as well (corrected 2026-09-20, item 25). The
 * gate looked like defence in depth and was the opposite: a process holding the
 * profile and not the directory fell back to the real one, silently. That is
 * exactly the shape of the second instance item 25 has to launch — the harness
 * switched off, the profile kept — and it duly started a whole application
 * against the real profile. Nothing was written, because no step ran, but the
 * failure was silent and pointed at the one directory this variable exists to
 * keep runs away from.
 *
 * A profile named explicitly is the profile used. An empty value is no value,
 * so `DECKASTRA_SMOKE_PROFILE=` cannot quietly mean "the real one".
 */
export function profileOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = (env.DECKASTRA_SMOKE_PROFILE ?? "").trim();
  return named ? named : undefined;
}
