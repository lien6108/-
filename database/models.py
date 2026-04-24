"""
資料庫模型定義 (SQLAlchemy)
- Group: LINE 群組
- Member: 群組內成員
- Expense: 費用項目 ($ 觸發創建)
- ExpenseSplit: 費用分擔記錄
"""

from datetime import datetime
from sqlalchemy import (
    create_engine, Column, String, Float, Boolean,
    DateTime, ForeignKey, Integer, Text
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from config import DATABASE_URL

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Group(Base):
    """LINE 群組"""
    __tablename__ = "groups"

    id = Column(String, primary_key=True)          # LINE group_id
    name = Column(String, default="")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    session_open = Column(Boolean, default=False)  # 是否有開啟中的分帳 session

    members = relationship("Member", back_populates="group", cascade="all, delete-orphan")
    expenses = relationship("Expense", back_populates="group", cascade="all, delete-orphan")


class Member(Base):
    """群組成員"""
    __tablename__ = "members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(String, ForeignKey("groups.id"), nullable=False)
    user_id = Column(String, nullable=False)        # LINE user_id
    display_name = Column(String, default="Unknown")
    joined_at = Column(DateTime, default=datetime.utcnow)
    is_participating = Column(Boolean, default=True)  # 是否參與此次分帳

    group = relationship("Group", back_populates="members")


class Expense(Base):
    """費用項目 — 由 $ 觸發"""
    __tablename__ = "expenses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(String, ForeignKey("groups.id"), nullable=False)
    payer_user_id = Column(String, nullable=False)   # 代墊者 LINE user_id
    payer_name = Column(String, default="Unknown")
    description = Column(Text, default="")           # 項目名稱
    amount = Column(Float, nullable=False)            # 金額
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    is_settled = Column(Boolean, default=False)

    group = relationship("Group", back_populates="expenses")
    splits = relationship("ExpenseSplit", back_populates="expense", cascade="all, delete-orphan")


class ExpenseSplit(Base):
    """費用分擔記錄 — 誰要還誰多少"""
    __tablename__ = "expense_splits"

    id = Column(Integer, primary_key=True, autoincrement=True)
    expense_id = Column(Integer, ForeignKey("expenses.id"), nullable=False)
    debtor_user_id = Column(String, nullable=False)  # 欠款者
    debtor_name = Column(String, default="Unknown")
    share_amount = Column(Float, nullable=False)      # 應分擔金額
    is_paid = Column(Boolean, default=False)

    expense = relationship("Expense", back_populates="splits")


def init_db():
    """初始化資料庫表格"""
    Base.metadata.create_all(bind=engine)


def get_db():
    """FastAPI 依賴注入用的 DB session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
