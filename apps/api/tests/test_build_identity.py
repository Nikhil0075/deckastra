"""One definition of a payload's identity, in two languages (item 07).

The desktop's build manifest hashes the migrations it bundles; the service
hashes the migrations it is running; the app compares them and refuses a pair
that does not match. That check is only worth having if both sides compute the
same number, so — like the two patch appliers — they are held to one answer by
a test that runs both.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deckastra_api.paths import migrations_digest, migrations_dir, tree_digest  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "apps" / "desktop" / "scripts" / "manifest.mjs"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="the other implementation is JavaScript")


def node_hash(directory: Path) -> str | None:
    """`hashTree` from the manifest script, asked about one directory."""
    script = (
        # A file:// URL: Node refuses a bare absolute Windows path as a specifier.
        "import { hashTree } from " + json.dumps(MANIFEST.as_uri()) + ";"
        "const answer = hashTree(" + json.dumps(str(directory)) + ", "
        "{ exclude: (file) => file.endsWith('.pyc') });"
        "process.stdout.write(JSON.stringify(answer));"
    )
    done = subprocess.run(
        [shutil.which("node"), "--input-type=module", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    answer = json.loads(done.stdout)
    return answer["sha256"] if answer else None


def test_both_languages_hash_the_migrations_the_same(tmp_path):
    assert node_hash(migrations_dir()) == migrations_digest()


def test_they_agree_about_what_changes_a_tree(tmp_path):
    directory = tmp_path / "tree"
    (directory / "sub").mkdir(parents=True)
    (directory / "a.py").write_text("one", encoding="utf-8")
    (directory / "sub" / "b.py").write_text("two", encoding="utf-8")
    before = tree_digest(directory)
    assert node_hash(directory) == before

    (directory / "sub" / "b.py").write_text("two!", encoding="utf-8")
    after = tree_digest(directory)
    assert after != before
    assert node_hash(directory) == after


def test_neither_counts_what_a_build_leaves_behind(tmp_path):
    directory = tmp_path / "tree"
    (directory / "__pycache__").mkdir(parents=True)
    (directory / "a.py").write_text("one", encoding="utf-8")
    clean = tree_digest(directory)
    (directory / "__pycache__" / "a.cpython-312.pyc").write_bytes(b"junk")
    assert tree_digest(directory) == clean
    assert node_hash(directory) == clean
