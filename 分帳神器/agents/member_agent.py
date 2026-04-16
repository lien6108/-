"""
Member Agent — 成員管理專員
負責處理成員加入/退出分帳的邏輯。
"""

from sqlalchemy.orm import Session
from database import crud
from database.models import Member


class MemberAgent:
    """
    角色：成員管理專員
    職責：
    - 當 Bot 被加入群組時初始化群組
    - 處理成員加入/退出分帳的請求
    - 查詢目前參與成員清單
    """

    async def handle_join_group(self, db: Session, group_id: str, user_id: str, display_name: str) -> str:
        """Bot 加入群組時初始化，或成員加入分帳"""
        crud.upsert_member(db, group_id, user_id, display_name)
        crud.set_participation(db, group_id, user_id, True)
        members = crud.get_participating_members(db, group_id)
        names = [m.display_name for m in members]
        return (
            f"✅ {display_name} 已加入分帳！\n"
            f"目前參與人員（{len(names)} 人）：{', '.join(names)}"
        )

    async def handle_leave(self, db: Session, group_id: str, user_id: str, display_name: str) -> str:
        """成員退出分帳"""
        crud.set_participation(db, group_id, user_id, False)
        members = crud.get_participating_members(db, group_id)
        names = [m.display_name for m in members]
        remaining = f"剩餘參與人員：{', '.join(names)}" if names else "目前無參與人員"
        return f"👋 {display_name} 已退出此次分帳。\n{remaining}"

    async def ensure_member(self, db: Session, group_id: str, user_id: str, display_name: str):
        """確保成員存在於資料庫（首次發言自動加入）"""
        member = crud.get_member(db, group_id, user_id)
        if not member:
            crud.upsert_member(db, group_id, user_id, display_name)

    async def get_member_list(self, db: Session, group_id: str) -> str:
        """取得參與成員清單文字"""
        members = crud.get_participating_members(db, group_id)
        if not members:
            return "目前沒有人參與分帳。\n請輸入「加入」來加入分帳。"
        lines = [f"  {i+1}. {m.display_name}" for i, m in enumerate(members)]
        return "👥 目前參與分帳人員：\n" + "\n".join(lines)
