import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';
import { MemberAgent } from './memberAgent';
import { ExpenseAgent } from './expenseAgent';
import { SettlementAgent } from './settlementAgent';
import { WizardAgent } from './wizardAgent';
import { ItineraryAgent } from './itineraryAgent';
import { resolveCurrency } from '../utils/currency';
import { Env } from '../env';
import { getStandardQuickReply, getMainMenuQuickReply, getAccountingQuickReply, getItineraryQuickReply, createTemplateGuideMessage } from '../utils/ui';

// ─── 模板格式解析 ─────────────────────────────────────────────────────────────
// 支援：名稱：晚餐　金額：500　幣別：JPY　支付者：Bob　分攤人：@Alice @Carol
// 所有欄位皆可選，但 名稱 與 金額 至少需要其中一組（配合簡易格式 "晚餐 500"）
function parseTemplateExpense(input: string): {
  description?: string;
  amount?: number;
  currency?: string;
  payerName?: string;
  sharers?: string[];
  errors?: string[];
} | null {
  // 必須包含至少一個模板欄位才進入此 parser
  if (!/[名稱金額幣別支付分攤][：:]/.test(input)) return null;

  // 換行、全形空白全部轉半形空白，方便切割
  const normalized = input.replace(/\r?\n/g, ' ').replace(/　/g, ' ');
  const fields: Record<string, string> = {};

  // 以已知欄位名稱作為切割點
  const segments = normalized.split(/(?=(?:名稱|金額|幣別|支付者|分攤人)[：:])/);
  for (const seg of segments) {
    const m = seg.match(/^(名稱|金額|幣別|支付者|分攤人)[：:]\s*(.+)/);
    if (m) fields[m[1]] = m[2].trim();
  }

  const errors: string[] = [];
  if (!fields['名稱']) errors.push('【名稱】欄位遺漏或為空');

  const amount = fields['金額'] ? parseFloat(fields['金額'].replace(/,/g, '')) : NaN;
  if (!fields['金額']) errors.push('【金額】欄位遺漏');
  else if (isNaN(amount) || amount <= 0) errors.push(`【金額】「${fields['金額']}」不是有效數字`);

  // 若名稱與金額都沒有，視為非模板訊息
  if (!fields['名稱'] && !fields['金額']) return null;

  // 分攤人：所有人/全部 → 視同未指定（全體分攤）
  let sharers: string[] | undefined;
  if (fields['分攤人']) {
    const raw = fields['分攤人'].trim();
    if (/^(所有人|全部|all|全員)$/i.test(raw)) {
      sharers = undefined;
    } else {
      sharers = raw.split(/[\s,，、]+/).filter(s => s.length > 0);
    }
  }

  return {
    description: fields['名稱'],
    amount: isNaN(amount) ? undefined : amount,
    currency: fields['幣別'],
    payerName: fields['支付者'],
    sharers,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export class MainAgent {
  private crud: CRUD;
  private member: MemberAgent;
  private expense: ExpenseAgent;
  private settlement: SettlementAgent;
  private wizard: WizardAgent;
  private itinerary: ItineraryAgent;
  private env: Env;

  constructor(env: Env, crud: CRUD) {
    this.env = env;
    this.crud = crud;
    // Initialize sub-agents internally
    this.member = new MemberAgent(crud);
    this.expense = new ExpenseAgent(crud);
    this.settlement = new SettlementAgent(crud);
    this.wizard = new WizardAgent(crud, this.expense);
    this.itinerary = new ItineraryAgent(crud);
  }

  async processMessage(groupId: string, userId: string, displayName: string, input: string, mentionMap?: Map<string, string>): Promise<string | messagingApi.Message | messagingApi.Message[] | null> {
    const maintenance = await this.crud.isMaintenanceMode();
    if (maintenance && userId !== this.env.ADMIN_LINE_USER_ID) {
      // 只有在被 @mention 時才回應維修中訊息，其他訊息靜默
      if (input === 'GREETING') return '🔧 系統維修中，請稍後再試～';
      return null;
    }

    try {
      await this.member.ensureMember(groupId, userId, displayName);
      const member = await this.crud.getMember(groupId, userId);
      const isParticipating = member?.is_participating === 1;

      const session = await this.crud.getSession(userId);
      // 若輸入是 修改/刪除 #N 系列指令，優先處理（清除殘留 session 避免誤路由）
      const isModifyDeleteCmd = /^[\s]*(?:修改|刪除|修改金額|修改幣別|修改支付人|修改分攤人)\s*[#＃]\d+/.test(input);

      // 任何地方輸入「取消」→ 清除 session，統一回覆
      if (input === '取消') {
        if (session) await this.crud.deleteSession(userId);
        return { type: 'text', text: '已取消當前操作。' };
      }

      if (session && session.step === 'AWAITING_FLIGHT_INPUT') {
        const data = JSON.parse(session.data || '{}');
        const flightType = data.flightType as 'outbound' | 'return';
        await this.crud.deleteSession(userId);
        // 若格式錯要求重試，重建 session
        const result = await this.itinerary.handleFlightInput(groupId, input, flightType);
        if (typeof result === 'object' && (result as any).type === 'text' && (result as any).text?.startsWith('格式不符')) {
          await this.crud.upsertSession(userId, groupId, 'AWAITING_FLIGHT_INPUT', JSON.stringify({ flightType }));
        }
        return result;
      }

      if (session && session.step === 'AWAITING_ITINERARY_IMPORT') {
        await this.crud.deleteSession(userId);
        const result = await this.itinerary.importSpots(groupId, input);
        if (result) return result;
        return { type: 'text', text: '格式不符，無法匯入。\n每行請使用 D1 景點名稱 的格式，例如：\nD1 淺草寺\nD2 新宿御苑' };
      }

      if (session && !isModifyDeleteCmd) {
        return await this.wizard.handleNext(session, input, displayName);
      }
      if (session && isModifyDeleteCmd) {
        await this.crud.deleteSession(userId);
      }

      // 處理來自 LIFF 的快速記帳訊息
      if (input.startsWith('[快速記帳]')) {
        const parts = input.replace('[快速記帳]', '').trim().split(' ');
        if (parts.length >= 2) {
          const category = parts[0];
          const amount = parseFloat(parts[1]);
          if (!isNaN(amount)) {
            return await this.expense.addExpense(groupId, userId, displayName, category, amount);
          }
        }
      }

      if (input === '加入') {
        const joinMsg = await this.member.handleJoinGroup(groupId, userId, displayName);
        // 若為第一位加入的成員且尚未有旅程，自動觸發旅程命名
        const participants = await this.crud.getParticipatingMembers(groupId);
        const currentTrip = await this.crud.getCurrentTrip(groupId);
        if (participants.length === 1 && !currentTrip) {
          const tripMsg = await this.wizard.startTripNaming(groupId, userId);
          return [joinMsg as messagingApi.Message, tripMsg];
        }
        return joinMsg;
      }

      if (input === '退出') {
        return await this.member.requestLeave(groupId, userId, displayName);
      }

      if (input === '確認退出') {
        return await this.member.confirmLeave(groupId, userId, displayName);
      }

      if (input === '修改旅程名稱') {
        const trip = await this.crud.getCurrentTrip(groupId);
        await this.crud.upsertSession(userId, groupId, 'AWAITING_TRIP_NAME', JSON.stringify({}));
        return {
          type: 'text',
          text: trip ? `目前旅程名稱：「${trip.trip_name}」
請輸入新的旅程名稱：` : '請輸入旅程名稱：',
          quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } }] }
        };
      }

      if (input === '成員' || input === 'member') {
        return await this.member.getMemberList(groupId);
      }

      if (input === '說明' || input === 'help' || input === 'HELP') {
        return {
          type: 'text',
          text: '【分帳神器 指令說明】\n\n📌 記帳方式\n• 簡易：記帳 晚餐 500\n• 完整：名稱：晚餐　金額：500　幣別：JPY　支付者：Alice　分攤人：@Bob\n• 開始記帳：顯示格式說明與快捷按鈕\n\n📋 查詢與管理\n• 清單：未結算記帳\n• 結算：查看各人應付金額\n• 確認結算：正式結帳並清空\n• 歷史：過去結算記錄\n• 刪除 #5：刪除第 5 筆\n• 修改金額 #5 100：改金額\n• 修改幣別 #5 JPY：改幣別\n\n✈️ 班機資訊\n• 班機資訊：查看去回程班機\n• 班機 去程 / 班機 回程：新增或修改\n• 刪除班機：刪除班機資訊\n\n🗺️ 旅遊行程\n• 新增旅遊行程：取得 AI 提示詞，貼到 GPT/Gemini 生成行程後再貼回來\n• 行程：查看景點（左右滑動切換天數）\n• 行程 D2：查看第 2 天景點\n• 刪除景點 #N：刪除景點\n\n👥 成員\n• 加入 / 退出 / 成員',
          quickReply: getMainMenuQuickReply()
        };
      }

      if (input === 'GREETING') {
        if (!isParticipating) {
          return {
            type: 'text',
            text: '你還沒加入分帳名單，加入後就能和大家一起記帳啦！🐶',
            quickReply: {
              items: [
                { type: 'action', action: { type: 'postback', label: '加入', data: 'cmd=加入' } },
                { type: 'action', action: { type: 'postback', label: '查看成員', data: 'cmd=成員' } },
                { type: 'action', action: { type: 'postback', label: '完整說明', data: 'cmd=說明' } },
                { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
              ]
            }
          };
        }
        return {
          type: 'text',
          text: '有什麼需要幫忙的嗎？🐶',
          quickReply: getMainMenuQuickReply()
        };
      }

      if (input === '記帳功能') {
        return {
          type: 'text',
          text: '💰 記帳功能',
          quickReply: getAccountingQuickReply()
        };
      }

      if (input === '行程功能') {
        return {
          type: 'text',
          text: '🗺️ 行程功能',
          quickReply: getItineraryQuickReply()
        };
      }

      if (input === '結算' || input === 'settle') {
        return await this.settlement.showSettlement(groupId);
      }

      if (input === '確認結算') {
        return await this.settlement.confirmSettlement(groupId);
      }

      if (input === '清單' || input === 'list') {
        return await this.expense.listExpenses(groupId);
      }

      if (input === '只看我的帳') {
        return await this.expense.showMyAccount(groupId, userId, displayName);
      }

      if (input === '修改帳單') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        return await this.wizard.startModifyWizard(groupId, userId);
      }

      if (input === '刪除帳單') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        return await this.wizard.startDeleteWizard(groupId, userId);
      }

      if (input === '開始記帳說明') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        const trip = await this.crud.getCurrentTrip(groupId);
        if (!trip) return await this.wizard.startTripNaming(groupId, userId);
        const members = await this.crud.getParticipatingMembers(groupId);
        return createTemplateGuideMessage(members);
      }

      if (input === '歷史' || input === 'history') {
        return await this.settlement.listHistory(groupId);
      }

      if (input === '開始記帳') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        const trip = await this.crud.getCurrentTrip(groupId);
        if (!trip) return await this.wizard.startTripNaming(groupId, userId);
        const members = await this.crud.getParticipatingMembers(groupId);
        return createTemplateGuideMessage(members);
      }

      // 統一 # 符號處理：支援半形 # 與全形 ＃
      const normalizedInput = input.replace(/＃/g, '#');

      const historyTripMatch = normalizedInput.match(/^歷史\s*#(\d+)$/);
      if (historyTripMatch) {
        return await this.settlement.showTripExpenses(groupId, parseInt(historyTripMatch[1], 10));
      }

      // ─── 行程指令 ────────────────────────────────────────────────────────────────
      if (input === '行程') return await this.itinerary.showDayItinerary(groupId);
      if (input === '全部行程') return await this.itinerary.showFullItinerary(groupId);
      if (input === '新增旅遊行程') return await this.itinerary.showAIPrompt(groupId, userId);

      // 行程 D1 指定天
      const dayItinMatch = normalizedInput.match(/^行程\s*[Dd](\d+)$/);
      if (dayItinMatch) return await this.itinerary.showDayItinerary(groupId, parseInt(dayItinMatch[1], 10));

      // 刪除景點 #N
      const delSpotMatch = normalizedInput.match(/^[刪删]除景點\s*#(\d+)$/);
      if (delSpotMatch) return await this.itinerary.deleteSpot(groupId, parseInt(delSpotMatch[1], 10));

      // ─── 班機指令 ────────────────────────────────────────────────────────────────
      if (input === '班機資訊') return await this.itinerary.showFlights(groupId);
      if (input === '班機 去程') return await this.itinerary.startFlightWizard(groupId, userId, 'outbound');
      if (input === '班機 回程') return await this.itinerary.startFlightWizard(groupId, userId, 'return');
      if (input === '刪除班機') return await this.itinerary.startDeleteFlightWizard(groupId, userId);
      if (input === '刪除班機 去程') return await this.itinerary.deleteFlight(groupId, 'outbound');
      if (input === '刪除班機 回程') return await this.itinerary.deleteFlight(groupId, 'return');

      const deleteMatch = normalizedInput.match(/^刪除\s*#(\d+)\s*$/);
      if (deleteMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        return await this.wizard.startDeleteWizard(groupId, userId, parseInt(deleteMatch[1], 10));
      }

      // 修改 #N → 詢問要改什麼
      const modifySelectMatch = normalizedInput.match(/^修改\s*#(\d+)\s*$/);
      if (modifySelectMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        await this.crud.deleteSession(userId); // 清除可能殘留的舊 session
        return await this.wizard.startModifyFieldSelect(groupId, userId, parseInt(modifySelectMatch[1], 10));
      }

      // 修改金額 #N 100（含金額直接改）或 修改金額 #N（啟動 wizard）
      const updateAmountMatch = normalizedInput.match(/^修改金額\s*#(\d+)\s+([\d,]+(?:\.\d+)?)\s*$/);
      if (updateAmountMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        const seq = parseInt(updateAmountMatch[1], 10);
        const amount = parseFloat(updateAmountMatch[2].replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) return '金額格式錯誤，請輸入大於 0 的數字。';
        return await this.expense.updateExpense(groupId, seq, amount, displayName);
      }
      const updateAmountNoValMatch = normalizedInput.match(/^修改金額\s*#(\d+)\s*$/);
      if (updateAmountNoValMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        await this.crud.deleteSession(userId);
        return await this.wizard.startModifyAmountWizard(groupId, userId, parseInt(updateAmountNoValMatch[1], 10));
      }

      // 修改幣別 #N JPY（含幣別直接改）或 修改幣別 #N（啟動 wizard）
      // 用 \S+ 而非 .+ 避免捕捉到尾部空白
      const updateCurrencyMatch = normalizedInput.match(/^修改幣別\s*#(\d+)\s+(\S+)\s*$/);
      if (updateCurrencyMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        const seq = parseInt(updateCurrencyMatch[1], 10);
        const currency = resolveCurrency(updateCurrencyMatch[2]);
        if (!currency) return `「${updateCurrencyMatch[2]}」無法辨識，請使用如 TWD、JPY、美金 等格式。`;
        return await this.expense.updateExpenseCurrency(groupId, seq, currency, displayName);
      }
      const updateCurrencyNoValMatch = normalizedInput.match(/^修改幣別\s*#(\d+)\s*$/);
      if (updateCurrencyNoValMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        await this.crud.deleteSession(userId);
        return await this.wizard.startModifyCurrencyWizard(groupId, userId, parseInt(updateCurrencyNoValMatch[1], 10));
      }

      // 修改支付人 #N
      const updatePayerMatch = normalizedInput.match(/^修改支付人\s*#(\d+)\s*$/);
      if (updatePayerMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        await this.crud.deleteSession(userId);
        return await this.wizard.startModifyPayerWizard(groupId, userId, parseInt(updatePayerMatch[1], 10));
      }

      // 修改分攤人 #N
      const updateSharersMatch = normalizedInput.match(/^修改分攤人\s*#(\d+)\s*$/);
      if (updateSharersMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        await this.crud.deleteSession(userId);
        return await this.wizard.startModifySharersWizard(groupId, userId, parseInt(updateSharersMatch[1], 10));
      }

      if (input === '修改') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        return await this.wizard.startModifyWizard(groupId, userId);
      }

      if (input === '刪除') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        return await this.wizard.startDeleteWizard(groupId, userId);
      }

      // ── 完整模板格式：名稱：xx　金額：xx　幣別：xx　支付者：xx　分攤人：xx ──
      const tmpl = parseTemplateExpense(input);
      if (tmpl) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';

        // 有格式錯誤即回報
        if (tmpl.errors) return `記帳格式有誤，請檢查：\n${tmpl.errors.join('\n')}`;

        if (!tmpl.description || !tmpl.amount) return '記帳格式錯誤，請檢查名稱與金額。';

        // 解析付款人（支持「我」、@前綴、直接名字）
        let payerUserId = userId;
        let payerName = displayName;
        if (tmpl.payerName) {
          const cleanPayer = tmpl.payerName.replace(/^@/, '').trim();
          if (cleanPayer === '我') {
            // 保持預設（發訊者）
          } else {
            const payerMember = await this.crud.getMemberByDisplayName(groupId, cleanPayer);
            if (payerMember) { payerUserId = payerMember.user_id; payerName = payerMember.display_name; }
            else return `找不到付款人「${cleanPayer}」，請確認成員名稱。`;
          }
        }

        // 分攤人中的「我」替換為發訊者
        let sharers = tmpl.sharers;
        if (sharers) {
          sharers = sharers.map(s => (s === '我' ? displayName : s));
        }

        // 解析幣別
        let currency = 'TWD';
        if (tmpl.currency) {
          const resolved = resolveCurrency(tmpl.currency);
          if (!resolved) return `【幣別】「${tmpl.currency}」無法辨識，請使用如 TWD、JPY、USD 等格式。`;
          currency = resolved;
        }
        let amt = tmpl.amount;
        let originalAmount: number | undefined;
        if (currency !== 'TWD') {
          const rate = await this.crud.getExchangeRate(currency);
          if (rate) { originalAmount = amt; amt = Math.round(amt * rate * 100) / 100; }
          else return `無法取得 ${currency} 對 TWD 的化率，請改使用 TWD 或稍後再試。`;
        }

        return await this.expense.addExpense(
          groupId, payerUserId, payerName,
          tmpl.description, amt,
          sharers, currency, originalAmount,
          (mentionMap as unknown as Record<string, string>) ?? {}
        );
      }

      // ── 簡易格式：記帳 晚餐 500 ──
      const expenseMatch = input.match(/^記帳\s+(.+?)\s+([\d,]+(?:\.\d+)?)$/);
      if (expenseMatch) {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        const description = expenseMatch[1].trim();
        const amount = parseFloat(expenseMatch[2].replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) return '金額格式錯誤。';
        return await this.expense.addExpense(groupId, userId, displayName, description, amount, mentionMap);
      }
    } catch (e) {
      console.error('[MainAgent] processMessage error:', e);
      return '抱歉，處理您的訊息時發生錯誤。';
    }

    return null;
  }

  async processPostback(groupId: string, userId: string, displayName: string, data: string): Promise<string | messagingApi.Message | null> {
    const maintenance = await this.crud.isMaintenanceMode();
    if (maintenance && userId !== this.env.ADMIN_LINE_USER_ID) return null;

    try {
      await this.member.ensureMember(groupId, userId, displayName);
      const member = await this.crud.getMember(groupId, userId);
      const isParticipating = member?.is_participating === 1;
      const params = new URLSearchParams(data);
      const action = params.get('action');

      if (action === 'menu_main') {
        return {
          type: 'text',
          text: '有什麼需要幫忙的嗎？🐶',
          quickReply: getMainMenuQuickReply()
        };
      }

      if (action === 'menu_accounting') {
        return {
          type: 'text',
          text: '💰 記帳功能',
          quickReply: getAccountingQuickReply()
        };
      }

      if (action === 'menu_itinerary') {
        return {
          type: 'text',
          text: '🗺️ 行程功能',
          quickReply: getItineraryQuickReply()
        };
      }

      if (action === 'start_add') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        const trip = await this.crud.getCurrentTrip(groupId);
        if (!trip) return await this.wizard.startTripNaming(groupId, userId);
        return await this.wizard.start(groupId, userId);
      }

      if (action === 'start_edit') {
        if (!isParticipating) return '你還沒加入分帳喔，請先輸入「加入」！';
        return await this.wizard.startModifyWizard(groupId, userId);
      }

      const cmd = params.get('cmd');
      if (cmd) {
        return await this.processMessage(groupId, userId, displayName, cmd);
      }

      const session = await this.crud.getSession(userId);
      if (session) {
        return await this.wizard.handlePostback(session, data, displayName);
      }
    } catch (e) {
      console.error('[MainAgent] processPostback error:', e);
      return '處理按鈕點擊時發生錯誤。';
    }

    return null;
  }
}
