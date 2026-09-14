from __future__ import annotations

import asyncio
import base64
import hashlib
import secrets
from typing import Any
from urllib.parse import urlencode

from curl_cffi.requests import AsyncSession as CurlAsyncSession

AUTHORIZE_URL = "https://connect.linux.do/oauth2/authorize"
TOKEN_URL = "https://connect.linux.do/oauth2/token"
USERINFO_URL = "https://connect.linux.do/api/user"
DEFAULT_SCOPE = "openid profile email"


class LinuxDoConnectError(RuntimeError):
    """Linux.do Connect token or userinfo request failed."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def generate_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_authorize_url(
    *,
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str,
    scope: str = DEFAULT_SCOPE,
) -> str:
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


class LinuxDoOAuthClient:
    """Minimal Linux.do Connect OAuth2 client."""

    async def exchange_code(
        self,
        *,
        code: str,
        redirect_uri: str,
        client_id: str,
        client_secret: str,
        code_verifier: str,
    ) -> dict[str, Any]:
        try:
            async with CurlAsyncSession() as client:
                response = await client.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": redirect_uri,
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "code_verifier": code_verifier,
                    },
                    timeout=20,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise LinuxDoConnectError(f"交换 Linux.do 授权码失败: {exc}") from exc
        payload = _json_payload(response, "交换 Linux.do 授权码")
        token = str(payload.get("access_token") or "").strip()
        if not token:
            raise LinuxDoConnectError("Linux.do 未返回 access_token")
        return payload

    async def fetch_userinfo(self, access_token: str) -> dict[str, Any]:
        try:
            async with CurlAsyncSession() as client:
                response = await client.get(
                    USERINFO_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=20,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise LinuxDoConnectError(f"读取 Linux.do 用户信息失败: {exc}") from exc
        payload = _json_payload(response, "读取 Linux.do 用户信息")
        if not isinstance(payload, dict) or not (
            payload.get("sub") or payload.get("id")
        ):
            raise LinuxDoConnectError("Linux.do 用户信息缺少 sub/id")
        return payload


def _json_payload(response: Any, context: str) -> dict[str, Any]:
    status_code = int(getattr(response, "status_code", 0) or 0)
    if status_code >= 300:
        detail = str(getattr(response, "text", "") or "").strip()[:1000]
        raise LinuxDoConnectError(
            f"{context}返回 HTTP {status_code}: {detail or '空响应'}",
            status_code=502,
        )
    try:
        payload = response.json()
    except (TypeError, ValueError) as exc:
        raise LinuxDoConnectError(f"{context}返回了无法解析的 JSON") from exc
    if not isinstance(payload, dict):
        raise LinuxDoConnectError(f"{context}返回格式无效")
    error = str(payload.get("error") or "").strip()
    if error:
        description = str(payload.get("error_description") or error)
        raise LinuxDoConnectError(f"{context}失败：{description}")
    return payload
