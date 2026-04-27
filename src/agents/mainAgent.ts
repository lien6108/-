import { messagingApi } from '@line/bot-sdk';
import { Env } from '../env';
import { CRUD } from '../db/crud';
import { resolveCurrency, isExpenseFormat } from '../utils/currency';
import { NLPAgent } from './nlpAgent';
import { MemberAgent } from './memberAgent';
import { ExpenseAgent } from './expenseAgent';
import { SettlementAgent } from './settlementAgent';
import { WizardAgent, WizardStep } from './wizardAgent';
import { getStandardQuickReply } from '../utils/ui';

const HELP_TEXT = [
  '✨ 分帳神器 指令教學 ✨',
  '------------------------',
  '🔹 基礎功能',
  '- 「加入」：開始參與本次分帳',
  '- 「開始記帳」：依照精靈引導輸入',
  '- 「清單」：查看所有未結算項目 (表格顯示)',
  '- 「結算」：計算每人應收/應付金額',
  '- 「成員」：查看目前參與人員',
  '',
  '🔹 快速記帳 (進階)',
  '- 「記帳 [幣別] [金額] [項目]」',
  '  範例：記帳 日幣 1000 拉麵',
  '- 「代墊 @付款人 [金額] [項目]」',
  '  範例：代墊 @小明 500 計程車',
  '',
  '🔹 修改與刪除',
  '- 「刪除」：跳出最近項目選擇刪除',
  '- 「修改」：可修改金額、幣別或成員',
  '',
  '🔹 其他',
  '- 「歷史」：查看過去的旅程紀錄',
  '- 「回饋」：提供建議給開發者',
  '- 「退出」：離開本次分帳',
  '------------------------',
  '💡 提示：點擊下方的「快捷選單」更方便喔！'
].join('\n');

export class MainAgent {
  private nlp: NLPAgent;
  private member: MemberAgent;
  private expense: ExpenseAgent;
  private settlement: SettlementAgent;
  private wizard: WizardAgent;
  private env: Env;
  private crud: CRUD;

  constructor(env: Env, crud: CRUD) {
    this.env = env;
    this.crud = crud;
    this.nlp = new NLPAgent(env);
    this.member = new MemberAgent(crud);
    this.expense = new ExpenseAgent(crud);
    this.settlement = new SettlementAgent(crud);
    this.wizard = new WizardAgent(crud, this.expense);
  }

