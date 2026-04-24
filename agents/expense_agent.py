"""
Expense Agent — 費用記錄專員
負責處理 $ 觸發的費用記錄與更新邏輯。
"""

from sqlalchemy.orm import Session
from database import crud
from database.models import Expense


class ExpenseAgent:
    """
    角色：費用記錄專員
    職責：
    - 接收 NLPAgent 解析後的費用資訊
    - 建立或更新費用項目
    - 自動按參與人數平均分攤
    - 回傳格式化的確認訊息
    """

    async def add_expense(
        self,
        db: Session,
        group_id: str,
        payer_user_id: str,
        payer_name: str,
        description: str,
        amount: float
    ) -> str:
        """新增費用項目"""
        participants = crud.get_participating_members(db, group_id)
        if not participants:
            return (
                "⚠️ 尚無參與分帳的成員。\n"
                "請先輸入「加入」加入分帳，再記錄費用。"
            )

        expense = crud.create_expense(
            db=db,
            group_id=group_id,
            payer_user_id=payer_user_id,
            payer_name=payer_name,
            description=description,
            amount=amount
        )

        n = len(participants)
        share = round(amount / n, 2)
        debtors = [m.display_name for m in participants if m.user_id != payer_user_id]
        debtors_str = "、".join(debtors) if debtors else "（無其他人）"

        return (
            f"💰 已記錄費用 #{expense.id}\n"
            f"  項目：{description}\n"
            f"  代墊：{payer_name}\n"
            f"  金額：${amount:,.0f}\n"
            f"  共 {n} 人平攤，每人 ${share:,.1f}\n"
            f"  待還清人員：{debtors_str}"
        )

    async def update_expense(
        self,
        db: Session,
        expense_id: int,
        new_amount: float,
        operator_name: str
    ) -> str:
        """更新現有費用金額"""
        expense = crud.update_expense_amount(db, expense_id, new_amount)
        if not expense:
            return f"⚠️ 找不到費用 #{expense_id}，請確認編號是否正確。"

        participants = crud.get_participating_members(db, expense.group_id)
        n = len(participants) if participants else 1
        share = round(new_amount / n, 2)

        return (
            f"✏️ 費用 #{expense_id} 已更新\n"
            f"  項目：{expense.description}\n"
            f"  新金額：${new_amount:,.0f}\n"
            f"  每人分攤：${share:,.1f}\n"
            f"  更新者：{operator_name}"
        )

    async def list_expenses(self, db: Session, group_id: str) -> str:
        """列出未結算的費用清單"""
        expenses = crud.get_unsettled_expenses(db, group_id)
        if not expenses:
            return "📋 目前沒有未結算的費用。"

        total = sum(e.amount for e in expenses)
        lines = []
        for e in expenses:
            lines.append(f"  #{e.id} {e.description}  ${e.amount:,.0f}  （{e.payer_name} 代墊）")

        return (
            f"📋 未結算費用清單（共 {len(expenses)} 筆）：\n"
            + "\n".join(lines)
            + f"\n\n  合計：${total:,.0f}"
        )
