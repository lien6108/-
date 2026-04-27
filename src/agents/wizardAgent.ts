import { messagingApi } from '@line/bot-sdk';
import { CRUD, Session } from '../db/crud';
import { ExpenseAgent } from './expenseAgent';
import { resolveCurrency } from '../utils/currency';

export enum WizardStep {
  AWAITING_TRIP_NAME = 'AWAITING_TRIP_NAME',
  AWAITING_FEEDBACK = 'AWAITING_FEEDBACK',
  AWAITING_CURRENCY = 'AWAITING_CURRENCY',
  AWAITING_AMOUNT = 'AWAITING_AMOUNT',
  AWAITING_DESC = 'AWAITING_DESC',
  AWAITING_PAYER = 'AWAITING_PAYER',
  AWAITING_SHARERS = 'AWAITING_SHARERS',
  AWAITING_CONFIRM = 'AWAITING_CONFIRM',
  MODIFY_SPLIT_MODE = 'MODIFY_SPLIT_MODE',
  MODIFY_SPLIT_MEMBER = 'MODIFY_SPLIT_MEMBER',
  AWAITING_EXPENSE_TO_DELETE = 'AWAITING_EXPENSE_TO_DELETE',
  AWAITING_DELETE_CONFIRM = 'AWAITING_DELETE_CONFIRM',
  AWAITING_EXPENSE_TO_MODIFY = 'AWAITING_EXPENSE_TO_MODIFY',
  AWAITING_MODIFY_TYPE = 'AWAITING_MODIFY_TYPE',
  AWAITING_NEW_CURRENCY = 'AWAITING_NEW_CURRENCY',
}

interface WizardData {
  groupSeq?: number;
  modifyMode?: 'ADD' | 'REMOVE';
  currency?: string;
  amount?: number;
  description?: string;
  payerUserId?: string;
  payerName?: string;
  sharerUserIds?: string[];
  sharerNames?: string[];
}

const CANCEL = '取消';

export class WizardAgent {
  private crud: CRUD;
  private expenseAgent: ExpenseAgent;

  constructor(crud: CRUD, expenseAgent: ExpenseAgent) {
    this.crud = crud;
    this.expenseAgent = expenseAgent;
  }

