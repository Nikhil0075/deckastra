/**
 * The locale the workspace service is started with, on macOS.
 *
 * A Mac app opened from the Finder or the Dock inherits launchd's environment,
 * which sets no `LANG`, `LC_ALL` or `LC_CTYPE`, so the frozen service runs in
 * the C locale, whose codeset on macOS is US-ASCII. Alembic reads
 * `alembic.ini` with `encoding="locale"` — the C library's codeset, which
 * Python's UTF-8 mode does not override — and the file has a § and an em dash
 * in its comments, so the service died at its first migration on every launch
 * (found 2026-10-17, the first macOS build). A terminal launch hid it whenever
 * the shell happened to export a UTF-8 `LANG`.
 *
 * `LC_CTYPE=UTF-8` is the narrowest fix: it names only the character type,
 * leaves number, date and message formatting alone, and is a locale macOS
 * always has. A locale the person set is theirs and is never replaced. Windows
 * and Linux get nothing: Windows reads that file through its ANSI code page,
 * exactly as it always has.
 */
export function serviceLocale(env: NodeJS.ProcessEnv, platform: string = process.platform): NodeJS.ProcessEnv {
  if (platform !== "darwin") return {};
  const set = (name: string) => Boolean((env[name] ?? "").trim());
  if (set("LC_ALL") || set("LC_CTYPE") || set("LANG")) return {};
  return { LC_CTYPE: "UTF-8" };
}
