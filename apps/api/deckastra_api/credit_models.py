"""Account credits and usage metadata. These tables never contain deck content."""
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db.models import Base


class CreditAccount(Base):
    __tablename__ = "credit_accounts"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    plan: Mapped[str] = mapped_column(String(24), default="free")
    monthly_allowance: Mapped[int] = mapped_column(Integer, default=60)
    balance_micros: Mapped[int] = mapped_column(Integer)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    anchor_day: Mapped[int] = mapped_column(Integer)


class CreditEntry(Base):
    __tablename__ = "credit_entries"
    __table_args__ = (UniqueConstraint("operation_id", "kind", name="uq_credit_operation_kind"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("credit_accounts.user_id", ondelete="CASCADE"), index=True)
    operation_id: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(24))
    amount_micros: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CreditReservation(Base):
    __tablename__ = "credit_reservations"
    operation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("credit_accounts.user_id", ondelete="CASCADE"), index=True)
    reserved_micros: Mapped[int] = mapped_column(Integer)
    actual_micros: Mapped[int | None] = mapped_column(Integer)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    task: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(128))
    device_hash: Mapped[str] = mapped_column(String(64))


class CreditDailyLimit(Base):
    __tablename__ = "credit_daily_limits"
    scope: Mapped[str] = mapped_column(String(140), primary_key=True)
    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    spent_micros: Mapped[int] = mapped_column(Integer, default=0)
    requests: Mapped[int] = mapped_column(Integer, default=0)
