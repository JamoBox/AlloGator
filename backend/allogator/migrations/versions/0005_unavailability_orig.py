"""unavailability.orig_kind/orig_note: the member's own entry, kept so a leader can reset to it

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-05 21:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("unavailability", schema=None) as batch_op:
        batch_op.add_column(sa.Column("orig_kind", sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column("orig_note", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    with op.batch_alter_table("unavailability", schema=None) as batch_op:
        batch_op.drop_column("orig_note")
        batch_op.drop_column("orig_kind")