  async start(groupId: string, userId: string): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_CURRENCY, JSON.stringify({}));
    return this.currencyPrompt();
  }

  async startTripNaming(groupId: string, userId: string): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_TRIP_NAME, JSON.stringify({}));
    return {
      type: 'text',
      text: '歡迎使用分帳神器，請先回覆：這趟旅遊名稱是「XXX」',
      quickReply: { items: [this.qr(CANCEL, CANCEL)] }
    };
  }

  async startFeedback(groupId: string, userId: string): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_FEEDBACK, JSON.stringify({}));
    return {
      type: 'text',
      text: '請直接輸入你想回饋的內容（下一則訊息會直接送出）。',
      quickReply: { items: [this.qr(CANCEL, CANCEL)] }
    };
  }

  async startModifySplit(groupId: string, userId: string, groupSeq: number): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, WizardStep.MODIFY_SPLIT_MODE, JSON.stringify({ groupSeq }));
    return {
      type: 'text',
      text: `修改 #${groupSeq} 分攤成員：請選擇新增或移除。`,
      quickReply: {
        items: [
          this.qr('新增成員', '新增成員'),
          this.qr('移除成員', '移除成員'),
          this.qr(CANCEL, CANCEL),
        ]
      }
    };
  }

  async startDeleteWizard(groupId: string, userId: string, providedGroupSeq?: number): Promise<messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return { type: 'text', text: '目前沒有未結算的記帳。' };

    if (providedGroupSeq) {
      return this.toDeleteConfirm(groupId, userId, providedGroupSeq);
    }

    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_DELETE, JSON.stringify({}));
    return this.chooseExpensePrompt('請選擇要刪除的題號，或輸入 #題號。', expenses, true);
  }

  async startModifyWizard(groupId: string, userId: string): Promise<messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return { type: 'text', text: '目前沒有未結算的記帳。' };

    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_MODIFY, JSON.stringify({}));
    return this.chooseExpensePrompt('請選擇要修改的題號，或輸入 #題號。', expenses, false);
  }

  async handleNext(session: Session, text: string, displayName: string): Promise<string | messagingApi.Message> {
    const data: WizardData = JSON.parse(session.data || '{}');
    const step = session.step as WizardStep;
    const input = text.trim();

    if (input === CANCEL) {
      await this.crud.deleteSession(session.user_id);
      return '已取消本次操作。';
    }

    switch (step) {
      case WizardStep.AWAITING_TRIP_NAME: {
        const name = input.trim();
        if (!name || name.length > 40) {
          return {
            type: 'text',
            text: '旅遊名稱不可空白，且長度請在 40 字以內。',
            quickReply: { items: [this.qr(CANCEL, CANCEL)] }
          };
        }
        await this.crud.startNewTrip(session.group_id, name);
        await this.crud.deleteSession(session.user_id);
        return `已建立本單名稱：${name}\n現在可以開始記帳。`;
      }

      case WizardStep.AWAITING_FEEDBACK: {
        if (!input) {
          return {
            type: 'text',
            text: '回饋內容不可空白，請重新輸入。',
            quickReply: { items: [this.qr(CANCEL, CANCEL)] }
          };
        }
        await this.crud.deleteSession(session.user_id);
        return `[FEEDBACK]${input}`;
      }

      case WizardStep.AWAITING_CURRENCY: {
        const currency = resolveCurrency(input);
        if (!currency) return this.currencyPrompt('幣別無法辨識，請重新選擇或輸入 ISO 代碼（如 USD）。');

        data.currency = currency;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_AMOUNT, JSON.stringify(data));
        return {
          type: 'text',
          text: `幣別：${currency}\n請輸入金額。`,
          quickReply: { items: [this.qr('100', '100'), this.qr('500', '500'), this.qr('1000', '1000'), this.qr(CANCEL, CANCEL)] }
        };
      }

      case WizardStep.AWAITING_AMOUNT: {
        const amount = parseFloat(input.replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) {
          return {
            type: 'text',
            text: '金額格式錯誤，請輸入大於 0 的數字。',
            quickReply: { items: [this.qr('100', '100'), this.qr('500', '500'), this.qr('1000', '1000'), this.qr(CANCEL, CANCEL)] }
          };
        }
        data.amount = amount;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_DESC, JSON.stringify(data));
        return {
          type: 'text',
          text: '請輸入記帳項目描述。',
          quickReply: { items: [this.qr(CANCEL, CANCEL)] }
        };
      }

      case WizardStep.AWAITING_DESC: {
        if (!input) {
          return {
            type: 'text',
            text: '描述不可空白，請重新輸入。',
            quickReply: { items: [this.qr(CANCEL, CANCEL)] }
          };
        }
        data.description = input;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_PAYER, JSON.stringify(data));
        return this.payerPrompt(session.group_id, '請選擇付款人。');
      }

      case WizardStep.AWAITING_PAYER: {
        const member = await this.crud.getMemberByDisplayName(session.group_id, input);
        if (!member) return this.payerPrompt(session.group_id, `找不到「${input}」，請從快捷選擇付款人。`);

        data.payerUserId = member.user_id;
        data.payerName = member.display_name;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_SHARERS, JSON.stringify(data));
        return this.sharerPrompt('請選擇分攤方式：全部分攤 / 不含付款人 / 指定成員（可多次點選）。', session.group_id, data);
      }

      case WizardStep.AWAITING_SHARERS: {
        if (input === '全部分攤') {
          data.sharerUserIds = [];
          data.sharerNames = ['全部分攤'];
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_CONFIRM, JSON.stringify(data));
          return this.showFinalConfirm(data);
        }

        if (input === '不含付款人') {
          const members = await this.crud.getParticipatingMembers(session.group_id);
          const others = members.filter(m => m.user_id !== data.payerUserId);
          if (others.length === 0) {
            return this.sharerPrompt('沒有可分攤成員，請改選全部分攤或指定其他人。', session.group_id, data);
          }
          data.sharerUserIds = others.map(m => m.user_id);
          data.sharerNames = others.map(m => m.display_name);
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_CONFIRM, JSON.stringify(data));
          return this.showFinalConfirm(data);
        }

        if (input === '完成指定') {
          if (!data.sharerUserIds || data.sharerUserIds.length === 0) {
            return this.sharerPrompt('你尚未指定任何分攤成員，請先點選成員。', session.group_id, data);
          }
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_CONFIRM, JSON.stringify(data));
          return this.showFinalConfirm(data);
        }

        const member = await this.crud.getMemberByDisplayName(session.group_id, input);
        if (!member) {
          return this.sharerPrompt(`找不到「${input}」，請從快捷選擇。`, session.group_id, data);
        }

        data.sharerUserIds = data.sharerUserIds || [];
        data.sharerNames = data.sharerNames || [];
        if (!data.sharerUserIds.includes(member.user_id)) {
          data.sharerUserIds.push(member.user_id);
          data.sharerNames.push(member.display_name);
        }
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_SHARERS, JSON.stringify(data));
        return this.sharerPrompt(`已選擇：${data.sharerNames.join('、')}`, session.group_id, data);
      }

      case WizardStep.AWAITING_CONFIRM: {
        if (input !== '確認送出') {
          return {
            type: 'text',
            text: '請點擊「確認送出」或「取消」。',
            quickReply: { items: [this.qr('確認送出', '確認送出'), this.qr(CANCEL, CANCEL)] }
          };
        }

        await this.crud.deleteSession(session.user_id);
        let amountTwd = data.amount!;
        let originalAmount: number | undefined;

        if (data.currency && data.currency !== 'TWD') {
          const rate = await this.crud.getExchangeRate(data.currency);
          if (rate) {
            originalAmount = data.amount;
            amountTwd = Math.round(data.amount! * rate * 100) / 100;
          }
        }

        const providedIds = (data.sharerUserIds && data.sharerUserIds.length > 0) ? data.sharerUserIds : undefined;
        return this.expenseAgent.addExpense(
          session.group_id,
          data.payerUserId!,
          data.payerName!,
          data.description!,
          amountTwd,
          undefined,
          data.currency || 'TWD',
          originalAmount,
          {},
          providedIds
        );
      }

      case WizardStep.MODIFY_SPLIT_MODE: {
        const mode = input === '新增成員' ? 'ADD' : input === '移除成員' ? 'REMOVE' : null;
        if (!mode) {
          return {
            type: 'text',
            text: '請選擇新增成員或移除成員。',
            quickReply: { items: [this.qr('新增成員', '新增成員'), this.qr('移除成員', '移除成員'), this.qr(CANCEL, CANCEL)] }
          };
        }

        data.modifyMode = mode;
        data.sharerUserIds = [];
        data.sharerNames = [];
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.MODIFY_SPLIT_MEMBER, JSON.stringify(data));
        return this.memberPickPrompt(session.group_id, `請選擇要${mode === 'ADD' ? '新增' : '移除'}的成員（可多次點選），完成後按「完成指定」。`, true);
      }

      case WizardStep.MODIFY_SPLIT_MEMBER: {
        if (input === '完成指定') {
          if (!data.sharerNames || data.sharerNames.length === 0) {
            return this.memberPickPrompt(session.group_id, '尚未選擇任何成員，請先點選。', true);
          }
          const groupSeq = data.groupSeq!;
          const names = data.sharerNames;
          await this.crud.deleteSession(session.user_id);

          if (data.modifyMode === 'ADD') {
            return this.expenseAgent.addSplitMembers(session.group_id, groupSeq, names, displayName);
          }
          return this.expenseAgent.removeSplitMembers(session.group_id, groupSeq, names, displayName);
        }

        const member = await this.crud.getMemberByDisplayName(session.group_id, input);
        if (!member) {
          return this.memberPickPrompt(session.group_id, `找不到「${input}」，請從快捷選擇。`, true);
        }

        data.sharerUserIds = data.sharerUserIds || [];
        data.sharerNames = data.sharerNames || [];
        if (!data.sharerUserIds.includes(member.user_id)) {
          data.sharerUserIds.push(member.user_id);
          data.sharerNames.push(member.display_name);
        }
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.MODIFY_SPLIT_MEMBER, JSON.stringify(data));
        return this.memberPickPrompt(session.group_id, `已選擇：${data.sharerNames.join('、')}`, true);
      }

      case WizardStep.AWAITING_EXPENSE_TO_DELETE: {
        const match = input.match(/#(\d+)/);
        if (!match) {
          const expenses = await this.crud.getUnsettledExpenses(session.group_id);
          return this.chooseExpensePrompt('格式錯誤，請選擇快捷或輸入 #題號。', expenses, true);
        }
        return this.toDeleteConfirm(session.group_id, session.user_id, parseInt(match[1], 10));
      }

      case WizardStep.AWAITING_DELETE_CONFIRM: {
        if (input !== '確認刪除') {
          return {
            type: 'text',
            text: '請點擊「確認刪除」或「取消」。',
            quickReply: { items: [this.qr('確認刪除', '確認刪除'), this.qr(CANCEL, CANCEL)] }
          };
        }
        const groupSeq = data.groupSeq!;
        await this.crud.deleteSession(session.user_id);
        return this.expenseAgent.deleteExpense(session.group_id, groupSeq, displayName);
      }

      case WizardStep.AWAITING_EXPENSE_TO_MODIFY: {
        const match = input.match(/#(\d+)/);
        if (!match) {
          const expenses = await this.crud.getUnsettledExpenses(session.group_id);
          return this.chooseExpensePrompt('格式錯誤，請選擇快捷或輸入 #題號。', expenses, false);
        }
        const groupSeq = parseInt(match[1], 10);
        const expense = await this.crud.getExpenseByGroupSeq(session.group_id, groupSeq);
        if (!expense) {
          const expenses = await this.crud.getUnsettledExpenses(session.group_id);
          return this.chooseExpensePrompt(`找不到 #${groupSeq}，請重新選擇。`, expenses, false);
        }
        data.groupSeq = groupSeq;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_MODIFY_TYPE, JSON.stringify(data));
        return {
          type: 'text',
          text: `已選擇 #${groupSeq}，請選擇要修改的項目。`,
          quickReply: {
            items: [
              this.qr('修改金額', '修改金額'),
              this.qr('修改幣別', '修改幣別'),
              this.qr('修改分攤', '修改分攤'),
              this.qr(CANCEL, CANCEL),
            ]
          }
        };
      }

      case WizardStep.AWAITING_MODIFY_TYPE: {
        const groupSeq = data.groupSeq!;
        if (input === '修改金額') {
          await this.crud.deleteSession(session.user_id);
          return {
            type: 'text',
            text: `請輸入：修改金額 #${groupSeq} 500`,
            quickReply: { items: [this.qr(`修改金額 #${groupSeq} 100`, `修改金額 #${groupSeq} 100`), this.qr(`修改金額 #${groupSeq} 500`, `修改金額 #${groupSeq} 500`), this.qr(CANCEL, CANCEL)] }
          };
        }
        if (input === '修改幣別') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_NEW_CURRENCY, JSON.stringify(data));
          return this.currencyPrompt(`請輸入 #${groupSeq} 的新幣別。`);
        }
        if (input === '修改分攤') {
          return this.startModifySplit(session.group_id, session.user_id, groupSeq);
        }
        return {
          type: 'text',
          text: '請從快捷選擇修改項目。',
          quickReply: { items: [this.qr('修改金額', '修改金額'), this.qr('修改幣別', '修改幣別'), this.qr('修改分攤', '修改分攤'), this.qr(CANCEL, CANCEL)] }
        };
      }

      case WizardStep.AWAITING_NEW_CURRENCY: {
        const groupSeq = data.groupSeq!;
        const currency = resolveCurrency(input);
        if (!currency) {
          return this.currencyPrompt(`幣別輸入錯誤，請重新輸入 #${groupSeq} 的新幣別。`);
        }
        await this.crud.deleteSession(session.user_id);
        return this.expenseAgent.updateExpenseCurrency(session.group_id, groupSeq, currency, displayName);
      }

      default:
        await this.crud.deleteSession(session.user_id);
        return '流程已重置，請重新操作。';
    }
  }

  private qr(label: string, text: string): messagingApi.QuickReplyItem {
    return { type: 'action', action: { type: 'message', label, text } };
  }

  private currencyPrompt(hint?: string): messagingApi.Message {
    return {
      type: 'text',
      text: hint || '請選擇或輸入幣別（例如：TWD、USD、JPY、日本、日幣）。',
      quickReply: {
        items: [
          this.qr('台幣 TWD', 'TWD'),
          this.qr('美元 USD', 'USD'),
          this.qr('日圓 JPY', 'JPY'),
          this.qr('韓元 KRW', 'KRW'),
          this.qr(CANCEL, CANCEL),
        ]
      }
    };
  }

  private async payerPrompt(groupId: string, text: string): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const items = members.slice(0, 10).map(m => this.qr(m.display_name, m.display_name));
    items.push(this.qr(CANCEL, CANCEL));
    return { type: 'text', text, quickReply: { items } };
  }

  private async sharerPrompt(text: string, groupId: string, data: WizardData): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const items = [
      this.qr('全部分攤', '全部分攤'),
      this.qr('不含付款人', '不含付款人'),
      ...members.slice(0, 8).map(m => this.qr(m.display_name, m.display_name)),
      this.qr('完成指定', '完成指定'),
      this.qr(CANCEL, CANCEL),
    ].slice(0, 13);

    const selected = data.sharerNames && data.sharerNames.length > 0 ? `\n目前指定：${data.sharerNames.join('、')}` : '';
    return { type: 'text', text: `${text}${selected}`, quickReply: { items } };
  }

  private async memberPickPrompt(groupId: string, text: string, showDone: boolean): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const items = [...members.slice(0, 10).map(m => this.qr(m.display_name, m.display_name))];
    if (showDone) items.push(this.qr('完成指定', '完成指定'));
    items.push(this.qr(CANCEL, CANCEL));
    return { type: 'text', text, quickReply: { items: items.slice(0, 13) } };
  }

  private async chooseExpensePrompt(title: string, expenses: Array<{ group_seq: number; description: string }>, forDelete: boolean): Promise<messagingApi.Message> {
    const items = expenses.slice(0, 10).map(exp => this.qr(`#${exp.group_seq} ${exp.description}`, `#${exp.group_seq}`));
    items.push(this.qr(CANCEL, CANCEL));
    return {
      type: 'text',
      text: `${title}\n提示：可直接輸入 #題號。`,
      quickReply: { items }
    };
  }

  private async toDeleteConfirm(groupId: string, userId: string, groupSeq: number): Promise<messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, groupSeq);
    if (!expense) {
      const expenses = await this.crud.getUnsettledExpenses(groupId);
      return this.chooseExpensePrompt(`找不到 #${groupSeq}，請重新選擇。`, expenses, true);
    }

    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_DELETE_CONFIRM, JSON.stringify({ groupSeq }));
    return {
      type: 'text',
      text: `確認刪除 #${groupSeq}？\n項目：${expense.description}\n金額：${expense.amount}`,
      quickReply: { items: [this.qr('確認刪除', '確認刪除'), this.qr(CANCEL, CANCEL)] }
    };
  }

  private async showFinalConfirm(data: WizardData): Promise<messagingApi.Message> {
    const sharerText = (data.sharerNames && data.sharerNames.length > 0) ? data.sharerNames.join('、') : '全部分攤';
    let amountText = `${data.currency || 'TWD'} ${data.amount}`;
    if (data.currency && data.currency !== 'TWD') {
      const rate = await this.crud.getExchangeRate(data.currency);
      if (rate) {
        const twd = Math.round((data.amount || 0) * rate * 100) / 100;
        amountText += ` (約 TWD ${twd})`;
      }
    }
    return {
      type: 'text',
      text: `請確認以下內容：\n項目：${data.description}\n金額：${amountText}\n付款人：${data.payerName}\n分攤：${sharerText}`,
      quickReply: { items: [this.qr('確認送出', '確認送出'), this.qr(CANCEL, CANCEL)] }
    };
  }
}
