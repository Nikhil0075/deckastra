"""Run the V3 export/accessibility acceptance as one cross-platform gate."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
NPM = "npm.cmd" if sys.platform == "win32" else "npm"


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print("gate", " ".join(command[1:3] if len(command) > 2 else command), flush=True)
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def main() -> None:
    run([
        sys.executable,
        "-m",
        "pytest",
        "apps/api/tests/test_preset_cutouts.py",
        "apps/api/tests/test_pptx_masks.py",
        "apps/api/tests/test_pptx_treatments.py",
        "apps/api/tests/test_pptx_charts.py",
        "apps/api/tests/test_language_exports.py",
        "-q",
    ])

    pixel_env = dict(os.environ)
    # This gate owns a real browser render; leaving PIXELS unset would make the
    # suite report green while comparing no pixels.
    pixel_env["PIXELS"] = "1"
    run([
        NPM, "exec", "--workspace", "@deckastra/renderer", "--", "vitest", "run",
        "tests/masks.test.tsx", "tests/accessibility.test.ts", "tests/pixels.test.ts",
        "--maxWorkers=1", "--minWorkers=1",
    ], env=pixel_env)

    run([
        NPM, "exec", "--workspace", "@deckastra/export-pptx", "--", "vitest", "run",
        "tests/pptx.test.ts", "--maxWorkers=1", "--minWorkers=1",
    ])
    run([
        NPM, "exec", "--workspace", "@deckastra/editor-ui", "--", "vitest", "run",
        "tests/cutouts.test.ts", "tests/layer-controls.test.tsx",
        "tests/layout-sizes.test.ts", "tests/workspace-layout.test.tsx",
        "--maxWorkers=1", "--minWorkers=1",
    ])


if __name__ == "__main__":
    main()

