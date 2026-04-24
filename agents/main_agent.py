"""
Main Agent — 主要協調者 (Orchestrator)
負責接收 LINE 訊息事件，判斷意圖後分配工作給各 Sub-Agent。

Sub-Agent 分工：
  NLPAgent       → 語意解析、意圖分類、費用擷取
  MemberAgent    → 成員加入/退出管理
  ExpenseAgent   → 費用新增/更新/查詢
  SettlementAgent → 結算計算與確認
"""

from sqlalchemy.orm import Session
from agents.nlp_agent import NLPAgent
from agents.member_agent import MemberAgent
from agents.expense_agent import ExpenseAgent
from agents.settlement_agent import SettlementAgent
from database import crud


HELP_TEXT = """🤖 分帳神器指令說明

💰 記錄費用：
  $金額 項目名稱
  例：$500 晚餐、$1200 計程車

✏️ 更新費用：
  更新 #編號 $新金額
  例：更新 #3 $600

👥 成員管理：
  加入 → 加入此次分帳
  退出 → 退出此次分帳
  成員 → 查看參與人員

📋 查看費用：
  清單 / 費用 / 明細

📊 結算：
  結算   → 預覽結算金額
  確認結算 → 完成結算並清除紀錄

❓ 說明：help / 說明"""


class MainAgent:
    """
    角色：主協調者
    職責：
    1. 路由訊息到對應的 Sub-Agent
    2. 維護跨 Agent 的上下文（群組狀態）
    3. 統整 Sub-Agent 回傳的結果
    """

    def __init__(self):
        self.nlp = NLPAgent()
        self.member = MemberAgent()
        self.expense = ExpenseAgent()
        self.settlement = SettlementAgent()

    async def process_message(
        self,
        db: Session,
        group_id: str,
        user_id: str,
        display_name: str,
        text: str
    ) -> str | None:
        """
        主要訊息處理入口。
        回傳回覆文字，若為 None 則不回覆。
        """
        # 確保成員存在
        await self.member.ensure_member(db, group_id, user_id, display_name)

        # ── 特殊指令快速路由（優先於 NLP）──────────────────────
        text_stripped = text.strip()

        # 加入分帳
        if any(k in text_stripped for k in ["加入", "join", "我要參加", "算我"]):
            return await self.member.handle_join_group(db, group_id, user_id, display_name)

        # 退出分帳
        if any(k in text_stripped for k in ["退出", "leave", "不算我", "我不參加"]):
            return await self.member.handle_leave(db, group_id, user_id, display_name)

        # 查看成員
        if any(k in text_stripped for k in ["成員", "人員", "members"]):
            return await self.member.get_member_list(db, group_id)

        # 費用清單
        if any(k in text_stripped for k in ["清單", "費用", "明細", "list"]):
            return await self.expense.list_expenses(db, group_id)

        # 確認結算（比「結算」優先判斷）
        if "確認結算" in text_stripped:
            return await self.settlement.confirm_settlement(db, group_id)

        # 預覽結算
        if any(k in text_stripped for k in ["結算", "settle", "算帳", "結帳"]):
            return await self.settlement.show_settlement(db, group_id)

        # 更新費用：「更新 #3 $600」
        import re
        update_match = re.match(r'更新\s*#(\d+)\s*\$\s*([\d,]+(?:\.\d+)?)', text_stripped)
        if update_match:
            expense_id = int(update_match.group(1))
            new_amount = float(update_match.group(2).replace(',', ''))
            return await self.expense.update_expense(db, expense_id, new_amount, display_name)

        # 說明
        if any(k in text_stripped.lower() for k in ["help", "說明", "指令", "怎麼用", "幫助"]):
            return HELP_TEXT

        # ── 費用記錄（$ 觸發）────────────────────────────────────
        if '$' in text_stripped:
            parsed = await self.nlp.parse_expense_message(text_stripped)
            if parsed and "amount" in parsed:
                return await self.expense.add_expense(
                    db=db,
                    group_id=group_id,
                    payer_user_id=user_id,
                    payer_name=display_name,
                    description=parsed.get("description", "費用"),
                    amount=parsed["amount"]
                )
            else:
                return "⚠️ 無法解析金額，請使用格式：$金額 項目名稱\n例：$500 晚餐"

        # ── 語意分類兜底（複雜自然語言）──────────────────────────
        intent = await self.nlp.classify_intent(text_stripped)
        if intent == "settle":
            return await self.settlement.show_settlement(db, group_id)
        if intent == "list":
            return await self.expense.list_expenses(db, group_id)
        if intent == "help":
            return HELP_TEXT

        # Bot 不干預一般聊天
        return None

    async def handle_bot_join_group(self, db: Session, group_id: str) -> str:
        """Bot 被加入群組時的歡迎訊息"""
        crud.get_or_create_group(db, group_id)
        return (
            "👋 大家好！我是分帳神器！\n\n"
            "📌 使用方式：\n"
            "1️⃣ 輸入「加入」加入此次分帳\n"
            "2️⃣ 花費時輸入：$金額 項目名稱\n"
            "   例：$500 晚餐\n"
            "3️⃣ 輸入「結算」查看每人應還金額\n"
            "4️⃣ 輸入「確認結算」完成結算\n\n"
            "輸入「說明」查看完整指令列表 🙌"
        )

    async def handle_member_join(
        self,
        db: Session,
        group_id: str,
        user_id: str,
        display_name: str
    ) -> str | None:
        """新成員加入群組事件（不自動加入分帳，需主動輸入「加入」）"""
        crud.upsert_member(db, group_id, user_id, display_name)
        # 不自動加入，讓使用者自行決定是否參與
        return None