  async processMessage(
    groupId: string,
    userId: string,
    displayName: string,
    text: string,
    mentionMap: Record<string, string> = {}
  ): Promise<string | messagingApi.Message | null> {
    const input = text.trim();

    const maintenance = await this.crud.isMaintenanceMode();
    if (maintenance && userId !== this.env.ADMIN_LINE_USER_ID) {
      return '🐕 系統維修中，小幫手正在休息，請稍後再試。';
    }

    if (input === '啟用分帳') {
      await this.crud.setGroupActive(groupId, true);
      return '已啟用分帳。';
    }

    const isActive = await this.crud.isGroupActive(groupId);
    if (!isActive) {
      if (['help', '說明', '啟用分帳'].includes(input)) {
        return {
          type: 'text',
          text: '目前分帳功能已暫停，輸入「啟用分帳」即可恢復。',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '啟用分帳', text: '啟用分帳' } },
              { type: 'action', action: { type: 'message', label: '取消', text: '取消' } }
            ]
          }
        };
      }
      return null;
    }

    if (input === '暫停分帳') {
      await this.crud.setGroupActive(groupId, false);
      return '已暫停分帳。';
    }

    await this.member.ensureMember(groupId, userId, displayName);
    const member = await this.crud.getMember(groupId, userId);
    const isParticipating = member?.is_participating === 1;

    // Group-level lock:
    // If someone is in an active guided flow, ignore other users' messages
    // to avoid interruption and chat spam.
    const groupSession = await this.crud.getGroupActiveSession(groupId);
    if (groupSession && groupSession.user_id !== userId) {
      return null;
    }

    const session = await this.crud.getSession(userId);
    if (session) {
      return this.wizard.handleNext(session, input, displayName);
    }

    if (input === '取消') return null;

    if (input === '加入') {
      const trip = await this.crud.getCurrentTrip(groupId);
      const joinMsg = await this.member.handleJoinGroup(groupId, userId, displayName);
      if (!trip) {
        const namingMsg = await this.wizard.startTripNaming(groupId, userId);
        if (typeof joinMsg === 'string') {
          return `${joinMsg}\n\n${(namingMsg as messagingApi.TextMessage).text}`;
        } else {
          // If both are objects, we might need to combine or just prioritize one.
          // For simplicity, we'll return a combined text if possible.
          return {
            type: 'text',
            text: `${(joinMsg as messagingApi.TextMessage).text}\n\n${(namingMsg as messagingApi.TextMessage).text}`,
            quickReply: namingMsg.quickReply
          };
        }
      }
      return joinMsg;
    }
    if (input === '退出') return this.member.requestLeave(groupId, userId, displayName);
    if (input === '確認退出') return this.member.confirmLeave(groupId, userId, displayName);
    if (input === '成員') return this.member.getMemberList(groupId);
    if (input === '說明' || input === 'help' || input === '/help') return HELP_TEXT;
    if (input === 'GREETING') {
      return {
        type: 'text',
        text: '您好，請問需要什麼服務呢？',
        quickReply: getStandardQuickReply()
      };
    }

    if (input === '回饋') return this.wizard.startFeedback(groupId, userId);
    if (input.startsWith('回饋 ')) {
      const content = input.replace(/^回饋\s+/, '').trim();
      if (!content) return this.wizard.startFeedback(groupId, userId);
      return `[FEEDBACK]${content}`;
    }

    if (input === '歷史') {
      const trips = await this.crud.getTripHistory(groupId, 10);
      if (trips.length === 0) return '目前還沒有歷史旅程。';
      const rows = trips.map(t => `- ${t.trip_name} (${t.status === 'active' ? '進行中' : '已結束'})`);
      return `最近旅程：\n${rows.join('\n')}`;
    }

    if (input === '清單') {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      return this.expense.listExpenses(groupId);
    }

    if (input === '結算') {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      return this.settlement.showSettlement(groupId);
    }
    if (input === '確認結算') {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      return this.settlement.confirmSettlement(groupId);
    }

    if (input === '刪除') {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      return this.wizard.startDeleteWizard(groupId, userId);
    }
    if (input === '修改') {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      return this.wizard.startModifyWizard(groupId, userId);
    }
    if (input === '開始記帳') {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      const trip = await this.crud.getCurrentTrip(groupId);
      if (!trip) return this.wizard.startTripNaming(groupId, userId);
      return this.wizard.start(groupId, userId);
    }

    const deleteMatch = input.match(/^刪除\s*#(\d+)$/);
    if (deleteMatch) {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      return this.wizard.startDeleteWizard(groupId, userId, parseInt(deleteMatch[1], 10));
    }

    const updateAmountMatch = input.match(/^修改金額\s*#(\d+)\s*([\d,]+(?:\.\d+)?)$/);
    if (updateAmountMatch) {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      const seq = parseInt(updateAmountMatch[1], 10);
      const amount = parseFloat(updateAmountMatch[2].replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) return '金額格式錯誤，請輸入大於 0 的數字。';
      return this.expense.updateExpense(groupId, seq, amount, displayName);
    }

    const updateCurrencyMatch = input.match(/^修改幣別\s*#(\d+)\s*(.+)$/);
    if (updateCurrencyMatch) {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      const seq = parseInt(updateCurrencyMatch[1], 10);
      const currency = resolveCurrency(updateCurrencyMatch[2].trim());
      if (!currency) {
        await this.crud.upsertSession(userId, groupId, WizardStep.AWAITING_NEW_CURRENCY, JSON.stringify({ groupSeq: seq }));
        return {
          type: 'text',
          text: '幣別輸入錯誤，請重新輸入，或從快捷選擇。',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: 'TWD', text: 'TWD' } },
              { type: 'action', action: { type: 'message', label: 'USD', text: 'USD' } },
              { type: 'action', action: { type: 'message', label: 'JPY', text: 'JPY' } },
              { type: 'action', action: { type: 'message', label: 'KRW', text: 'KRW' } },
              { type: 'action', action: { type: 'message', label: '取消', text: '取消' } },
            ]
          }
        };
      }
      return this.expense.updateExpenseCurrency(groupId, seq, currency, displayName);
    }

    const splitDetailMatch = input.match(/^修改分攤\s*#(\d+)\s*(.*)$/);
    if (splitDetailMatch) {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      const seq = parseInt(splitDetailMatch[1], 10);
      const rest = splitDetailMatch[2].trim();
      if (!rest) return this.expense.showExpenseSplitDetail(groupId, seq);
      const addNames = [...rest.matchAll(/\+@(\S+)/g)].map(m => m[1]);
      const removeNames = [...rest.matchAll(/-@(\S+)/g)].map(m => m[1]);
      if (addNames.length > 0 && removeNames.length > 0) return '同一則訊息請只做新增或只做移除。';
      if (addNames.length > 0) return this.expense.addSplitMembers(groupId, seq, addNames, displayName, mentionMap);
      if (removeNames.length > 0) return this.expense.removeSplitMembers(groupId, seq, removeNames, displayName, mentionMap);
      return '請使用：修改分攤 #題號 +@名字 或 修改分攤 #題號 -@名字';
    }

    if (input === '匯率' || input === '幣率') {
      return this.expense.showGroupExchangeRates(groupId);
    }

    const onBehalf = input.match(/^代墊\s+@(\S+)\s+(?:([A-Za-z\u4e00-\u9fa5]+)\s+)?([\d,]+(?:\.\d+)?)\s*(.*)$/);
    if (onBehalf) {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      const trip = await this.crud.getCurrentTrip(groupId);
      if (!trip) return this.wizard.startTripNaming(groupId, userId);

      const payerName = onBehalf[1];
      const currencyRaw = (onBehalf[2] || 'TWD').trim();
      const resolvedCurrency = resolveCurrency(currencyRaw);
      if (!resolvedCurrency) return `幣別無法辨識：${currencyRaw}`;

      const originalAmount = parseFloat(onBehalf[3].replace(/,/g, ''));
      if (isNaN(originalAmount) || originalAmount <= 0) return '金額格式錯誤。';

      const rest = (onBehalf[4] || '').trim();
      const participants = [...rest.matchAll(/@(\S+)/g)].map(m => m[1]);
      const description = rest.replace(/@\S+/g, '').trim() || '記帳';

      let amount = originalAmount;
      if (resolvedCurrency !== 'TWD') {
        const rate = await this.crud.getExchangeRate(resolvedCurrency);
        if (!rate) return `${resolvedCurrency} 匯率尚未就緒，請稍後再試。`;
        amount = Math.round(originalAmount * rate * 100) / 100;
      }

      return this.expense.addExpenseOnBehalf(
        groupId,
        userId,
        displayName,
        payerName,
        description,
        amount,
        participants.length > 0 ? participants : undefined,
        resolvedCurrency,
        resolvedCurrency !== 'TWD' ? originalAmount : undefined,
        mentionMap
      );
    }

    if (isExpenseFormat(input)) {
      if (!isParticipating) return '你尚未加入分帳，請先輸入「加入」。';
      const trip = await this.crud.getCurrentTrip(groupId);
      if (!trip) return this.wizard.startTripNaming(groupId, userId);

      let parsedItems;
      try {
        parsedItems = await this.nlp.parseMultipleExpenseMessages(input);
      } catch (e: any) {
        if (e.message === 'AI_QUOTA_EXCEEDED') {
          return '[NOTIFY_ADMIN]AI 解析額度不足，請稍後再試。你也可改用精靈「開始記帳」。';
        }
        throw e;
      }

      if (parsedItems.length === 0) return '記帳格式不正確，請使用：記帳 [幣別] [金額] [項目]';
      if (parsedItems.length === 1) {
        const p = parsedItems[0];
        return this.expense.addExpense(groupId, userId, displayName, p.description || '記帳', p.amount, p.participants, p.currency, p.originalAmount, mentionMap);
      }
      return this.expense.addMultipleExpenses(groupId, userId, displayName, parsedItems, mentionMap);
    }

    return null;
  }

  async processPostback(groupId: string, userId: string, displayName: string, data: string): Promise<string | messagingApi.Message | null> {
    const maintenance = await this.crud.isMaintenanceMode();
    if (maintenance && userId !== this.env.ADMIN_LINE_USER_ID) return null;

    await this.member.ensureMember(groupId, userId, displayName);
    const member = await this.crud.getMember(groupId, userId);
    const isParticipating = member?.is_participating === 1;
    const params = new URLSearchParams(data);
    const action = params.get('action');

    if (action === 'start_add') {
      if (!isParticipating) return '雿??芸??亙?撣喉?隢?頛詨???乓?';
      const trip = await this.crud.getCurrentTrip(groupId);
      if (!trip) return this.wizard.startTripNaming(groupId, userId);
      return this.wizard.start(groupId, userId);
    }

    if (action === 'start_edit') {
      if (!isParticipating) return '雿??芸??亙?撣喉?隢?頛詨???乓?';
      return this.wizard.startModifyWizard(groupId, userId);
    }

    const session = await this.crud.getSession(userId);
    if (session) {
      return this.wizard.handlePostback(session, data, displayName);
    }
    return null;
  }

  async handleBotJoinGroup(): Promise<string> {
    return '大家好，我是你的分帳小幫手🐕\n請先輸入「加入」來加入分帳，後續只要@我就可以使用嘍！';
  }
}
