import { messagingApi } from '@line/bot-sdk';
import { CRUD, Session } from '../db/crud';
import { ExpenseAgent } from './expenseAgent';
import { resolveCurrency } from '../utils/currency';
import { getStandardQuickReply } from '../utils/ui';

export enum WizardStep {
  AWAITING_TRIP_NAME = 'AWAITING_TRIP_NAME',
  AWAITING_FEEDBACK = 'AWAITING_FEEDBACK',
  AWAITING_EXPENSE_DRAFT_MENU = 'AWAITING_EXPENSE_DRAFT_MENU',
  AWAITING_EXPENSE_DRAFT_CURRENCY = 'AWAITING_EXPENSE_DRAFT_CURRENCY',
  AWAITING_EXPENSE_DRAFT_AMOUNT = 'AWAITING_EXPENSE_DRAFT_AMOUNT',
  AWAITING_EXPENSE_DRAFT_DESC = 'AWAITING_EXPENSE_DRAFT_DESC',
  AWAITING_EXPENSE_DRAFT_PAYER = 'AWAITING_EXPENSE_DRAFT_PAYER',
  AWAITING_EXPENSE_DRAFT_SPLIT_MODE = 'AWAITING_EXPENSE_DRAFT_SPLIT_MODE',
  AWAITING_EXPENSE_DRAFT_SPLIT_CUSTOM = 'AWAITING_EXPENSE_DRAFT_SPLIT_CUSTOM',
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
  sharerMode?: 'ALL' | 'EXCLUDE_PAYER' | 'CUSTOM';
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
    const me = await this.crud.getMember(groupId, userId);
    const draft: WizardData = {
      currency: 'TWD',
      sharerMode: 'ALL',
      payerUserId: me?.user_id,
      payerName: me?.display_name,
    };
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(draft));
    return this.draftMenuPrompt(draft, '請用下方選項操作。只有「項目」通常需要手動輸入。');
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

    if (providedGroupSeq) return this.toDeleteConfirm(groupId, userId, providedGroupSeq);

    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_DELETE, JSON.stringify({}));
    return this.chooseExpensePrompt('請選擇要刪除的題號，或輸入 #題號。', expenses);
  }

  async startModifyWizard(groupId: string, userId: string): Promise<messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return { type: 'text', text: '目前沒有未結算的記帳。' };

    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_MODIFY, JSON.stringify({}));
    return this.chooseExpensePrompt('請選擇要修改的題號，或輸入 #題號。', expenses);
  }

  async handleNext(session: Session, text: string, displayName: string): Promise<string | messagingApi.Message | null> {
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
        return {
          type: 'text',
          text: `已建立本單名稱：${name}\n現在可以開始記帳。`,
          quickReply: getStandardQuickReply()
        };
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
        return {
          type: 'text',
          text: `[FEEDBACK]${input}`,
          quickReply: getStandardQuickReply()
        };
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_MENU: {
        if (input === '查看草稿') return this.showDraft(data);
        if (input === '設定幣別') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_CURRENCY, JSON.stringify(data));
          return this.draftCurrencyPrompt();
        }
        if (input === '設定金額') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_AMOUNT, JSON.stringify(data));
          return this.draftAmountPrompt();
        }
        if (input === '設定項目') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_DESC, JSON.stringify(data));
          return {
            type: 'text',
            text: '請輸入項目內容（例如：晚餐、車資）。',
            quickReply: { items: [this.qr('返回選單', '返回選單'), this.qr(CANCEL, CANCEL)] }
          };
        }
        if (input === '設定付款人') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_PAYER, JSON.stringify(data));
          return this.draftPayerPrompt(session.group_id);
        }
        if (input === '設定分攤') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_SPLIT_MODE, JSON.stringify(data));
          return this.draftSplitModePrompt();
        }
        if (input === '確認送出') {
          const missing: string[] = [];
          if (!data.currency) missing.push('幣別');
          if (!data.amount) missing.push('金額');
          if (!data.description) missing.push('項目');
          if (!data.payerUserId || !data.payerName) missing.push('付款人');
          if (missing.length > 0) return this.draftMenuPrompt(data, `草稿尚未完成，缺少：${missing.join('、')}`);

          let providedIds: string[] | undefined;
          if (data.sharerMode === 'EXCLUDE_PAYER') {
            const members = await this.crud.getParticipatingMembers(session.group_id);
            const others = members.filter(m => m.user_id !== data.payerUserId);
            if (others.length === 0) return this.draftMenuPrompt(data, '目前沒有可分攤成員（不含付款人）。');
            providedIds = others.map(m => m.user_id);
          } else if (data.sharerMode === 'CUSTOM') {
            if (!data.sharerUserIds || data.sharerUserIds.length === 0) {
              return this.draftMenuPrompt(data, '分攤模式為指定成員，但尚未選擇成員。');
            }
            providedIds = data.sharerUserIds;
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

        return this.draftMenuPrompt(data, '請使用下方選項。');
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_CURRENCY: {
        if (input === '返回選單') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已返回選單。');
        }

        // Allow "其他幣別" path, then user types code/country.
        if (input === '其他幣別') {
          return {
            type: 'text',
            text: '請輸入幣別（例如：EUR、SGD、歐元、新加坡）。',
            quickReply: { items: [this.qr('返回選單', '返回選單'), this.qr(CANCEL, CANCEL)] }
          };
        }

        const resolved = resolveCurrency(input);
        if (!resolved) {
          return {
            type: 'text',
            text: '幣別無法辨識，請從選項選擇，或輸入合法幣別代碼。',
            quickReply: this.draftCurrencyPrompt().quickReply
          };
        }

        data.currency = resolved;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
        return this.draftMenuPrompt(data, `已設定幣別：${resolved}`);
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_AMOUNT: {
        if (input === '返回選單') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已返回選單。');
        }

        if (input === '手動輸入') {
          return {
            type: 'text',
            text: '請輸入金額數字（例如：1250 或 89.5）。',
            quickReply: { items: [this.qr('返回選單', '返回選單'), this.qr(CANCEL, CANCEL)] }
          };
        }

        const amount = parseFloat(input.replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) {
          return {
            type: 'text',
            text: '金額格式錯誤，請從選項選擇或輸入數字。',
            quickReply: this.draftAmountPrompt().quickReply
          };
        }

        data.amount = amount;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
        return this.draftMenuPrompt(data, `已設定金額：${amount}`);
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_DESC: {
        if (input === '返回選單') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已返回選單。');
        }
        if (!input) {
          return {
            type: 'text',
            text: '項目不可空白，請重新輸入。',
            quickReply: { items: [this.qr('返回選單', '返回選單'), this.qr(CANCEL, CANCEL)] }
          };
        }
        data.description = input;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
        return this.draftMenuPrompt(data, `已設定項目：${input}`);
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_PAYER: {
        if (input === '返回選單') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已返回選單。');
        }

        if (input === '我') {
          const me = await this.crud.getMember(session.group_id, session.user_id);
          if (!me) return '找不到你的成員資料，請先輸入「加入」。';
          data.payerUserId = me.user_id;
          data.payerName = me.display_name;
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, `已設定付款人：${me.display_name}`);
        }

        const member = await this.crud.getMemberByDisplayName(session.group_id, input);
        if (!member) {
          return {
            type: 'text',
            text: `找不到付款人：${input}，請從選單選擇。`,
            quickReply: (await this.draftPayerPrompt(session.group_id)).quickReply
          };
        }

        data.payerUserId = member.user_id;
        data.payerName = member.display_name;
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
        return this.draftMenuPrompt(data, `已設定付款人：${member.display_name}`);
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_SPLIT_MODE: {
        if (input === '返回選單') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已返回選單。');
        }
        if (input === '全部分攤') {
          data.sharerMode = 'ALL';
          data.sharerUserIds = [];
          data.sharerNames = ['全部分攤'];
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已設定分攤：全部分攤');
        }
        if (input === '不含付款人') {
          data.sharerMode = 'EXCLUDE_PAYER';
          data.sharerUserIds = [];
          data.sharerNames = ['不含付款人'];
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已設定分攤：不含付款人');
        }
        if (input === '指定成員') {
          data.sharerMode = 'CUSTOM';
          data.sharerUserIds = data.sharerUserIds || [];
          data.sharerNames = data.sharerNames || [];
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_SPLIT_CUSTOM, JSON.stringify(data));
          return this.draftSplitCustomPrompt(session.group_id, data);
        }
        return this.draftSplitModePrompt('請從選項選擇分攤方式。');
      }

      case WizardStep.AWAITING_EXPENSE_DRAFT_SPLIT_CUSTOM: {
        if (input === '返回選單') {
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已返回選單。');
        }
        if (input === '清除全部') {
          data.sharerUserIds = [];
          data.sharerNames = [];
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_SPLIT_CUSTOM, JSON.stringify(data));
          return this.draftSplitCustomPrompt(session.group_id, data, '已清除指定成員。');
        }
        if (input === '完成指定') {
          if (!data.sharerUserIds || data.sharerUserIds.length === 0) {
            return this.draftSplitCustomPrompt(session.group_id, data, '尚未選擇任何成員。');
          }
          await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(data));
          return this.draftMenuPrompt(data, '已完成指定分攤成員。');
        }

        const member = await this.crud.getMemberByDisplayName(session.group_id, input);
        if (!member) return this.draftSplitCustomPrompt(session.group_id, data, `找不到成員：${input}`);

        data.sharerUserIds = data.sharerUserIds || [];
        data.sharerNames = data.sharerNames || [];
        const idx = data.sharerUserIds.indexOf(member.user_id);
        if (idx >= 0) {
          data.sharerUserIds.splice(idx, 1);
          const nameIdx = data.sharerNames.indexOf(member.display_name);
          if (nameIdx >= 0) data.sharerNames.splice(nameIdx, 1);
        } else {
          data.sharerUserIds.push(member.user_id);
          data.sharerNames.push(member.display_name);
        }
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.AWAITING_EXPENSE_DRAFT_SPLIT_CUSTOM, JSON.stringify(data));
        return this.draftSplitCustomPrompt(session.group_id, data);
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
        return this.memberPickPrompt(session.group_id, `請選擇要${mode === 'ADD' ? '新增' : '移除'}的成員（可多次點選），完成後按「完成指定」。`);
      }

      case WizardStep.MODIFY_SPLIT_MEMBER: {
        if (input === '完成指定') {
          if (!data.sharerNames || data.sharerNames.length === 0) return this.memberPickPrompt(session.group_id, '尚未選擇任何成員。');
          const groupSeq = data.groupSeq!;
          const names = data.sharerNames;
          await this.crud.deleteSession(session.user_id);
          if (data.modifyMode === 'ADD') return this.expenseAgent.addSplitMembers(session.group_id, groupSeq, names, displayName);
          return this.expenseAgent.removeSplitMembers(session.group_id, groupSeq, names, displayName);
        }

        const member = await this.crud.getMemberByDisplayName(session.group_id, input);
        if (!member) return this.memberPickPrompt(session.group_id, `找不到成員：${input}`);

        data.sharerUserIds = data.sharerUserIds || [];
        data.sharerNames = data.sharerNames || [];
        if (!data.sharerUserIds.includes(member.user_id)) {
          data.sharerUserIds.push(member.user_id);
          data.sharerNames.push(member.display_name);
        }
        await this.crud.upsertSession(session.user_id, session.group_id, WizardStep.MODIFY_SPLIT_MEMBER, JSON.stringify(data));
        return this.memberPickPrompt(session.group_id, `已選擇：${data.sharerNames.join('、')}`);
      }

      case WizardStep.AWAITING_EXPENSE_TO_DELETE: {
        const match = input.match(/#(\d+)/);
        if (!match) {
          const expenses = await this.crud.getUnsettledExpenses(session.group_id);
          return this.chooseExpensePrompt('格式錯誤，請選擇快捷或輸入 #題號。', expenses);
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
          return this.chooseExpensePrompt('格式錯誤，請選擇快捷或輸入 #題號。', expenses);
        }
        const groupSeq = parseInt(match[1], 10);
        const expense = await this.crud.getExpenseByGroupSeq(session.group_id, groupSeq);
        if (!expense) {
          const expenses = await this.crud.getUnsettledExpenses(session.group_id);
          return this.chooseExpensePrompt(`找不到 #${groupSeq}，請重新選擇。`, expenses);
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
          return this.draftCurrencyPrompt(`請輸入 #${groupSeq} 的新幣別。`);
        }
        if (input === '修改分攤') return this.startModifySplit(session.group_id, session.user_id, groupSeq);

        return {
          type: 'text',
          text: '請從快捷選擇修改項目。',
          quickReply: { items: [this.qr('修改金額', '修改金額'), this.qr('修改幣別', '修改幣別'), this.qr('修改分攤', '修改分攤'), this.qr(CANCEL, CANCEL)] }
        };
      }

      case WizardStep.AWAITING_NEW_CURRENCY: {
        const groupSeq = data.groupSeq!;
        const currency = resolveCurrency(input);
        if (!currency) return this.draftCurrencyPrompt(`幣別輸入錯誤，請重新輸入 #${groupSeq} 的新幣別。`);
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

  private draftMenuPrompt(draft: WizardData, title?: string): messagingApi.Message {
    const summary = [
      `幣別：${draft.currency || '(未設定)'}`,
      `金額：${draft.amount ?? '(未設定)'}`,
      `項目：${draft.description || '(未設定)'}`,
      `付款：${draft.payerName || '(未設定)'}`,
      `分攤：${this.draftSplitText(draft)}`
    ].join('\n');

    return {
      type: 'text',
      text: `${title || '記帳草稿'}\n\n${summary}`,
      quickReply: {
        items: [
          this.qr('設定幣別', '設定幣別'),
          this.qr('設定金額', '設定金額'),
          this.qr('設定項目', '設定項目'),
          this.qr('設定付款人', '設定付款人'),
          this.qr('設定分攤', '設定分攤'),
          this.qr('查看草稿', '查看草稿'),
          this.qr('確認送出', '確認送出'),
          this.qr(CANCEL, CANCEL),
        ].slice(0, 13)
      }
    };
  }

  private draftCurrencyPrompt(hint?: string): messagingApi.Message {
    return {
      type: 'text',
      text: hint || '請選擇幣別。',
      quickReply: {
        items: [
          this.qr('TWD', 'TWD'),
          this.qr('USD', 'USD'),
          this.qr('JPY', 'JPY'),
          this.qr('KRW', 'KRW'),
          this.qr('其他幣別', '其他幣別'),
          this.qr('返回選單', '返回選單'),
          this.qr(CANCEL, CANCEL),
        ]
      }
    };
  }

  private draftAmountPrompt(): messagingApi.Message {
    return {
      type: 'text',
      text: '請選擇金額，或選擇手動輸入。',
      quickReply: {
        items: [
          this.qr('100', '100'),
          this.qr('300', '300'),
          this.qr('500', '500'),
          this.qr('1000', '1000'),
          this.qr('2000', '2000'),
          this.qr('5000', '5000'),
          this.qr('手動輸入', '手動輸入'),
          this.qr('返回選單', '返回選單'),
          this.qr(CANCEL, CANCEL),
        ]
      }
    };
  }

  private async draftPayerPrompt(groupId: string): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const items: messagingApi.QuickReplyItem[] = [
      this.qr('我', '我'),
      ...members.slice(0, 9).map(m => this.qr(m.display_name, m.display_name)),
      this.qr('返回選單', '返回選單'),
      this.qr(CANCEL, CANCEL),
    ];
    return { type: 'text', text: '請選擇付款人。', quickReply: { items: items.slice(0, 13) } };
  }

  private draftSplitModePrompt(hint?: string): messagingApi.Message {
    return {
      type: 'text',
      text: hint || '請選擇分攤方式。',
      quickReply: {
        items: [
          this.qr('全部分攤', '全部分攤'),
          this.qr('不含付款人', '不含付款人'),
          this.qr('指定成員', '指定成員'),
          this.qr('返回選單', '返回選單'),
          this.qr(CANCEL, CANCEL),
        ]
      }
    };
  }

  private async draftSplitCustomPrompt(groupId: string, draft: WizardData, hint?: string): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const selected = draft.sharerNames && draft.sharerNames.length > 0 ? draft.sharerNames.join('、') : '(未選擇)';
    const items: messagingApi.QuickReplyItem[] = [
      ...members.slice(0, 8).map(m => this.qr(m.display_name, m.display_name)),
      this.qr('完成指定', '完成指定'),
      this.qr('清除全部', '清除全部'),
      this.qr('返回選單', '返回選單'),
      this.qr(CANCEL, CANCEL),
    ];
    return {
      type: 'text',
      text: `${hint || '請選擇指定成員（點選可切換）。'}\n目前：${selected}`,
      quickReply: { items: items.slice(0, 13) }
    };
  }

  private async memberPickPrompt(groupId: string, text: string): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const items = [...members.slice(0, 10).map(m => this.qr(m.display_name, m.display_name)), this.qr('完成指定', '完成指定'), this.qr(CANCEL, CANCEL)];
    return { type: 'text', text, quickReply: { items: items.slice(0, 13) } };
  }

  private chooseExpensePrompt(title: string, expenses: Array<{ group_seq: number; description: string }>): messagingApi.Message {
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
      return this.chooseExpensePrompt(`找不到 #${groupSeq}，請重新選擇。`, expenses);
    }
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_DELETE_CONFIRM, JSON.stringify({ groupSeq }));
    return {
      type: 'text',
      text: `確認刪除 #${groupSeq}？\n項目：${expense.description}\n金額：${expense.amount}`,
      quickReply: { items: [this.qr('確認刪除', '確認刪除'), this.qr(CANCEL, CANCEL)] }
    };
  }

  private showDraft(data: WizardData): messagingApi.Message {
    return this.draftMenuPrompt(data, '目前草稿');
  }

  private draftSplitText(draft: WizardData): string {
    if (draft.sharerMode === 'EXCLUDE_PAYER') return '不含付款人';
    if (draft.sharerMode === 'CUSTOM') return draft.sharerNames?.join('、') || '(未選擇)';
    return '全部分攤';
  }
}
