"""
資料庫 CRUD 操作
"""

from datetime import datetime
from sqlalchemy.orm import Session
from database.models import Group, Member, Expense, ExpenseSplit
from collections import defaultdict


# ─── Group ────────────────────────────────────────────────────

def get_or_create_group(db: Session, group_id: str) -> Group:
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        group = Group(id=group_id)
        db.add(group)
        db.commit()
        db.refresh(group)
    return group


def set_session_open(db: Session, group_id: str, open: bool):
    group = get_or_create_group(db, group_id)
    group.session_open = open
    db.commit()


# ─── Member ───────────────────────────────────────────────────

def get_member(db: Session, group_id: str, user_id: str) -> Member | None:
    return db.query(Member).filter(
        Member.group_id == group_id,
        Member.user_id == user_id
    ).first()


def upsert_member(db: Session, group_id: str, user_id: str, display_name: str) -> Member:
    get_or_create_group(db, group_id)
    member = get_member(db, group_id, user_id)
    if not member:
        member = Member(group_id=group_id, user_id=user_id, display_name=display_name)
        db.add(member)
    else:
        member.display_name = display_name
    db.commit()
    db.refresh(member)
    return member


def set_participation(db: Session, group_id: str, user_id: str, participating: bool):
    member = get_member(db, group_id, user_id)
    if member:
        member.is_participating = participating
        db.commit()


def get_participating_members(db: Session, group_id: str) -> list[Member]:
    return db.query(Member).filter(
        Member.group_id == group_id,
        Member.is_participating == True
    ).all()


def get_all_members(db: Session, group_id: str) -> list[Member]:
    return db.query(Member).filter(Member.group_id == group_id).all()


# ─── Expense ──────────────────────────────────────────────────

def create_expense(
    db: Session,
    group_id: str,
    payer_user_id: str,
    payer_name: str,
    description: str,
    amount: float
) -> Expense:
    get_or_create_group(db, group_id)
    expense = Expense(
        group_id=group_id,
        payer_user_id=payer_user_id,
        payer_name=payer_name,
        description=description,
        amount=amount,
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)

    # 自動為參與成員建立分擔記錄
    participants = get_participating_members(db, group_id)
    if participants:
        share = round(amount / len(participants), 2)
        for member in participants:
            if member.user_id == payer_user_id:
                continue  # 代墊者不需還給自己
            split = ExpenseSplit(
                expense_id=expense.id,
                debtor_user_id=member.user_id,
                debtor_name=member.display_name,
                share_amount=share,
            )
            db.add(split)
    db.commit()
    db.refresh(expense)
    return expense


def update_expense_amount(db: Session, expense_id: int, new_amount: float) -> Expense | None:
    expense = db.query(Expense).filter(Expense.id == expense_id).first()
    if not expense:
        return None
    expense.amount = new_amount
    expense.updated_at = datetime.utcnow()

    # 重新計算分擔
    participants = get_participating_members(db, expense.group_id)
    if participants:
        share = round(new_amount / len(participants), 2)
        for split in expense.splits:
            split.share_amount = share
    db.commit()
    db.refresh(expense)
    return expense


def get_unsettled_expenses(db: Session, group_id: str) -> list[Expense]:
    return db.query(Expense).filter(
        Expense.group_id == group_id,
        Expense.is_settled == False
    ).all()


def mark_all_settled(db: Session, group_id: str):
    expenses = get_unsettled_expenses(db, group_id)
    for exp in expenses:
        exp.is_settled = True
        for split in exp.splits:
            split.is_paid = True
    db.commit()


# ─── Settlement ───────────────────────────────────────────────

def calculate_settlement(db: Session, group_id: str) -> dict:
    """
    計算每個人的淨收支，回傳最簡化的還款清單。
    回傳格式:
    {
        "balances": {"user_id": {"name": ..., "net": ...}},
        "transactions": [{"from": ..., "from_name": ..., "to": ..., "to_name": ..., "amount": ...}]
    }
    """
    expenses = get_unsettled_expenses(db, group_id)

    # 計算每人淨額 (正=應收, 負=應付)
    net: dict[str, float] = defaultdict(float)
    names: dict[str, str] = {}

    for exp in expenses:
        net[exp.payer_user_id] += exp.amount
        names[exp.payer_user_id] = exp.payer_name
        for split in exp.splits:
            net[split.debtor_user_id] -= split.share_amount
            names[split.debtor_user_id] = split.debtor_name
            # 代墊者扣掉自己的份
        # 代墊者也要扣自己的份
        participants = get_participating_members(db, group_id)
        if participants:
            payer_share = round(exp.amount / len(participants), 2)
            net[exp.payer_user_id] -= payer_share

    # 最簡化交易 (greedy)
    creditors = sorted([(uid, v) for uid, v in net.items() if v > 0.01], key=lambda x: -x[1])
    debtors = sorted([(uid, -v) for uid, v in net.items() if v < -0.01], key=lambda x: -x[1])

    transactions = []
    ci, di = 0, 0
    while ci < len(creditors) and di < len(debtors):
        c_id, c_amt = creditors[ci]
        d_id, d_amt = debtors[di]
        pay = round(min(c_amt, d_amt), 2)
        transactions.append({
            "from": d_id,
            "from_name": names.get(d_id, d_id),
            "to": c_id,
            "to_name": names.get(c_id, c_id),
            "amount": pay
        })
        creditors[ci] = (c_id, round(c_amt - pay, 2))
        debtors[di] = (d_id, round(d_amt - pay, 2))
        if creditors[ci][1] < 0.01:
            ci += 1
        if debtors[di][1] < 0.01:
            di += 1

    return {
        "balances": {uid: {"name": names.get(uid, uid), "net": round(v, 2)} for uid, v in net.items()},
        "transactions": transactions
    }
