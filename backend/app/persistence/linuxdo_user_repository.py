from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, nulls_last, or_, select

from .database import Database
from .models import LinuxDoUser, model_dict


class LinuxDoUserRepository:
    """ORM persistence for Linux.do Connect identities."""

    def __init__(self, database: Database):
        self.database = database

    def upsert_from_profile(
        self, profile: dict[str, Any], *, now: datetime
    ) -> dict[str, Any]:
        linuxdo_id = _linuxdo_id(profile)
        username = _profile_text(profile, "username", "login", limit=80)
        name = _profile_text(profile, "name", limit=120)
        email = _profile_text(profile, "email", limit=200)
        avatar_url = _profile_text(profile, "avatar_url", limit=400)
        trust_level = _profile_int(profile, "trust_level", default=0)
        active = _profile_bool(profile, "active", default=True)
        silenced = _profile_bool(profile, "silenced", default=False)
        snapshot = dict(profile)
        with self.database.transaction() as session:
            user = session.scalar(
                select(LinuxDoUser).where(LinuxDoUser.linuxdo_id == linuxdo_id)
            )
            if user is None:
                user = LinuxDoUser(
                    linuxdo_id=linuxdo_id,
                    username=username,
                    name=name,
                    email=email,
                    avatar_url=avatar_url,
                    trust_level=trust_level,
                    active=active,
                    silenced=silenced,
                    login_count=1,
                    last_login_at=now,
                    last_seen_at=now,
                    created_at=now,
                    updated_at=now,
                    profile=snapshot,
                )
                session.add(user)
            else:
                user.username = username
                user.name = name
                user.email = email
                user.avatar_url = avatar_url
                user.trust_level = trust_level
                user.active = active
                user.silenced = silenced
                user.login_count = int(user.login_count or 0) + 1
                user.last_login_at = now
                user.last_seen_at = now
                user.updated_at = now
                user.profile = snapshot
            session.flush()
            return model_dict(user)

    def get(self, user_id: int) -> dict[str, Any] | None:
        with self.database.session() as session:
            user = session.get(LinuxDoUser, user_id)
            return model_dict(user) if user else None

    def get_by_linuxdo_id(self, linuxdo_id: str) -> dict[str, Any] | None:
        with self.database.session() as session:
            user = session.scalar(
                select(LinuxDoUser).where(LinuxDoUser.linuxdo_id == linuxdo_id)
            )
            return model_dict(user) if user else None

    def touch_seen(self, user_id: int, now: datetime) -> None:
        with self.database.transaction() as session:
            user = session.get(LinuxDoUser, user_id)
            if user is None:
                return
            user.last_seen_at = now
            user.updated_at = now

    def list_page(
        self,
        *,
        query: str = "",
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], int]:
        filters = []
        needle = "".join(ch for ch in (query or "").strip() if ch not in "%_")[:80]
        if needle:
            filters.append(
                or_(
                    LinuxDoUser.username.contains(needle),
                    LinuxDoUser.name.contains(needle),
                    LinuxDoUser.email.contains(needle),
                    LinuxDoUser.linuxdo_id.contains(needle),
                )
            )
        with self.database.session() as session:
            total = session.scalar(
                select(func.count()).select_from(LinuxDoUser).where(*filters)
            )
            values = session.scalars(
                select(LinuxDoUser)
                .where(*filters)
                .order_by(
                    nulls_last(LinuxDoUser.last_login_at.desc()),
                    LinuxDoUser.id.desc(),
                )
                .offset(max(0, offset))
                .limit(max(1, limit))
            ).all()
            return [model_dict(value) for value in values], int(total or 0)


def _linuxdo_id(profile: dict[str, Any]) -> str:
    for key in ("sub", "id"):
        value = profile.get(key)
        if value is None or value == "":
            continue
        text = str(value).strip()
        if text:
            return text[:64]
    raise ValueError("linuxdo profile is missing sub/id")


def _profile_text(profile: dict[str, Any], *keys: str, limit: int) -> str:
    for key in keys:
        value = profile.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text[:limit]
    return ""


def _profile_int(profile: dict[str, Any], key: str, default: int = 0) -> int:
    value = profile.get(key)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _profile_bool(profile: dict[str, Any], key: str, default: bool) -> bool:
    value = profile.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes"}:
            return True
        if lowered in {"0", "false", "no", ""}:
            return False
    return default
