from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.core.clock import utc_now

from .database import Database
from .models import StatusAccount, StatusInviteCode, model_dict


class StatusAccountRepository:
    """ORM persistence for /status invite codes and local accounts."""

    def __init__(self, database: Database):
        self.database = database

    def create_invite(
        self,
        code: str,
        note: str,
        max_uses: int,
        created_by_admin_id: int | None,
        now: datetime,
    ) -> dict[str, Any]:
        with self.database.transaction() as session:
            invite = StatusInviteCode(
                code=code,
                note=note,
                max_uses=max_uses,
                used_count=0,
                enabled=True,
                created_by_admin_id=created_by_admin_id,
                created_at=now,
                updated_at=now,
            )
            session.add(invite)
            session.flush()
            return model_dict(invite)

    def get_invite(self, invite_id: int) -> dict[str, Any] | None:
        with self.database.session() as session:
            invite = session.get(StatusInviteCode, invite_id)
            return model_dict(invite) if invite else None

    def get_invite_by_code(self, code: str) -> dict[str, Any] | None:
        normalized = str(code or "").strip().upper()
        if not normalized:
            return None
        with self.database.session() as session:
            invite = session.scalar(
                select(StatusInviteCode).where(StatusInviteCode.code == normalized)
            )
            return model_dict(invite) if invite else None

    def list_invites(
        self,
        query: str = "",
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], int]:
        filters = []
        needle = "".join(ch for ch in (query or "").strip() if ch not in "%_")[:80]
        if needle:
            invited_match = exists(
                select(StatusAccount.id).where(
                    StatusAccount.invite_code_id == StatusInviteCode.id,
                    func.lower(StatusAccount.username).contains(needle.lower()),
                )
            )
            filters.append(
                or_(
                    StatusInviteCode.code.contains(needle.upper()),
                    StatusInviteCode.note.contains(needle),
                    invited_match,
                )
            )
        with self.database.session() as session:
            total = session.scalar(
                select(func.count()).select_from(StatusInviteCode).where(*filters)
            )
            values = session.scalars(
                select(StatusInviteCode)
                .where(*filters)
                .order_by(StatusInviteCode.created_at.desc(), StatusInviteCode.id.desc())
                .offset(max(0, offset))
                .limit(max(1, limit))
            ).all()
            return [model_dict(value) for value in values], int(total or 0)

    def update_invite(self, invite_id: int, **fields: Any) -> dict[str, Any] | None:
        allowed = {"note", "max_uses", "enabled"}
        changes = {key: value for key, value in fields.items() if key in allowed}
        with self.database.transaction() as session:
            invite = session.get(StatusInviteCode, invite_id)
            if invite is None:
                return None
            if "max_uses" in changes:
                max_uses = int(changes["max_uses"])
                if max_uses < int(invite.used_count or 0):
                    raise ValueError("可用人数不能小于已使用次数")
                invite.max_uses = max_uses
            if "note" in changes:
                invite.note = str(changes["note"] or "")
            if "enabled" in changes:
                invite.enabled = bool(changes["enabled"])
            invite.updated_at = utc_now()
            session.flush()
            return model_dict(invite)

    def list_accounts_for_invite(self, invite_id: int) -> list[dict[str, Any]]:
        with self.database.session() as session:
            values = session.scalars(
                select(StatusAccount)
                .where(StatusAccount.invite_code_id == invite_id)
                .order_by(StatusAccount.id.asc())
            ).all()
            return [model_dict(value) for value in values]

    def create_account(
        self,
        *,
        username: str,
        password_salt: str,
        password_hash: str,
        password_iterations: int,
        invite_code: str,
        now: datetime,
    ) -> dict[str, Any]:
        normalized_code = str(invite_code or "").strip().upper()
        try:
            with self.database.transaction() as session:
                invite = session.scalar(
                    select(StatusInviteCode).where(StatusInviteCode.code == normalized_code)
                )
                if invite is None or not invite.enabled:
                    raise ValueError("邀请码无效或已用完")
                existing = session.scalar(
                    select(StatusAccount).where(
                        func.lower(StatusAccount.username) == username.lower()
                    )
                )
                if existing is not None:
                    raise ValueError("用户名已被使用")
                result = session.execute(
                    update(StatusInviteCode)
                    .where(
                        StatusInviteCode.id == invite.id,
                        StatusInviteCode.enabled.is_(True),
                        StatusInviteCode.used_count < StatusInviteCode.max_uses,
                    )
                    .values(
                        used_count=StatusInviteCode.used_count + 1,
                        updated_at=now,
                    )
                )
                if int(result.rowcount or 0) != 1:
                    raise ValueError("邀请码无效或已用完")
                account = StatusAccount(
                    username=username,
                    password_salt=password_salt,
                    password_hash=password_hash,
                    password_iterations=password_iterations,
                    token_version=1,
                    enabled=True,
                    invite_code_id=invite.id,
                    invite_code=invite.code,
                    login_count=0,
                    created_at=now,
                    updated_at=now,
                )
                session.add(account)
                session.flush()
                return model_dict(account)
        except IntegrityError as exc:
            raise ValueError("用户名已被使用") from exc

    def find_account_by_username(self, username: str) -> dict[str, Any] | None:
        needle = str(username or "").strip()
        if not needle:
            return None
        with self.database.session() as session:
            account = session.scalar(
                select(StatusAccount).where(
                    func.lower(StatusAccount.username) == needle.lower()
                )
            )
            return model_dict(account) if account else None

    def get_account(self, account_id: int) -> dict[str, Any] | None:
        with self.database.session() as session:
            account = session.get(StatusAccount, account_id)
            return model_dict(account) if account else None

    def touch_login(self, account_id: int, now: datetime) -> dict[str, Any] | None:
        with self.database.transaction() as session:
            account = session.get(StatusAccount, account_id)
            if account is None:
                return None
            account.login_count = int(account.login_count or 0) + 1
            account.last_login_at = now
            account.last_seen_at = now
            account.updated_at = now
            session.flush()
            return model_dict(account)

    def touch_seen(self, account_id: int, now: datetime) -> None:
        with self.database.transaction() as session:
            account = session.get(StatusAccount, account_id)
            if account is None:
                return
            account.last_seen_at = now
            account.updated_at = now

    def bump_token_version(self, account_id: int) -> bool:
        with self.database.transaction() as session:
            account = session.get(StatusAccount, account_id)
            if account is None:
                return False
            account.token_version = int(account.token_version or 0) + 1
            session.flush()
            return True

    def list_accounts(
        self,
        query: str = "",
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], int]:
        filters = []
        needle = "".join(ch for ch in (query or "").strip() if ch not in "%_")[:80]
        if needle:
            filters.append(
                or_(
                    StatusAccount.username.contains(needle),
                    StatusAccount.invite_code.contains(needle.upper()),
                )
            )
        with self.database.session() as session:
            total = session.scalar(
                select(func.count()).select_from(StatusAccount).where(*filters)
            )
            values = session.scalars(
                select(StatusAccount)
                .where(*filters)
                .order_by(StatusAccount.created_at.desc(), StatusAccount.id.desc())
                .offset(max(0, offset))
                .limit(max(1, limit))
            ).all()
            return [model_dict(value) for value in values], int(total or 0)
