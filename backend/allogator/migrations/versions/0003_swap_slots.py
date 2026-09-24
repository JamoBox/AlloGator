"""swap slots: requests and offers can cover several separate days

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-24 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "swap_slots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Integer(), nullable=True),
        sa.Column("offer_id", sa.Integer(), nullable=True),
        sa.Column("rota_id", sa.Integer(), nullable=False),
        sa.Column("start_at", sa.DateTime(), nullable=False),
        sa.Column("end_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["offer_id"], ["swap_offers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["request_id"], ["swap_requests.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["rota_id"], ["rotas.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("swap_slots", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_swap_slots_offer_id"), ["offer_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_swap_slots_request_id"), ["request_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("swap_slots", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_swap_slots_request_id"))
        batch_op.drop_index(batch_op.f("ix_swap_slots_offer_id"))

    op.drop_table("swap_slots")
