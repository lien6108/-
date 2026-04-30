import { messagingApi } from '@line/bot-sdk';
import { CRUD, Session, WizardData } from '../db/crud';
import { ExpenseAgent } from './expenseAgent';
import { createDraftFlex, createUnifiedDraftCarousel, getStandardQuickReply } from '../utils/ui';
import { resolveCurrency } from '../utils/currency';

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
  AWAITING_EXPENSE_TO_MODIFY = 'AWAITING_EXPENSE_TO_MODIFY',
  AWAITING_EXPENSE_TO_DELETE = 'AWAITING_EXPENSE_TO_DELETE',
  AWAITING_MODIFY_AMOUNT = 'AWAITING_MODIFY_AMOUNT',
  AWAITING_MODIFY_CURRENCY = 'AWAITING_MODIFY_CURRENCY',
  AWAITING_MODIFY_PAYER = 'AWAITING_MODIFY_PAYER',
  AWAITING_MODIFY_SHARERS = 'AWAITING_MODIFY_SHARERS',
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
    const draft: WizardData = {
      description: '',
      amount: 0,
      currency: 'TWD',
      payerUserId: userId,
      payerName: '本人',
    };
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_DRAFT_MENU, JSON.stringify(draft));
    const members = await this.crud.getParticipatingMembers(groupId);
    return createUnifiedDraftCarousel(userId, members);
  }

  async startTripNaming(groupId: string, userId: string): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_TRIP_NAME, JSON.stringify({}));
    return {
      type: 'text',
      text: '尚未設定旅程名稱，請輸入本次旅程的名稱（例如：日本五日遊、墾丁之旅）。',
      quickReply: { items: [this.qr(CANCEL, CANCEL)] }
    };
  }

  async startModifyWizard(groupId: string, userId: string): Promise<messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return { type: 'text', text: '目前沒有未結算的記帳。' };
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_MODIFY, JSON.stringify({}));
    return this.chooseExpensePrompt('請選擇要修改的編號', expenses, 'modify');
  }

  async startDeleteWizard(groupId: string, userId: string, providedGroupSeq?: number): Promise<messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) return { type: 'text', text: '目前沒有未結算的記帳。' };
    if (providedGroupSeq) return this.toDeleteConfirm(groupId, userId, providedGroupSeq, expenses);
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_DELETE, JSON.stringify({}));
    return this.chooseExpensePrompt('請選擇要刪除的編號', expenses, 'delete');
  }

  async startModifyFieldSelect(groupId: string, userId: string, seq: number): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    return {
      type: 'text',
      text: `修改 #${seq}，要改什麼？`,
      quickReply: {
        items: [
          this.qr(`修改金額 #${seq}`, `修改金額 #${seq}`),
          this.qr(`修改幣別 #${seq}`, `修改幣別 #${seq}`),
          this.qr(`修改支付人 #${seq}`, `修改支付人 #${seq}`),
          this.qr(`修改分攤人 #${seq}`, `修改分攤人 #${seq}`),
          this.qr(CANCEL, CANCEL)
        ]
      }
    };
  }

  async startModifyAmountWizard(groupId: string, userId: string, seq: number): Promise<messagingApi.Message> {
    const expense = await this.crud.getExpenseByGroupSeq(groupId, seq);
    if (!expense) return { type: 'text', text: `旺？找不到 #${seq} 喔！` };
    const currency = expense.currency || 'TWD';
    const currentDisplay = currency !== 'TWD' && expense.original_amount
      ? `${currency} ${expense.original_amount}`
      : `TWD ${expense.amount}`;
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_MODIFY_AMOUNT, JSON.stringify({ groupSeq: seq, currency }));
    return {
      type: 'text',
      text: `請輸入 #${seq} 的新金額（目前：${currentDisplay}，輸入的數字將視為 ${currency}）：`,
      quickReply: { items: [this.qr(CANCEL, CANCEL)] }
    };
  }

  async startModifyCurrencyWizard(groupId: string, userId: string, seq: number): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_MODIFY_CURRENCY, JSON.stringify({ groupSeq: seq }));
    return {
      type: 'text',
      text: `請輸入 #${seq} 的新幣別（中文英文均可）：`,
      quickReply: {
        items: [
          this.qr('TWD', 'TWD'), this.qr('JPY', 'JPY'), this.qr('USD', 'USD'),
          this.qr('KRW', 'KRW'), this.qr('EUR', 'EUR'), this.qr('HKD', 'HKD'),
          this.qr(CANCEL, CANCEL)
        ]
      }
    };
  }

  async startModifyPayerWizard(groupId: string, userId: string, seq: number): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_MODIFY_PAYER, JSON.stringify({ groupSeq: seq }));
    const items: messagingApi.QuickReplyItem[] = members.slice(0, 12).map(m => this.qr(m.display_name, m.display_name));
    items.push(this.qr(CANCEL, CANCEL));
    return { type: 'text', text: `請輸入 #${seq} 的新支付人：`, quickReply: { items } };
  }

  async startModifySharersWizard(groupId: string, userId: string, seq: number): Promise<messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    const memberList = members.map(m => `• ${m.display_name}`).join('\n');
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_MODIFY_SHARERS, JSON.stringify({ groupSeq: seq }));
    return {
      type: 'text',
      text: `請輸入 #${seq} 的新分攤人，用空格隔開，或輸入「所有人」：\n\n目前成員：\n${memberList}`,
      quickReply: { items: [this.qr('所有人', '所有人'), this.qr(CANCEL, CANCEL)] }
    };
  }

  async handleNext(session: Session, text: string, displayName: string): Promise<string | messagingApi.Message | null> {
    const data: WizardData = JSON.parse(session.data || '{}');
    const input = text.trim();
    if (input === CANCEL) {
      await this.crud.deleteSession(session.user_id);
      return '好唔～已取消本次操作。旺！';
    }

    const step = session.step as WizardStep;
    switch (step) {
      case WizardStep.AWAITING_EXPENSE_TO_DELETE: {
        if (input === '確認') {
          const seq = data.groupSeq;
          await this.crud.deleteSession(session.user_id);
          return await this.expenseAgent.deleteExpense(session.group_id, seq, displayName);
        }
        break;
      }
      case WizardStep.AWAITING_MODIFY_AMOUNT: {
        const amount = parseFloat(input.replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) return { type: 'text', text: '旺！請輸入有效金額（大於 0 的數字）：', quickReply: { items: [this.qr(CANCEL, CANCEL)] } };
        await this.crud.deleteSession(session.user_id);
        return await this.expenseAgent.updateExpense(session.group_id, data.groupSeq, amount, displayName);
      }
      case WizardStep.AWAITING_MODIFY_CURRENCY: {
        const currency = resolveCurrency(input);
        if (!currency) return { type: 'text', text: `汪？「${input}」辨識不出來耶，請輸入如 TWD、JPY、美金 等：`, quickReply: { items: [this.qr('TWD', 'TWD'), this.qr('JPY', 'JPY'), this.qr('USD', 'USD'), this.qr(CANCEL, CANCEL)] } };
        await this.crud.deleteSession(session.user_id);
        return await this.expenseAgent.updateExpenseCurrency(session.group_id, data.groupSeq, currency, displayName);
      }
      case WizardStep.AWAITING_MODIFY_PAYER: {
        const cleanName = input.replace(/^@/, '').trim();
        const member = await this.crud.getMemberByDisplayName(session.group_id, cleanName);
        if (!member) {
          const members = await this.crud.getParticipatingMembers(session.group_id);
          const items: messagingApi.QuickReplyItem[] = members.slice(0, 12).map(m => this.qr(m.display_name, m.display_name));
          items.push(this.qr(CANCEL, CANCEL));
          return { type: 'text', text: `旺？找不到「${cleanName}」，請重新輸入成員名稱：`, quickReply: { items } };
        }
        const expense = await this.crud.getExpenseByGroupSeq(session.group_id, data.groupSeq);
        if (!expense) { await this.crud.deleteSession(session.user_id); return `旺？找不到 #${data.groupSeq} 喔！`; }
        await this.crud.updateExpensePayer(expense.id, member.user_id, member.display_name);
        await this.crud.deleteSession(session.user_id);
        return { type: 'text', text: `🐾 已修改 #${data.groupSeq} 支付人為「${member.display_name}」！旺！`, quickReply: getStandardQuickReply() };
      }
      case WizardStep.AWAITING_MODIFY_SHARERS: {
        const expense = await this.crud.getExpenseByGroupSeq(session.group_id, data.groupSeq);
        if (!expense) { await this.crud.deleteSession(session.user_id); return `旺？找不到 #${data.groupSeq} 喔！`; }
        let debtors: { userId: string; name: string }[];
        if (/^(所有人|全部|all|全員)$/i.test(input.trim())) {
          const all = await this.crud.getParticipatingMembers(session.group_id);
          debtors = all.map(m => ({ userId: m.user_id, name: m.display_name }));
        } else {
          const names = input.split(/[\s,，、]+/).filter(s => s.length > 0);
          debtors = [];
          const missing: string[] = [];
          for (const n of names) {
            const clean = n.replace(/^@/, '').trim();
            const m = await this.crud.getMemberByDisplayName(session.group_id, clean);
            if (m) debtors.push({ userId: m.user_id, name: m.display_name });
            else missing.push(n);
          }
          if (missing.length > 0) return { type: 'text', text: `旺？找不到這些夥伴：${missing.join('、')}，請重新輸入：`, quickReply: { items: [this.qr('所有人', '所有人'), this.qr(CANCEL, CANCEL)] } };
        }
        await this.crud.replaceExpenseSplits(expense.id, debtors);
        await this.crud.deleteSession(session.user_id);
        const sharerNames = debtors.map(d => d.name).join('、');
        return { type: 'text', text: `🐾 已修改 #${data.groupSeq} 分攞人為：${sharerNames}！旺旺！`, quickReply: getStandardQuickReply() };
      }
      case WizardStep.AWAITING_TRIP_NAME: {
        const tripName = input.trim();
        if (!tripName) return { type: 'text', text: '請輸入旅程名稱：', quickReply: { items: [this.qr(CANCEL, CANCEL)] } };
        const existing = await this.crud.getCurrentTrip(session.group_id);
        let trip;
        if (existing) {
          trip = await this.crud.updateTripName(session.group_id, tripName);
        } else {
          trip = await this.crud.startNewTrip(session.group_id, tripName);
        }
        await this.crud.deleteSession(session.user_id);
        return {
          type: 'text',
          text: `🐾 旺旺！旅程名稱已設定為「${trip?.trip_name || tripName}」，可以開始記帳啦！`,
          quickReply: { items: [this.qr('開始記帳', '開始記帳'), this.qr('成員', '成員'), this.qr(CANCEL, CANCEL)] }
        };
      }
      case WizardStep.AWAITING_EXPENSE_DRAFT_MENU:
        if (input === '確認送出') {
          await this.crud.deleteSession(session.user_id);
          let amountTwd = data.amount || 0;
          let originalAmount: number | undefined;
          if (data.currency && data.currency !== 'TWD') {
            const rate = await this.crud.getExchangeRate(data.currency);
            if (rate) {
              originalAmount = data.amount;
              amountTwd = Math.round(data.amount! * rate * 100) / 100;
            }
          }
          return await this.expenseAgent.addExpense(session.group_id, data.payerUserId!, data.payerName!, data.description || '未命名項目', amountTwd, undefined, data.currency || 'TWD', originalAmount);
        }
        break;
      // Other steps like TRIP_NAME handling...
    }
    return null;
  }

  async handlePostback(session: Session, data: string, displayName: string): Promise<string | messagingApi.Message | null> {
    const wizardData: WizardData = JSON.parse(session.data || '{}');
    const params = new URLSearchParams(data);
    const action = params.get('action');
    const owner = params.get('owner');

    if (owner && owner !== session.user_id) return null; // Silent lock

    switch (action) {
      case 'num_press': {
        const val = params.get('val') || '';
        const current = wizardData.amount?.toString() || '';
        const newVal = parseFloat((current === '0' ? '' : current) + val);
        wizardData.amount = newVal;
        await this.crud.upsertSession(session.user_id, session.group_id, session.step, JSON.stringify(wizardData));
        return null;
      }
      case 'num_back': {
        const current = wizardData.amount?.toString() || '';
        const newValStr = current.slice(0, -1);
        const newVal = newValStr ? parseFloat(newValStr) : 0;
        wizardData.amount = newVal;
        await this.crud.upsertSession(session.user_id, session.group_id, session.step, JSON.stringify(wizardData));
        return null;
      }
      case 'num_clear': {
        wizardData.amount = 0;
        await this.crud.upsertSession(session.user_id, session.group_id, session.step, JSON.stringify(wizardData));
        return null;
      }
      case 'set_category_silent': {
        wizardData.description = params.get('val') || '';
        await this.crud.upsertSession(session.user_id, session.group_id, session.step, JSON.stringify(wizardData));
        return null;
      }
      case 'set_currency_silent': {
        wizardData.currency = params.get('val') || 'TWD';
        await this.crud.upsertSession(session.user_id, session.group_id, session.step, JSON.stringify(wizardData));
        return null;
      }
      case 'set_payer_silent': {
        const val = params.get('val') || 'me';
        if (val === 'me') {
          wizardData.payerUserId = session.user_id;
          wizardData.payerName = '本人';
        } else {
          wizardData.payerName = val;
          const member = await this.crud.getMemberByDisplayName(session.group_id, val);
          if (member) wizardData.payerUserId = member.user_id;
        }
        await this.crud.upsertSession(session.user_id, session.group_id, session.step, JSON.stringify(wizardData));
        return null;
      }
      case 'show_draft':
        return createDraftFlex(wizardData, false, session.user_id);
      case 'back_to_carousel':
        const members = await this.crud.getParticipatingMembers(session.group_id);
        return createUnifiedDraftCarousel(session.user_id, members);
      case 'submit_draft':
        return this.handleNext(session, '確認送出', displayName);
    }
    return null;
  }

  private qr(label: string, text: string): messagingApi.QuickReplyItem {
    return { type: 'action', action: { type: 'message', label, text } };
  }

  private pb(label: string, data: string): messagingApi.QuickReplyItem {
    return { type: 'action', action: { type: 'postback', label, data } };
  }

  private chooseExpensePrompt(title: string, expenses: any[], action: 'delete' | 'modify' = 'delete'): messagingApi.Message {
    const buttons = expenses.slice(0, 12).map(exp => {
      const amountText = exp.currency && exp.currency !== 'TWD' && exp.original_amount
        ? `${exp.currency} ${exp.original_amount}`
        : `TWD ${exp.amount}`;
      const label = `#${exp.group_seq} ${exp.description}`;
      const text = action === 'delete' ? `刪除 #${exp.group_seq}` : `修改 #${exp.group_seq}`;
      return {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: `#${exp.group_seq}`, size: 'sm', color: '#888888', flex: 1, gravity: 'center' },
          { type: 'text', text: exp.description, size: 'sm', weight: 'bold', flex: 4, wrap: true, gravity: 'center' },
          { type: 'text', text: amountText, size: 'xs', color: '#555555', flex: 3, align: 'end', gravity: 'center' },
          {
            type: 'button',
            action: { type: 'message', label: action === 'delete' ? '刪除' : '選擇', text },
            style: action === 'delete' ? 'secondary' : 'primary',
            height: 'sm',
            flex: 2,
            color: action === 'delete' ? undefined : '#2ecc71'
          }
        ]
      };
    });

    return {
      type: 'flex',
      altText: title,
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#46494c',
          contents: [{ type: 'text', text: title, weight: 'bold', color: '#ffffff', size: 'md' }]
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'none',
          contents: buttons.length > 0 ? buttons : [{ type: 'text', text: '沒有記帳項目', size: 'sm', color: '#888888' }]
        },
        footer: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'button', action: { type: 'message', label: '取消', text: '取消' }, style: 'secondary', height: 'sm' }
          ]
        }
      }
    } as any;
  }

  private async toDeleteConfirm(groupId: string, userId: string, seq: number, expenses: any[]): Promise<messagingApi.Message> {
    const exp = expenses.find(e => e.group_seq === seq);
    const detail = exp ? `（${exp.description} / ${exp.amount}）` : '';
    await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_EXPENSE_TO_DELETE, JSON.stringify({ groupSeq: seq }));
    return { type: 'text', text: `確認要刪除 #${seq}${detail} 嗎？`, quickReply: { items: [this.qr('確認', '確認'), this.qr(CANCEL, CANCEL)] } };
  }
}
