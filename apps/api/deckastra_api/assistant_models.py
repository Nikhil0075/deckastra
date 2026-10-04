"""Durable assistant state, separate from document authority."""
from datetime import datetime
from typing import Any
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db.models import Base, JsonColumn, TimestampMixin


class AssistantRun(Base, TimestampMixin):
    __tablename__ = "assistant_runs"
    __table_args__ = (UniqueConstraint("created_by", "operation_key", name="uq_assistant_request"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    presentation_id: Mapped[str] = mapped_column(ForeignKey("presentations.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[str] = mapped_column(String(64))
    operation_key: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    request_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn)
    scopes_json: Mapped[list[str]] = mapped_column(JsonColumn)
    checkpoint_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    result_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    budget_json: Mapped[dict[str, Any] | None] = mapped_column(JsonColumn)
    error: Mapped[str | None] = mapped_column(Text)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    owner_id: Mapped[str | None] = mapped_column(String(64))
    event_seq: Mapped[int] = mapped_column(Integer, default=0)


class AssistantEvent(Base):
    __tablename__ = "assistant_events"
    run_id: Mapped[str] = mapped_column(ForeignKey("assistant_runs.id", ondelete="CASCADE"), primary_key=True)
    sequence: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn)


class AssistantReservation(Base):
    __tablename__ = "assistant_reservations"
    operation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("assistant_runs.id", ondelete="CASCADE"), index=True)
    reserved_usd: Mapped[float] = mapped_column(Float)
    actual_usd: Mapped[float | None] = mapped_column(Float)


class AssetMetadataChange(Base, TimestampMixin):
    __tablename__ = "asset_metadata_changes"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[str] = mapped_column(String(64))
    before_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn)
    after_json: Mapped[dict[str, Any]] = mapped_column(JsonColumn)
    result_version: Mapped[int] = mapped_column(Integer)
    reverted: Mapped[bool] = mapped_column(Boolean, default=False)
