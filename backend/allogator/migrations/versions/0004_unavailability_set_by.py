"""unavailability.set_by_id: who entered it when a leader did it for someone

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-05 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("unavailability", schema=None) as batch_op:
        batch_op.add_column(sa.Column("set_by_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_unavailability_set_by_id_users", "users", ["set_by_id"], ["id"], ondelete="SET NULL"
        )


def downgrade() -> None:
    with op.batch_alter_table("unavailability", schema=None) as batch_op:
        batch_op.drop_constraint("fk_unavailability_set_by_id_users", type_="foreignkey")
        batch_op.drop_column("set_by_id")
