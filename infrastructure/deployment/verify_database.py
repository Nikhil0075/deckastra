"""Cloud Run check job: migrations and credit races in a disposable database."""
import os
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import create_engine, text, inspect
from sqlalchemy.engine import make_url


def main():
    base = make_url(os.environ["DATABASE_URL"])
    name = "deckastra_check_" + uuid.uuid4().hex[:12]
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as connection:
            connection.execute(text(f'CREATE DATABASE "{name}"'))
        test_url = base.set(database=name)
        os.environ["DATABASE_URL"] = test_url.render_as_string(hide_password=False)
        subprocess.run([sys.executable, "-m", "alembic", "-c", "/app/infrastructure/database/alembic.ini", "upgrade", "head"], check=True, capture_output=True)
        from deckastra_api.db import session as db
        from deckastra_api.auth import provision_personal_account
        from deckastra_api import credits
        from deckastra_agents.budgets import BudgetExceeded
        db.reset_engine()
        with db.session_scope() as session:
            user_id = provision_personal_account(session, email="check@example.invalid")[0].id
        def reserve(index):
            try:
                credits.observer(user_id)(f"check-{index}", .10, -1)
                return True
            except BudgetExceeded:
                return False
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(reserve, range(12)))
        assert sum(results) == 3, "Concurrent reservations exceeded the account allowance"
        with db.session_scope() as session:
            assert credits.account(session, user_id).balance_micros == 0
            from deckastra_api import store, export_service
            from deckastra_api.compose import blank_document
            from deckastra_api.db.models import Project
            from sqlalchemy import select
            project = session.scalar(select(Project).limit(1))
            deck = store.create_presentation(session, project_id=project.id, document=blank_document("Format check"), created_by=user_id)
            export_service.create_job(session, presentation_id=deck.presentation_id, version_id=deck.version_id, created_by=user_id, kind="mydeck")
            # The check is on the migrated SQL constraint, not just ORM create_all.
            session.flush()
            session.rollback()
        engine = create_engine(test_url)
        assert "credit_reservations" in inspect(engine).get_table_names()
        engine.dispose()
        db.reset_engine()
        subprocess.run([sys.executable, "-m", "alembic", "-c", "/app/infrastructure/database/alembic.ini", "downgrade", "base"], check=True, capture_output=True)
        print("PASS: PostgreSQL migrations up/down and 12 concurrent credit reservations.", flush=True)
    finally:
        with admin.connect() as connection:
            connection.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=:name AND pid<>pg_backend_pid()"), {"name": name})
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
        admin.dispose()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Connection exceptions can contain the password in their driver locals.
        print(f"FAIL: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
