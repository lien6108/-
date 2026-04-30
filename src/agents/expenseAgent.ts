import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';
import { getStandardQuickReply, createExpenseListFlex, createExpenseSuccessFlex, createMyAccountFlex } from '../utils/ui';

function nowTag(): string {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc8.getUTCDate()).padStart(2, '0');
  const h = String(utc8.getUTCHours()).padStart(2, '0');
  const mm = String(utc8.getUTCMinutes()).padStart(2, '0');
  return `${m}${d} ${h}:${mm}`;
}

function formatDbTs(dbTs: string): string {
  const date = new Date(dbTs.includes('Z') || dbTs.includes('+') ? dbTs : `${dbTs} Z`);
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc8.getUTCDate()).padStart(2, '0');
  const h = String(utc8.getUTCHours()).padStart(2, '0');
  const mm = String(utc8.getUTCMinutes()).padStart(2, '0');
  return `${m}/${d} ${h}:${mm}`;
}

function pad(v: string, len: number): string {
  const s = v.length > len ? `${v.slice(0, Math.max(0, len - 1))}…` : v;
  return s.padEnd(len, ' ');
}

export class ExpenseAgent {
  private crud: CRUD;

  constructor(crud: CRUD) {
    this.crud = crud;
  }

  private async resolveParticipants(groupId: string, names: string[], mentionMap: Record<string, string>) {
    const all = await this.crud.getAllMembers(groupId);
    const userIds: string[] = [];
    const missing: string[] = [];

    for (const name of names) {
      // 先查 mentionMap（LINE @mention 已被 lineHandler 替換為 safeMention）
      const byMention = mentionMap[name] || mentionMap[`@${name}`];
      if (byMention) {
        userIds.push(byMention);
        continue;
      }
      // 去掉 @ 前綴再做顯示名稱比對
      const cleanName = name.startsWith('@') ? name.slice(1) : name;
      const m = all.find(x => x.display_name.toLowerCase() === cleanName.toLowerCase());
      if (m) userIds.push(m.user_id);
      else missing.push(name);
    }

    return { userIds: Array.from(new Set(userIds)), missing };
  }

  private getExpenseQuickReply(groupSeq: number): messagingApi.QuickReply {
    return getStandardQuickReply({ groupSeq });
  }

  async addExpense(
    groupId: string,
    payerUserId: string,
    payerName: string,
    description: string,
    amount: number,
    specificParticipants?: string[],
    currency = 'TWD',
    originalAmount?: number,
    mentionMap: Record<string, string> = {},
    providedSpecificUserIds?: string[]
  ): Promise<string | messagingApi.Message> {
    if (amount <= 0) return '金額必須大於 0。';

    const participants = await this.crud.getParticipatingMembers(groupId);
    if (participants.length === 0) return '目前沒有參與分帳成員，請先加入。';

    let specificUserIds = providedSpecificUserIds || [];
    if (!providedSpecificUserIds && specificParticipants && specificParticipants.length > 0) {
      const { userIds, missing } = await this.resolveParticipants(groupId, specificParticipants, mentionMap);
      if (missing.length > 0) return `旺？找不到這些夥伴：${missing.join('、')}，確認名稱對不對呦！`;
      specificUserIds = userIds;
    }

    const exp = await this.crud.createExpense(groupId, payerUserId, payerName, description, amount, specificUserIds, currency, originalAmount);
    const splits = await this.crud.getExpenseSplits(exp.id);

    return createExpenseSuccessFlex(exp, splits);
  }

  async addMultipleExpenses(
    groupId: string,
    payerUserId: string,
    payerName: string,
    items: { description: string; amount: number; participants?: string[]; currency?: string; originalAmount?: number }[],
    mentionMap: Record<string, string> = {}
  ): Promise<string | messagingApi.Message> {
    const valid = items.filter(i => i.amount > 0);
    if (valid.length === 0) return '找不到有效的記帳內容耶～';

    const rows: string[] = [];
    let total = 0;
    let lastSeq = 0;

    for (const item of valid) {
      let userIds: string[] | undefined;
      if (item.participants && item.participants.length > 0) {
        const resolved = await this.resolveParticipants(groupId, item.participants, mentionMap);
        if (resolved.missing.length > 0) return `旺？找不到這些夥伴：${resolved.missing.join('、')}，確認名稱對不對呦！`;
        userIds = resolved.userIds;
      }
      const exp = await this.crud.createExpense(
        groupId,
        payerUserId,
        payerName,
        item.description || '記帳',
        item.amount,
        userIds,
        item.currency || 'TWD',
        item.originalAmount
      );
      total += exp.amount;
      lastSeq = exp.group_seq;
      rows.push(`#${exp.group_seq} ${exp.description} ${exp.amount}`);
    }

    return {
      type: 'text',
      text: `🐾 已新增 ${valid.length} 筆記帳\n${rows.join('\n')}\n合計：TWD ${Math.round(total * 100) / 100}`,
      quickReply: getStandardQuickReply({ groupSeq: lastSeq })
    };
  }

