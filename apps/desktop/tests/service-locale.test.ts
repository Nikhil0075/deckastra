import { describe, expect, it } from "vitest";

import { serviceLocale } from "../src/main/service-locale";

/**
 * The service's locale on macOS. Without one, a Finder launch ran the frozen
 * service in US-ASCII and it died reading `alembic.ini` before it could migrate.
 */

describe("the locale the service starts with", () => {
  it("is UTF-8 on a Mac launched with no locale at all, as launchd launches it", () => {
    expect(serviceLocale({ HOME: "/Users/someone", PATH: "/usr/bin:/bin" }, "darwin")).toEqual({ LC_CTYPE: "UTF-8" });
  });

  it("treats an empty value as unset", () => {
    expect(serviceLocale({ LANG: " " }, "darwin")).toEqual({ LC_CTYPE: "UTF-8" });
  });

  it.each(["LANG", "LC_ALL", "LC_CTYPE"])("leaves a locale the person set through %s alone", (name) => {
    expect(serviceLocale({ [name]: "fr_FR.ISO8859-1" }, "darwin")).toEqual({});
  });

  it.each(["win32", "linux"])("adds nothing on %s", (platform) => {
    expect(serviceLocale({}, platform)).toEqual({});
  });
});
