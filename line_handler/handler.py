"""
LINE Bot 事件處理器
將 LINE Webhook 事件轉譯後交給 MainAgent 處理
"""

import asyncio
from linebot.v3 import WebhookParser
from linebot.v3.messaging import (
    AsyncApiClient, AsyncMessagingApi, Configuration,
    ReplyMessageRequest, TextMessage
)
from linebot.v3.webhooks import (
    MessageEvent, TextMessageContent,
    JoinEvent, MemberJoinedEvent
)
from sqlalchemy.orm import Session
from config import LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET
from agents.main_agent import MainAgent

# LINE SDK 設定
configuration = Configuration(access_token=LINE_CHANNEL_ACCESS_TOKEN)
parser = WebhookParser(LINE_CHANNEL_SECRET)


class LineEventHandler:
    """
    LINE 事件處理器
    負責：
    - 解析 LINE Webhook 事件
    - 呼叫 MainAgent 取得回應
    - 透過 LINE Messaging API 回覆訊息
    """

    def __init__(self):
        self.main_agent = MainAgent()

    async def handle_events(self, body: str, signature: str, db: Session):
        """解析並處理所有 LINE 事件"""
        try:
            events = parser.parse(body, signature)
        except Exception as e:
            print(f"[LineEventHandler] 解析事件失敗: {e}")
            raise

        async with AsyncApiClient(configuration) as api_client:
            line_bot_api = AsyncMessagingApi(api_client)

            tasks = [
                self._dispatch(event, db, line_bot_api)
                for event in events
            ]
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _dispatch(self, event, db: Session, line_bot_api: AsyncMessagingApi):
        """根據事件類型分派處理"""
        try:
            if isinstance(event, MessageEvent) and isinstance(event.message, TextMessageContent):
                await self._handle_text(event, db, line_bot_api)
            elif isinstance(event, JoinEvent):
                await self._handle_join(event, db, line_bot_api)
            elif isinstance(event, MemberJoinedEvent):
                await self._handle_member_join(event, db, line_bot_api)
        except Exception as e:
            print(f"[LineEventHandler] 事件處理錯誤: {e}")

    async def _handle_text(self, event: MessageEvent, db: Session, line_bot_api: AsyncMessagingApi):
        """處理文字訊息"""
        source = event.source
        group_id = getattr(source, 'group_id', None) or getattr(source, 'room_id', None)
        user_id = source.user_id or "unknown"

        if not group_id:
            # 私訊場景 — 暫不支援
            await self._reply(line_bot_api, event.reply_token, "請將我加入群組後使用 🙏")
            return

        # 取得使用者名稱
        display_name = await self._get_display_name(line_bot_api, group_id, user_id)

        reply_text = await self.main_agent.process_message(
            db=db,
            group_id=group_id,
            user_id=user_id,
            display_name=display_name,
            text=event.message.text
        )

        if reply_text:
            await self._reply(line_bot_api, event.reply_token, reply_text)

    async def _handle_join(self, event: JoinEvent, db: Session, line_bot_api: AsyncMessagingApi):
        """Bot 加入群組/聊天室"""
        source = event.source
        group_id = getattr(source, 'group_id', None) or getattr(source, 'room_id', "unknown")
        reply_text = await self.main_agent.handle_bot_join_group(db, group_id)
        await self._reply(line_bot_api, event.reply_token, reply_text)

    async def _handle_member_join(self, event: MemberJoinedEvent, db: Session, line_bot_api: AsyncMessagingApi):
        """新成員加入群組"""
        source = event.source
        group_id = getattr(source, 'group_id', "unknown")
        for member in event.joined.members:
            user_id = member.user_id
            display_name = await self._get_display_name(line_bot_api, group_id, user_id)
            reply = await self.main_agent.handle_member_join(db, group_id, user_id, display_name)
            # 新成員加入不主動回覆，避免打擾

    async def _get_display_name(self, line_bot_api: AsyncMessagingApi, group_id: str, user_id: str) -> str:
        """取得群組成員顯示名稱"""
        try:
            profile = await line_bot_api.get_group_member_profile(group_id, user_id)
            return profile.display_name
        except Exception:
            return f"用戶{user_id[-4:]}"

    async def _reply(self, line_bot_api: AsyncMessagingApi, reply_token: str, text: str):
        """發送回覆訊息（自動截斷超過 5000 字）"""
        if len(text) > 5000:
            text = text[:4990] + "…（訊息過長已截斷）"
        await line_bot_api.reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=text)]
            )
        )
