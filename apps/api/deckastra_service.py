"""Entry point for the packaged workspace service.

PyInstaller runs its entry script as `__main__`, which has no package — so the
relative imports throughout `deckastra_api` fail before the first line of real
work. A one-line launcher that *imports* the package instead of being part of it
is the standard fix, and it also gives the binary a name of its own rather than
one that reads like an implementation file.
"""

from __future__ import annotations

from deckastra_api.local_server import main

if __name__ == "__main__":
    raise SystemExit(main())
