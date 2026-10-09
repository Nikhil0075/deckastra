"""Cloud erasure queue. Finished records retain only a short-lived identity hash."""
from datetime import datetime
from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column
from .db.models import Base, JsonColumn

class AccountDeletion(Base):
    __tablename__ = "account_deletions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64), index=True)
    fingerprints_json: Mapped[list] = mapped_column(JsonColumn)
    identities_json: Mapped[list] = mapped_column(JsonColumn)
    status: Mapped[str] = mapped_column(String(24), index=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
