import { Env } from '../env';

export interface Group {
  id: string;
  name: string;
  is_active: number;
  session_open: number;
  current_trip_id?: number | null;
}

export interface Member {
  id: number;
  group_id: string;
  user_id: string;
  display_name: string;
  is_participating: number;
}

export interface Expense {
  id: number;
  group_id: string;
  trip_id?: number | null;
  group_seq: number;
  payer_user_id: string;
  payer_name: string;
  description: string;
  amount: number;
  currency?: string;
  original_amount?: number;
  is_settled: number;
  created_at: string;
}

export interface ExpenseSplit {
  id: number;
  expense_id: number;
  debtor_user_id: string;
  debtor_name: string;
  share_amount: number;
  is_paid: number;
}

export interface Session {
  user_id: string;
  group_id: string;
  step: string;
  data: string;
  updated_at: string;
}

export interface Trip {
  id: number;
  group_id: string;
  trip_name: string;
  status: 'active' | 'closed';
  created_at: string;
  closed_at?: string | null;
}

export interface WizardData {
  description?: string;
  amount?: number;
  currency?: string;
  payerUserId?: string;
  payerName?: string;
  specificUserIds?: string[];
  groupSeq?: number;
  [key: string]: any;
}

export interface ItinerarySpot {
  id: number;
  trip_id: number;
  day: number;
  sort_order: number;
  name: string;
  maps_url?: string | null;
  status: 'pending' | 'done';
  created_at: string;
}

export interface ShoppingItem {
  id: number;
  trip_id: number;
  assignee: string;
  item: string;
  spot_id?: number | null;
  is_bought: number;
  created_at: string;
}

export class CRUD {
  private db: D1Database;

  constructor(env: Env) {
    this.db = env.DB;
  }

