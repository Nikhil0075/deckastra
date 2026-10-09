"""A migration must leave the previous release working.

A deploy migrates the database before it knows whether the new release will
pass its smoke test, and a database is never rolled back. So when a release
fails verification, the API and the worker return to their previous
revisions (release_checks.restore_worker), and those revisions run against the
schema the failed release already applied.

That is safe only for additive changes. On 2026-10-09 the release that removed
repository grounding dropped three tables in its migration, failed its smoke
test for an unrelated reason, and left the previous API serving routes whose
tables no longer existed.

So an upgrade that removes, renames or tightens something must say why the
previous release no longer depends on it, in a module-level ``CONTRACT``. The
usual answer is that the code stopped using it a release earlier: expand in one
release, contract in the next.
"""

from __future__ import annotations

import ast
from pathlib import Path

VERSIONS = Path(__file__).resolve().parents[3] / "infrastructure" / "database" / "migrations" / "versions"

#: Applied before this rule existed. Editing an applied migration would change
#: the migrations digest that the desktop app checks against its service, so
#: they are named here instead.
GRANDFATHERED = {"20261006_1200_remove_repository_grounding.py"}


def destructive_operations(source: str) -> list[str]:
    tree = ast.parse(source)
    upgrade = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "upgrade"), None)
    found: list[str] = []
    if upgrade is None:
        return found
    for node in ast.walk(upgrade):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        name = node.func.attr
        if name in {"drop_table", "drop_column", "rename_table"}:
            found.append(name)
        elif name == "alter_column":
            keywords = {keyword.arg: keyword.value for keyword in node.keywords}
            if "new_column_name" in keywords:
                found.append("rename_column")
            nullable = keywords.get("nullable")
            if isinstance(nullable, ast.Constant) and nullable.value is False:
                found.append("set_not_null")
    return found


def declared_contract(source: str) -> str | None:
    for node in ast.parse(source).body:
        if (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "CONTRACT" for t in node.targets)
                and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
            return node.value.value.strip()
    return None


def test_destructive_upgrades_say_why_the_previous_release_survives():
    offenders = []
    for path in sorted(VERSIONS.glob("*.py")):
        if path.name in GRANDFATHERED:
            continue
        source = path.read_text(encoding="utf-8")
        operations = destructive_operations(source)
        contract = declared_contract(source)
        if operations and (not contract or len(contract) < 30):
            offenders.append(f"{path.name}: {', '.join(sorted(set(operations)))}")
    assert not offenders, (
        "These upgrades remove, rename or tighten schema the previous release may still use. A failed "
        "release keeps the migrated database and restores the previous code, so either make the change "
        "additive or add a module-level CONTRACT explaining why the previous release no longer depends "
        "on it:\n" + "\n".join(offenders)
    )


def test_the_detector_sees_destructive_operations_in_upgrade_only():
    source = (
        "def upgrade():\n"
        "    op.add_column('a', sa.Column('b'))\n"
        "    op.alter_column('a', 'c', nullable=False)\n"
        "    with op.batch_alter_table('t') as batch_op:\n"
        "        batch_op.drop_column('d')\n"
        "def downgrade():\n"
        "    op.drop_table('a')\n"
    )
    assert sorted(destructive_operations(source)) == ["drop_column", "set_not_null"]
    assert destructive_operations("def upgrade():\n    op.create_table('x')\n") == []


def test_a_contract_must_actually_say_something():
    assert declared_contract('CONTRACT = "Release 41 stopped reading repositories; 42 drops them."') is not None
    assert declared_contract("revision = 'abc'") is None


def test_the_grandfathered_migration_is_the_one_that_needed_it():
    # A grandfathered name that no longer exists or is no longer destructive
    # would quietly widen the exemption; keep the list honest.
    for name in GRANDFATHERED:
        assert destructive_operations((VERSIONS / name).read_text(encoding="utf-8")), name