  async deleteExpense(groupId: string, groupSeq: number, requestName: string): Promise<string | messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) return `旺？找不到 #${groupSeq} 喔！`;

    await this.crud.deleteExpense(expense.id);
    return {
      type: 'text',
      text: `🐾 ${requestName} 已刪除 #${groupSeq}（${expense.description} / ${expense.amount}）`,
      quickReply: getStandardQuickReply()
    };
  }

  async listExpenses(groupId: string): Promise<string | messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return '目前都很輕鬆，沒有未結算的帳唷！旺～';

    let total = 0;
    for (const exp of expenses) {
      total += exp.amount;
    }

    const flex = createExpenseListFlex(expenses, total);
    return flex;
  }

  async showMyAccount(groupId: string, userId: string, userName: string): Promise<string | messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return '目前都很輕鬆，沒有未結算的帳唷！旺～';

    const { transactions } = await this.crud.calculateSettlement(groupId);

    // 我需要轉帳給誰
    const myPayments = transactions.filter(t => t.from === userId);

    // 我代墊的帳（我是付款人，但有其他人需要分攤）
    const paidItems: { seq: number; description: string; amount: number; currency?: string; original_amount?: number; others: { debtor_name: string; share_amount: number }[] }[] = [];
    // 我需要分攤的帳（我是 debtor，付款人是別人）
    const splitItems: { seq: number; description: string; payer_name: string; myShare: number }[] = [];

    for (const exp of expenses) {
      const splits = await this.crud.getExpenseSplits(exp.id);
      if (exp.payer_user_id === userId) {
        // 我付的，看有沒有其他人要還我
        const others = splits.filter(s => s.debtor_user_id !== userId);
        if (others.length > 0) {
          paidItems.push({
            seq: exp.group_seq,
            description: exp.description,
            amount: exp.amount,
            currency: exp.currency,
            original_amount: exp.original_amount,
            others
          });
        }
      } else {
        // 別人付的，看我有沒有分攤
        const myPart = splits.find(s => s.debtor_user_id === userId);
        if (myPart) {
          splitItems.push({
            seq: exp.group_seq,
            description: exp.description,
            payer_name: exp.payer_name,
            myShare: myPart.share_amount
          });
        }
      }
    }

    return createMyAccountFlex(userName, myPayments, paidItems, splitItems);
  }

  async updateExpense(groupId: string, groupSeq: number, newAmount: number, requestName: string): Promise<string | messagingApi.Message> {
    if (newAmount <= 0) return '金額必須大於 0 喔～';

    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) return `旺？找不到 #${groupSeq} 喔！`;

    let twd = newAmount;
    let original: number | null = null;
    if (expense.currency && expense.currency !== 'TWD') {
      const rate = await this.crud.getExchangeRate(expense.currency);
      if (rate) {
        original = newAmount;
        twd = Math.round(newAmount * rate * 100) / 100;
      }
    }

    const exp = await this.crud.updateExpenseAmount(expense.id, twd, original);
    if (!exp) return '修改失敗了，請再試一次～';
    await this.crud.recalcSplitAmounts(exp.id);
    const splits = await this.crud.getExpenseSplits(exp.id);
    const share = splits.length ? splits[0].share_amount : 0;

    const amountDisplay = exp.currency && exp.currency !== 'TWD' && exp.original_amount
      ? `${exp.currency} ${exp.original_amount}（台幣 ${exp.amount}）`
      : `TWD ${exp.amount}`;

    return {
      type: 'text',
      text: `🐾 ${requestName} 已修改 #${groupSeq}！\n金額：${amountDisplay}\n分攤：${splits.length} 人，每人 ${share}`,
      quickReply: this.getExpenseQuickReply(groupSeq)
    };
  }

  async updateExpenseCurrency(groupId: string, groupSeq: number, newCurrency: string, requestName: string): Promise<string | messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) return `旺？找不到 #${groupSeq} 喔！`;

    let rate: number | null = null;
    if (newCurrency !== 'TWD') {
      rate = await this.crud.getExchangeRate(newCurrency);
      if (!rate) return `旺？目前沒有 ${newCurrency} 的匯率，請稍後再試！`;
    }

    const exp = await this.crud.updateExpenseCurrency(expense.id, newCurrency, rate);
    if (!exp) return '修改失敗了，請再試一次～';
    await this.crud.recalcSplitAmounts(exp.id);
    const splits = await this.crud.getExpenseSplits(exp.id);
    const share = splits.length ? splits[0].share_amount : 0;

    const amountInfo = exp.currency && exp.currency !== 'TWD' && exp.original_amount
      ? `${exp.currency} ${exp.original_amount} (約 TWD ${exp.amount})`
      : `TWD ${exp.amount}`;

    return {
      type: 'text',
      text: `🐾 ${requestName} 已修改 #${groupSeq} 幣別！\n金額：${amountInfo}\n分攤：${splits.length} 人，每人 ${share}`,
      quickReply: this.getExpenseQuickReply(groupSeq)
    };
  }

  async addExpenseOnBehalf(
    groupId: string,
    recorderUserId: string,
    recorderName: string,
    payerDisplayName: string,
    description: string,
    amount: number,
    specificParticipants?: string[],
    currency = 'TWD',
    originalAmount?: number,
    mentionMap: Record<string, string> = {},
    providedSpecificUserIds?: string[]
  ): Promise<string | messagingApi.Message> {
    if (amount <= 0) return '金額必須大於 0 喔～';

    let payer = null;
    const mapped = mentionMap[payerDisplayName] || mentionMap[`@${payerDisplayName}`];
    if (mapped) payer = await this.crud.getMember(groupId, mapped);
    if (!payer) payer = await this.crud.getMemberByDisplayName(groupId, payerDisplayName);
    if (!payer) return `旺？找不到付款人「${payerDisplayName}」，確認名稱對不對呦！`;
    if (payer.is_participating !== 1) return `${payer.display_name} 還沒加入分帳喔！`;

    let specificIds = providedSpecificUserIds || [];
    if (!providedSpecificUserIds && specificParticipants && specificParticipants.length > 0) {
      const resolved = await this.resolveParticipants(groupId, specificParticipants, mentionMap);
      if (resolved.missing.length > 0) return `找不到成員：${resolved.missing.join('、')}`;
      specificIds = resolved.userIds;
    }

    const exp = await this.crud.createExpense(
      groupId,
      payer.user_id,
      payer.display_name,
      description,
      amount,
      specificIds,
      currency,
      originalAmount
    );

    return {
      type: 'text',
      text: `已代墊記帳\n題號：#${exp.group_seq}\n付款人：${payer.display_name}\n紀錄者：${recorderName}\n項目：${description}\n金額：${exp.amount}`,
      quickReply: this.getExpenseQuickReply(exp.group_seq)
    };
  }

  async showExpenseSplitDetail(groupId: string, groupSeq: number): Promise<string | messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) return `找不到 #${groupSeq}。`;

    const splits = await this.crud.getExpenseSplits(expense.id);
    const members = splits.map(s => `- ${s.debtor_name}`).join('\n');
    const share = splits.length ? splits[0].share_amount : 0;

    return {
      type: 'text',
      text: `#${groupSeq} ${expense.description}\n付款：${expense.payer_name}\n分攤成員：\n${members}\n每人：${share}`,
      quickReply: this.getExpenseQuickReply(groupSeq)
    };
  }

  async addSplitMembers(groupId: string, groupSeq: number, names: string[], requesterName: string, mentionMap: Record<string, string> = {}): Promise<string | messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) return `找不到 #${groupSeq}。`;

    const resolved = await this.resolveParticipants(groupId, names, mentionMap);
    if (resolved.missing.length > 0) return `找不到成員：${resolved.missing.join('、')}`;

    const allMembers = await this.crud.getAllMembers(groupId);
    const debtors = resolved.userIds.map(uid => {
      const m = allMembers.find(v => v.user_id === uid)!;
      return { userId: uid, name: m.display_name };
    });
    const added = await this.crud.addExpenseSplits(expense.id, debtors);
    if (added.length === 0) return '選定成員已在分攤名單中。';

    const splits = await this.crud.getExpenseSplits(expense.id);
    const share = splits.length ? splits[0].share_amount : 0;
    return {
      type: 'text',
      text: `${requesterName} 已新增：${added.join('、')}\n目前 ${splits.length} 人分攤，每人 ${share}`,
      quickReply: this.getExpenseQuickReply(groupSeq)
    };
  }

  async removeSplitMembers(groupId: string, groupSeq: number, names: string[], requesterName: string, mentionMap: Record<string, string> = {}): Promise<string | messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) return `找不到 #${groupSeq}。`;

    const resolved = await this.resolveParticipants(groupId, names, mentionMap);
    if (resolved.missing.length > 0) return `找不到成員：${resolved.missing.join('、')}`;

    const removed = await this.crud.removeExpenseSplits(expense.id, resolved.userIds);
    if (removed.length === 0) return '選定成員不在分攤名單中。';

    const splits = await this.crud.getExpenseSplits(expense.id);
    if (splits.length === 0) return '警告：目前沒有任何分攤成員，請盡快補上。';
    const share = splits[0].share_amount;

    return {
      type: 'text',
      text: `${requesterName} 已移除：${removed.join('、')}\n目前 ${splits.length} 人分攤，每人 ${share}`,
      quickReply: this.getExpenseQuickReply(groupSeq)
    };
  }

  async showGroupExchangeRates(groupId: string): Promise<string> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    const currencies = new Set<string>();
    for (const exp of expenses) {
      if (exp.currency && exp.currency !== 'TWD') currencies.add(exp.currency);
    }

    if (currencies.size === 0) return '目前沒有外幣記帳。';

    let msg = '本單外幣匯率（對 TWD）\n';
    for (const currency of currencies) {
      const rate = await this.crud.getExchangeRate(currency);
      msg += rate ? `1 ${currency} = ${rate} TWD\n` : `1 ${currency} = (尚無匯率)\n`;
    }
    return msg;
  }
}