  // --- Group ---
  async getOrCreateGroup(groupId: string): Promise<Group> {
    let group = await this.db.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<Group>();
    if (!group) {
      await this.db.prepare(`INSERT INTO groups (id) VALUES (?)`).bind(groupId).run();
      group = await this.db.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId).first<Group>();
    }
    return group!;
  }

  async setGroupActive(groupId: string, isActive: boolean): Promise<void> {
    await this.getOrCreateGroup(groupId);
    await this.db.prepare(`UPDATE groups SET is_active = ? WHERE id = ?`).bind(isActive ? 1 : 0, groupId).run();
  }

  async isGroupActive(groupId: string): Promise<boolean> {
    const group = await this.getOrCreateGroup(groupId);
    return group.is_active === 1;
  }

  // --- Admin: clear all data ---
  async clearAllData(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM expense_splits`),
      this.db.prepare(`DELETE FROM expenses`),
      this.db.prepare(`DELETE FROM sessions`),
      this.db.prepare(`UPDATE groups SET current_trip_id = NULL`),
      this.db.prepare(`DELETE FROM trips`),
      this.db.prepare(`UPDATE group_members SET is_participating = 0`),
    ]);
  }

  // --- System settings ---
  async setMaintenanceMode(enabled: boolean): Promise<void> {
    await this.db.prepare(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('maintenance_mode', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    ).bind(enabled ? '1' : '0').run();
  }

  async isMaintenanceMode(): Promise<boolean> {
    const row = await this.db.prepare(`SELECT value FROM system_settings WHERE key = 'maintenance_mode'`).first<{ value: string }>();
    return row?.value === '1';
  }

  // --- Trip ---
  async getCurrentTrip(groupId: string): Promise<Trip | null> {
    await this.getOrCreateGroup(groupId);
    const group = await this.db.prepare(`SELECT current_trip_id FROM groups WHERE id = ?`).bind(groupId).first<{ current_trip_id?: number | null }>();
    if (!group?.current_trip_id) return null;
    return this.db.prepare(`SELECT * FROM trips WHERE id = ?`).bind(group.current_trip_id).first<Trip>();
  }

  async startNewTrip(groupId: string, tripName: string): Promise<Trip> {
    await this.getOrCreateGroup(groupId);

    const current = await this.getCurrentTrip(groupId);
    if (current && current.status === 'active') {
      await this.closeCurrentTrip(groupId);
    }

    const created = await this.db.prepare(
      `INSERT INTO trips (group_id, trip_name, status, created_at)
       VALUES (?, ?, 'active', CURRENT_TIMESTAMP) RETURNING *`
    ).bind(groupId, tripName).first<Trip>();

    await this.db.prepare(`UPDATE groups SET current_trip_id = ? WHERE id = ?`).bind(created!.id, groupId).run();
    return created!;
  }

  async updateTripName(groupId: string, tripName: string): Promise<Trip | null> {
    const current = await this.getCurrentTrip(groupId);
    if (!current) return null;
    await this.db.prepare(`UPDATE trips SET trip_name = ? WHERE id = ?`).bind(tripName, current.id).run();
    return this.db.prepare(`SELECT * FROM trips WHERE id = ?`).bind(current.id).first<Trip>();
  }

  async closeCurrentTrip(groupId: string): Promise<void> {
    const current = await this.getCurrentTrip(groupId);
    if (!current) return;
    await this.db.prepare(
      `UPDATE trips SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(current.id).run();
    await this.db.prepare(`UPDATE groups SET current_trip_id = NULL WHERE id = ?`).bind(groupId).run();
  }

  async getTripHistory(groupId: string, limit = 20): Promise<Trip[]> {
    const res = await this.db.prepare(
      `SELECT * FROM trips WHERE group_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(groupId, limit).all<Trip>();
    return res.results || [];
  }

  async getGroupsByUserId(userId: string): Promise<string[]> {
    const res = await this.db.prepare(
      `SELECT DISTINCT group_id FROM members WHERE user_id = ? AND is_participating = 1`
    ).bind(userId).all<{ group_id: string }>();
    return (res.results || []).map(r => r.group_id);
  }

  async getAllGroupsByUserId(userId: string): Promise<string[]> {
    const res = await this.db.prepare(
      `SELECT DISTINCT group_id FROM expenses WHERE payer_user_id = ?
       UNION
       SELECT DISTINCT e.group_id FROM expense_splits es
         JOIN expenses e ON es.expense_id = e.id
         WHERE es.debtor_user_id = ?`
    ).bind(userId, userId).all<{ group_id: string }>();
    return (res.results || []).map(r => r.group_id);
  }

  // --- Member ---
  async getMember(groupId: string, userId: string): Promise<Member | null> {
    return this.db.prepare(`SELECT * FROM members WHERE group_id = ? AND user_id = ?`).bind(groupId, userId).first<Member>();
  }

  async upsertMember(groupId: string, userId: string, displayName: string): Promise<Member> {
    await this.getOrCreateGroup(groupId);
    const existing = await this.getMember(groupId, userId);
    if (!existing) {
      await this.db.prepare(
        `INSERT INTO members (group_id, user_id, display_name, is_participating) VALUES (?, ?, ?, 0)`
      ).bind(groupId, userId, displayName).run();
    } else {
      await this.db.prepare(`UPDATE members SET display_name = ? WHERE id = ?`).bind(displayName, existing.id).run();
    }
    return this.getMember(groupId, userId) as Promise<Member>;
  }

  async setParticipation(groupId: string, userId: string, participating: boolean): Promise<void> {
    await this.db.prepare(`UPDATE members SET is_participating = ? WHERE group_id = ? AND user_id = ?`)
      .bind(participating ? 1 : 0, groupId, userId).run();
  }

  async getParticipatingMembers(groupId: string): Promise<Member[]> {
    const res = await this.db.prepare(`SELECT * FROM members WHERE group_id = ? AND is_participating = 1`).bind(groupId).all<Member>();
    return res.results || [];
  }

  async getAllMembers(groupId: string): Promise<Member[]> {
    const res = await this.db.prepare(`SELECT * FROM members WHERE group_id = ?`).bind(groupId).all<Member>();
    return res.results || [];
  }

  async userHasUnsettledExpenses(groupId: string, userId: string): Promise<boolean> {
    const asPayer = await this.db.prepare(
      `SELECT COUNT(*) as count FROM expenses WHERE group_id = ? AND payer_user_id = ? AND is_settled = 0`
    ).bind(groupId, userId).first<{ count: number }>();
    if ((asPayer?.count || 0) > 0) return true;

    const asDebtor = await this.db.prepare(
      `SELECT COUNT(*) as count FROM expense_splits es
       JOIN expenses e ON es.expense_id = e.id
       WHERE e.group_id = ? AND es.debtor_user_id = ? AND e.is_settled = 0`
    ).bind(groupId, userId).first<{ count: number }>();
    return (asDebtor?.count || 0) > 0;
  }

  // --- Expense ---
  private async getNextGroupSeq(groupId: string, tripId?: string | null): Promise<number> {
    if (tripId) {
      const row = await this.db.prepare(`SELECT COALESCE(MAX(group_seq), 0) + 1 AS next_seq FROM expenses WHERE trip_id = ?`)
        .bind(tripId).first<{ next_seq: number }>();
      return row?.next_seq || 1;
    }
    const row = await this.db.prepare(`SELECT COALESCE(MAX(group_seq), 0) + 1 AS next_seq FROM expenses WHERE group_id = ?`)
      .bind(groupId).first<{ next_seq: number }>();
    return row?.next_seq || 1;
  }

  async createExpense(
    groupId: string,
    payerUserId: string,
    payerName: string,
    description: string,
    amount: number,
    specificUserIds?: string[],
    currency = 'TWD',
    originalAmount?: number
  ): Promise<Expense> {
    await this.getOrCreateGroup(groupId);
    const trip = await this.getCurrentTrip(groupId);
    const groupSeq = await this.getNextGroupSeq(groupId, trip?.id);

    const expense = await this.db.prepare(
      `INSERT INTO expenses (group_id, trip_id, group_seq, payer_user_id, payer_name, description, amount, currency, original_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(groupId, trip?.id || null, groupSeq, payerUserId, payerName, description, amount, currency, originalAmount || null).first<Expense>();

    let sharers: Member[];
    if (specificUserIds && specificUserIds.length > 0) {
      const all = await this.getAllMembers(groupId);
      sharers = all.filter(m => specificUserIds.includes(m.user_id));
      if (sharers.length === 0) {
        throw new Error('No valid split participants');
      }
    } else {
      sharers = await this.getParticipatingMembers(groupId);
    }

    if (sharers.length > 0) {
      const share = Math.round((amount / sharers.length) * 100) / 100;
      const statements = sharers.map(member =>
        this.db.prepare(
          `INSERT INTO expense_splits (expense_id, debtor_user_id, debtor_name, share_amount) VALUES (?, ?, ?, ?)`
        ).bind(expense!.id, member.user_id, member.display_name, share)
      );
      await this.db.batch(statements);
    }

    return expense!;
  }

  async getUnsettledExpenses(groupId: string): Promise<Expense[]> {
    const res = await this.db.prepare(
      `SELECT * FROM expenses WHERE group_id = ? AND is_settled = 0 ORDER BY created_at ASC`
    ).bind(groupId).all<Expense>();
    return res.results || [];
  }

  async getExpensesByTripId(tripId: number): Promise<Expense[]> {
    const res = await this.db.prepare(
      `SELECT * FROM expenses WHERE trip_id = ? ORDER BY group_seq ASC`
    ).bind(tripId).all<Expense>();
    return res.results || [];
  }

  async getExpenseByGroupSeq(groupId: string, groupSeq: number): Promise<Expense | null> {
    return this.db.prepare(
      `SELECT * FROM expenses WHERE group_id = ? AND group_seq = ? AND is_settled = 0`
    ).bind(groupId, groupSeq).first<Expense>();
  }

  async getExpenseSplits(expenseId: number): Promise<ExpenseSplit[]> {
    const res = await this.db.prepare(`SELECT * FROM expense_splits WHERE expense_id = ?`).bind(expenseId).all<ExpenseSplit>();
    return res.results || [];
  }

  async updateExpenseAmount(expenseId: number, newAmount: number, originalAmount?: number | null): Promise<Expense | null> {
    const expense = await this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
    if (!expense) return null;

    const finalOriginal = originalAmount !== undefined ? originalAmount : expense.original_amount;
    await this.db.prepare(
      `UPDATE expenses SET amount = ?, original_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(newAmount, finalOriginal ?? null, expenseId).run();

    return this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
  }

  async updateExpenseCurrency(expenseId: number, newCurrency: string, newRate: number | null): Promise<Expense | null> {
    const expense = await this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
    if (!expense) return null;

    let newAmount = expense.amount;
    let newOriginalAmount: number | undefined = expense.original_amount;

    if (newCurrency === 'TWD') {
      newAmount = expense.original_amount || expense.amount;
      newOriginalAmount = undefined;
    } else if (newRate) {
      newOriginalAmount = expense.original_amount || expense.amount;
      newAmount = Math.round(newOriginalAmount * newRate * 100) / 100;
    }

    await this.db.prepare(
      `UPDATE expenses
       SET currency = ?, original_amount = ?, amount = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(newCurrency, newOriginalAmount ?? null, newAmount, expenseId).run();

    return this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
  }

  async deleteExpense(expenseId: number): Promise<boolean> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM expense_splits WHERE expense_id = ?`).bind(expenseId),
      this.db.prepare(`DELETE FROM expenses WHERE id = ?`).bind(expenseId)
    ]);
    return true;
  }

  async settleAllExpenses(groupId: string): Promise<number> {
    const unsettled = await this.getUnsettledExpenses(groupId);
    if (unsettled.length === 0) return 0;
    await this.db.prepare(
      `UPDATE expenses SET is_settled = 1, updated_at = CURRENT_TIMESTAMP WHERE group_id = ? AND is_settled = 0`
    ).bind(groupId).run();
    return unsettled.length;
  }

  async resetParticipatingMembers(groupId: string): Promise<void> {
    await this.db.prepare(`UPDATE members SET is_participating = 0 WHERE group_id = ?`).bind(groupId).run();
  }

  async getMemberByDisplayName(groupId: string, displayName: string): Promise<Member | null> {
    const all = await this.getAllMembers(groupId);
    return all.find(m => m.display_name.toLowerCase() === displayName.toLowerCase()) || null;
  }

  async addExpenseSplits(expenseId: number, newDebtors: { userId: string; name: string }[]): Promise<string[]> {
    const expense = await this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
    if (!expense) return [];

    const current = await this.getExpenseSplits(expenseId);
    const existing = new Set(current.map(s => s.debtor_user_id));
    const toAdd = newDebtors.filter(d => !existing.has(d.userId));
    if (toAdd.length === 0) return [];

    const stmts = toAdd.map(d =>
      this.db.prepare(`INSERT INTO expense_splits (expense_id, debtor_user_id, debtor_name, share_amount) VALUES (?, ?, ?, 0)`)
        .bind(expenseId, d.userId, d.name)
    );
    await this.db.batch(stmts);
    await this.recalcSplitAmounts(expenseId);
    return toAdd.map(d => d.name);
  }

  async removeExpenseSplits(expenseId: number, removeUserIds: string[]): Promise<string[]> {
    const expense = await this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
    if (!expense) return [];

    const current = await this.getExpenseSplits(expenseId);
    const toRemove = current.filter(s => removeUserIds.includes(s.debtor_user_id));
    if (toRemove.length === 0) return [];

    const removedNames = toRemove.map(s => s.debtor_name);
    const stmts = toRemove.map(s => this.db.prepare(`DELETE FROM expense_splits WHERE id = ?`).bind(s.id));
    await this.db.batch(stmts);
    await this.recalcSplitAmounts(expenseId);
    return removedNames;
  }

  async recalcSplitAmounts(expenseId: number): Promise<void> {
    const expense = await this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
    if (!expense) return;
    const splits = await this.getExpenseSplits(expenseId);
    if (splits.length === 0) return;

    const share = Math.round((expense.amount / splits.length) * 100) / 100;
    await this.db.prepare(`UPDATE expense_splits SET share_amount = ? WHERE expense_id = ?`).bind(share, expenseId).run();
  }

  async updateExpensePayer(expenseId: number, payerUserId: string, payerName: string): Promise<Expense | null> {
    await this.db.prepare(
      `UPDATE expenses SET payer_user_id = ?, payer_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(payerUserId, payerName, expenseId).run();
    return this.db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first<Expense>();
  }

  async replaceExpenseSplits(expenseId: number, debtors: { userId: string; name: string }[]): Promise<void> {
    await this.db.prepare(`DELETE FROM expense_splits WHERE expense_id = ?`).bind(expenseId).run();
    if (debtors.length === 0) return;
    const stmts = debtors.map(d =>
      this.db.prepare(`INSERT INTO expense_splits (expense_id, debtor_user_id, debtor_name, share_amount) VALUES (?, ?, ?, 0)`)
        .bind(expenseId, d.userId, d.name)
    );
    await this.db.batch(stmts);
    await this.recalcSplitAmounts(expenseId);
  }

  // --- Settlement ---
  async calculateSettlement(groupId: string) {
    const expenses = await this.getUnsettledExpenses(groupId);
    const net: Record<string, number> = {};
    const names: Record<string, string> = {};

    for (const exp of expenses) {
      const splits = await this.getExpenseSplits(exp.id);
      net[exp.payer_user_id] = (net[exp.payer_user_id] || 0) + exp.amount;
      names[exp.payer_user_id] = exp.payer_name;

      for (const split of splits) {
        net[split.debtor_user_id] = (net[split.debtor_user_id] || 0) - split.share_amount;
        names[split.debtor_user_id] = split.debtor_name;
      }
    }

    const creditors = Object.entries(net).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
    const debtors = Object.entries(net).filter(([, v]) => v < -0.01).map(([k, v]) => [k, -v] as [string, number]).sort((a, b) => b[1] - a[1]);

    const transactions: Array<{ from: string; from_name: string; to: string; to_name: string; amount: number }> = [];
    let ci = 0;
    let di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const [cId, cAmt] = creditors[ci];
      const [dId, dAmt] = debtors[di];
      const pay = Math.round(Math.min(cAmt, dAmt) * 100) / 100;

      transactions.push({
        from: dId,
        from_name: names[dId] || dId,
        to: cId,
        to_name: names[cId] || cId,
        amount: pay
      });

      creditors[ci][1] -= pay;
      debtors[di][1] -= pay;
      if (creditors[ci][1] < 0.01) ci++;
      if (debtors[di][1] < 0.01) di++;
    }

    const balances: Record<string, { name: string; net: number }> = {};
    for (const [uid, value] of Object.entries(net)) {
      balances[uid] = { name: names[uid] || uid, net: Math.round(value * 100) / 100 };
    }

    return { balances, transactions };
  }

  // --- Exchange rate ---
  async getExchangeRate(currencyCode: string): Promise<number | null> {
    const row = await this.db.prepare(`SELECT rate FROM exchange_rates WHERE currency_code = ?`)
      .bind(currencyCode.toUpperCase()).first<{ rate: number }>();
    return row ? row.rate : null;
  }

  // --- Session ---
  async getSession(userId: string): Promise<Session | null> {
    return this.db.prepare(`SELECT * FROM sessions WHERE user_id = ?`).bind(userId).first<Session>();
  }

  async getGroupActiveSession(groupId: string): Promise<Session | null> {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE group_id = ? ORDER BY updated_at DESC LIMIT 1`
    ).bind(groupId).first<Session>();
  }

  async upsertSession(userId: string, groupId: string, step: string, data: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO sessions (user_id, group_id, step, data, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         group_id = excluded.group_id,
         step = excluded.step,
         data = excluded.data,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(userId, groupId, step, data).run();
  }

  async deleteSession(userId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  }

  async runMigrations(): Promise<void> {
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS itinerary_spots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL,
      day INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      maps_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    )`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS shopping_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL,
      assignee TEXT NOT NULL,
      item TEXT NOT NULL,
      spot_id INTEGER,
      is_bought INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    )`).run();
  } ───────────────────────────────────────────────────────────────

  async addSpot(tripId: number, day: number, name: string, mapsUrl?: string): Promise<void> {
    const res = await this.db.prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 as next FROM itinerary_spots WHERE trip_id = ? AND day = ?`
    ).bind(tripId, day).first<{ next: number }>();
    const order = res?.next ?? 1;
    await this.db.prepare(
      `INSERT INTO itinerary_spots (trip_id, day, sort_order, name, maps_url) VALUES (?, ?, ?, ?, ?)`
    ).bind(tripId, day, order, name, mapsUrl || null).run();
  }

  async getSpotsByDay(tripId: number, day: number): Promise<ItinerarySpot[]> {
    const res = await this.db.prepare(
      `SELECT * FROM itinerary_spots WHERE trip_id = ? AND day = ? ORDER BY sort_order ASC`
    ).bind(tripId, day).all<ItinerarySpot>();
    return res.results || [];
  }

  async getAllSpots(tripId: number): Promise<ItinerarySpot[]> {
    const res = await this.db.prepare(
      `SELECT * FROM itinerary_spots WHERE trip_id = ? ORDER BY day ASC, sort_order ASC`
    ).bind(tripId).all<ItinerarySpot>();
    return res.results || [];
  }

  async markSpotDone(spotId: number): Promise<void> {
    await this.db.prepare(`UPDATE itinerary_spots SET status = 'done' WHERE id = ?`).bind(spotId).run();
  }

  async getNextPendingSpot(tripId: number): Promise<ItinerarySpot | null> {
    return this.db.prepare(
      `SELECT * FROM itinerary_spots WHERE trip_id = ? AND status = 'pending' ORDER BY day ASC, sort_order ASC LIMIT 1`
    ).bind(tripId).first<ItinerarySpot>();
  }

  async deleteSpot(spotId: number): Promise<void> {
    await this.db.prepare(`DELETE FROM itinerary_spots WHERE id = ?`).bind(spotId).run();
  }

  // ─── Shopping ────────────────────────────────────────────────────────────────

  async addShoppingItem(tripId: number, assignee: string, item: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO shopping_items (trip_id, assignee, item) VALUES (?, ?, ?)`
    ).bind(tripId, assignee, item).run();
  }

  async getShoppingItems(tripId: number): Promise<ShoppingItem[]> {
    const res = await this.db.prepare(
      `SELECT * FROM shopping_items WHERE trip_id = ? ORDER BY is_bought ASC, created_at ASC`
    ).bind(tripId).all<ShoppingItem>();
    return res.results || [];
  }

  async markItemBought(itemId: number): Promise<void> {
    await this.db.prepare(`UPDATE shopping_items SET is_bought = 1 WHERE id = ?`).bind(itemId).run();
  }

  async deleteShoppingItem(itemId: number): Promise<void> {
    await this.db.prepare(`DELETE FROM shopping_items WHERE id = ?`).bind(itemId).run();
  }
}
