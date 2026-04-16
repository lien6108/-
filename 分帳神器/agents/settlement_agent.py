"""
Settlement Agent — 結算專員
負責計算最終每人應還款項並生成結算報告。
"""

from sqlalchemy.orm import Session
from database import crud


class SettlementAgent:
    """
    角色：結算專員
    職責：
    - 計算每人淨收支
    - 生成最簡化還款清單（誰還誰多少）
    - 確認結算後標記所有費用為已結清
    """

    async def show_settlement(self, db: Session, group_id: str) -> str:
        """
        顯示結算報告（不標記結清，僅預覽）。
        """
        result = crud.calculate_settlement(db, group_id)
        return self._format_settlement(result, preview=True)

    async def confirm_settlement(self, db: Session, group_id: str) -> str:
        """
        確認結算：計算報告並標記所有費用為已結清。
        """
        result = crud.calculate_settlement(db, group_id)
        if not result["transactions"]:
            return "✅ 目前沒有需要結算的費用，大家是平的！"

        crud.mark_all_settled(db, group_id)
        crud.set_session_open(db, group_id, False)
        report = self._format_settlement(result, preview=False)
        return report + "\n\n🎉 已完成結算！所有費用已標記為結清。"

    def _format_settlement(self, result: dict, preview: bool) -> str:
        transactions = result["transactions"]
        balances = result["balances"]

        if not transactions:
            return "✅ 大家費用平等，不需要互相轉帳！"

        lines = []
        prefix = "📊 結算預覽" if preview else "📊 最終結算"
        lines.append(prefix)
        lines.append("─" * 28)

        # 收支狀況
        lines.append("💼 個人收支：")
        for uid, info in balances.items():
            net = info["net"]
            name = info["name"]
            if net > 0.01:
                lines.append(f"  {name}：應收 ${net:,.1f}")
            elif net < -0.01:
                lines.append(f"  {name}：應付 ${abs(net):,.1f}")
            else:
                lines.append(f"  {name}：持平")

        lines.append("")
        lines.append("💸 轉帳清單：")
        for t in transactions:
            lines.append(f"  {t['from_name']} → {t['to_name']}  ${t['amount']:,.1f}")

        if preview:
            lines.append("")
            lines.append("輸入「確認結算」以完成結算。")

        return "\n".join(lines)
