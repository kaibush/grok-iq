from __future__ import annotations

import asyncio
import time
from typing import Any

from curl_cffi.requests import AsyncSession as CurlAsyncSession

from app.core.config import Settings

WECHAT_API_BASE_URL = "https://api.weixin.qq.com"
TOKEN_REFRESH_SKEW_SECONDS = 300
TOKEN_ERROR_CODES = {40001, 40014, 42001}


class WeChatIntegrationError(RuntimeError):
    """A public-platform token or template-message request failed."""


class WeChatTestAccountClient:
    """Minimal client for the WeChat public-platform test account API."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._access_token = ""
        self._access_token_expires_at = 0.0
        self._token_lock = asyncio.Lock()

    def reset_credentials(self) -> None:
        self._access_token = ""
        self._access_token_expires_at = 0.0

    def _token_is_usable(self) -> bool:
        return bool(
            self._access_token
            and time.monotonic() < self._access_token_expires_at
        )

    @staticmethod
    def _payload(response: Any, context: str) -> dict[str, Any]:
        if response.status_code >= 300:
            detail = str(response.text or "").strip()[:1000]
            raise WeChatIntegrationError(
                f"{context}返回 HTTP {response.status_code}: {detail or '空响应'}"
            )
        try:
            payload = response.json()
        except (TypeError, ValueError) as exc:
            raise WeChatIntegrationError(f"{context}返回了无法解析的 JSON") from exc
        if not isinstance(payload, dict):
            raise WeChatIntegrationError(f"{context}返回格式无效")
        return payload

    @staticmethod
    def _api_error(payload: dict[str, Any], context: str) -> WeChatIntegrationError:
        code = int(payload.get("errcode") or 0)
        message = str(payload.get("errmsg") or "未知错误")
        return WeChatIntegrationError(f"{context}失败（{code}）：{message}")

    async def _request_access_token(self) -> tuple[str, int]:
        try:
            async with CurlAsyncSession() as client:
                response = await client.get(
                    f"{WECHAT_API_BASE_URL}/cgi-bin/token",
                    params={
                        "grant_type": "client_credential",
                        "appid": self.settings.wechat_app_id,
                        "secret": self.settings.wechat_app_secret,
                    },
                    timeout=20,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise WeChatIntegrationError(f"获取微信 access_token 请求失败: {exc}") from exc
        payload = self._payload(response, "获取微信 access_token")
        if int(payload.get("errcode") or 0):
            raise self._api_error(payload, "获取微信 access_token")
        token = str(payload.get("access_token") or "")
        if not token:
            raise WeChatIntegrationError("获取微信 access_token 响应缺少 access_token")
        return token, max(60, int(payload.get("expires_in") or 7200))

    async def access_token(self) -> str:
        if self._token_is_usable():
            return self._access_token
        async with self._token_lock:
            if self._token_is_usable():
                return self._access_token
            token, expires_in = await self._request_access_token()
            self._access_token = token
            usable_for = max(30, expires_in - TOKEN_REFRESH_SKEW_SECONDS)
            self._access_token_expires_at = time.monotonic() + usable_for
            return token

    async def _send_once(
        self,
        *,
        access_token: str,
        open_id: str,
        template_id: str,
        template_data: dict[str, dict[str, str]],
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "touser": open_id,
            "template_id": template_id,
            "data": template_data,
        }
        try:
            async with CurlAsyncSession() as client:
                response = await client.post(
                    f"{WECHAT_API_BASE_URL}/cgi-bin/message/template/send",
                    params={"access_token": access_token},
                    json=body,
                    timeout=20,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise WeChatIntegrationError(f"发送微信模板消息请求失败: {exc}") from exc
        return self._payload(response, "发送微信模板消息")

    async def send_template_message(
        self,
        *,
        open_id: str,
        template_id: str,
        template_data: dict[str, dict[str, str]],
    ) -> str:
        chosen = str(template_id or "").strip()
        if not chosen:
            raise WeChatIntegrationError("微信模板 ID 尚未配置")
        for attempt in range(2):
            token = await self.access_token()
            payload = await self._send_once(
                access_token=token,
                open_id=open_id,
                template_id=chosen,
                template_data=template_data,
            )
            error_code = int(payload.get("errcode") or 0)
            if not error_code:
                return str(payload.get("msgid") or "")
            if attempt == 0 and error_code in TOKEN_ERROR_CODES:
                self.reset_credentials()
                continue
            raise self._api_error(payload, "发送微信模板消息")
        raise WeChatIntegrationError("发送微信模板消息失败")

    async def send_to_recipient(
        self,
        *,
        template_data: dict[str, dict[str, str]],
        template_id: str = "",
    ) -> dict[str, Any]:
        open_id = self.settings.wechat_openid.strip()
        if not open_id:
            raise WeChatIntegrationError("微信推送 OpenID 尚未配置")
        message_id = await self.send_template_message(
            open_id=open_id,
            template_id=template_id or self.settings.wechat_template_id,
            template_data=template_data,
        )
        return {
            "sent": 1,
            "messages": [{"openId": open_id, "messageId": message_id}],
        }
