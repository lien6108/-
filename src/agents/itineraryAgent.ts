import { messagingApi } from '@line/bot-sdk';
import { CRUD, ItinerarySpot, FlightInfo, Accommodation } from '../db/crud';
import { getCancelQuickReply } from '../utils/ui';

// 解析一行 AI 輸出：D1 景點名稱 [| maps_url]
function parseLine(line: string): { day: number; name: string; mapsUrl?: string } | null {
  const m = line.trim().match(/^[Dd](\d+)\s+([^|]+?)(?:\s*\|\s*(https?:\/\/\S+))?$/);
  if (!m) return null;
  return {
    day: parseInt(m[1], 10),
    name: m[2].trim(),
    mapsUrl: m[3]?.trim(),
  };
}

export class ItineraryAgent {
  constructor(private crud: CRUD) {}

  // ─── 顯示給使用者複製的 AI 提示詞，並進入等待匯入狀態 ─────────────────────
  // ─── 新增行程：先讓使用者選方式 ──────────────────────────────────────────
  async showAIPrompt(groupId: string, userId: string): Promise<messagingApi.Message> {
    return {
      type: 'text',
      text: '🗺️ 請選擇新增行程的方式：\n\n🤖 AI 規劃\n讓 AI 根據班機、住宿資訊幫你安排最順的路線\n\n📋 轉換格式\n你已有規劃，讓 AI 幫你轉換成系統格式',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '🤖 AI 規劃', data: 'cmd=行程 AI規劃' } },
          { type: 'action', action: { type: 'postback', label: '📋 轉換格式', data: 'cmd=行程 轉換格式' } },
          { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
        ]
      }
    };
  }

  // ─── AI 規劃：組出含班機/住宿 context 的 prompt ────────────────────────────
  async showAIPlanPrompt(groupId: string, userId: string): Promise<messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    const tripName = trip?.trip_name || '旅程';

    await this.crud.upsertSession(userId, groupId, 'AWAITING_ITINERARY_IMPORT', '{}');

    // 讀取班機與住宿
    let flightContext = '';
    let accommodationContext = '';
    let daysHint = '';

    if (trip) {
      const flights = await this.crud.getFlights(trip.id);
      const outbounds = flights.filter(f => f.type === 'outbound').sort((a, b) => a.depart_date.localeCompare(b.depart_date) || a.depart_time.localeCompare(b.depart_time));
      const returns = flights.filter(f => f.type === 'return').sort((a, b) => a.depart_date.localeCompare(b.depart_date) || a.depart_time.localeCompare(b.depart_time));

      if (outbounds.length > 0) {
        const first = outbounds[0];
        const last = outbounds[outbounds.length - 1];
        const dept = first.depart_airport ? `${first.depart_airport} ` : '';
        const arr = last.arrive_airport ? `→ ${last.arrive_airport} ` : '';
        flightContext += `去程：${first.depart_date} ${dept}${first.depart_time} ${arr}抵達 ${last.arrive_time}${outbounds.length > 1 ? `（含 ${outbounds.length - 1} 次轉機）` : first.flight_no ? `（${first.flight_no}）` : ''}\n`;
      }
      if (returns.length > 0) {
        const first = returns[0];
        const last = returns[returns.length - 1];
        const dept = first.depart_airport ? `${first.depart_airport} ` : '';
        const arr = last.arrive_airport ? `→ ${last.arrive_airport} ` : '';
        flightContext += `回程：${first.depart_date} ${dept}${first.depart_time} ${arr}抵達 ${last.arrive_time}${returns.length > 1 ? `（含 ${returns.length - 1} 次轉機）` : first.flight_no ? `（${first.flight_no}）` : ''}\n`;
      }

      const accoms = await this.crud.getAccommodations(trip.id);
      if (accoms.length > 0) {
        const maxDay = Math.max(...accoms.map(a => a.day_to));
        daysHint = `${maxDay + 1}天${maxDay}夜`;
        for (const a of accoms) {
          const range = a.day_from === a.day_to ? `D${a.day_from}` : `D${a.day_from}-D${a.day_to}`;
          const ci = a.checkin_time ? ` 入住${a.checkin_time}` : '';
          const co = a.checkout_time ? ` 退房${a.checkout_time}` : '';
          const who = a.who ? `（${a.who}）` : '';
          accommodationContext += `${range}：${a.name}${ci}${co}${who}\n`;
        }
      }
    }

    // 組 context 區段
    let contextBlock = '';
    if (flightContext || accommodationContext) {
      contextBlock += '\n\n【旅程資訊】\n';
      if (flightContext) contextBlock += flightContext;
      if (accommodationContext) contextBlock += '住宿：\n' + accommodationContext;
      contextBlock +=
        '\n【規劃原則】\n' +
        '1. 第一天根據去程班機抵達時間安排，抵達前不排景點\n' +
        '2. 最後一天根據回程班機出發時間安排，需預留前往機場的交通時間（至少2小時前）\n' +
        '3. 每天路線從當晚住宿地點附近出發，最終回到當晚住宿地點附近\n' +
        '4. 如同天更換飯店，下午行程安排在新飯店附近\n' +
        '5. 入住／退房時間前後的景點需安排在飯店附近\n' +
        '6. 每個景點都必須附上 Google Maps 連結（住宿地點除外）';
    }

    const prompt =
      `幫我規劃【${tripName}】${daysHint ? daysHint : ''}的旅遊行程，每天3-5個景點，路線要最順（減少重複移動）。${contextBlock}\n\n` +
      `========== 以下格式請勿修改 ==========\n` +
      `請按以下格式輸出，不要多餘說明，每個景點一行：\n` +
      `D1 景點名稱 | google map對應連結\n` +
      `D1 另一個景點 | google map對應連結\n` +
      `D2 景點名稱 | google map對應連結\n` +
      `（每個景點都必須附 Google Maps 連結；住宿地點不需要輸出）\n` +
      `======================================`;

    const intro: messagingApi.Message = {
      type: 'text',
      text:
        `🤖 AI 行程規劃\n\n` +
        `請複製下方指令，貼到 ChatGPT 或 Gemini，生成後再貼回群組。\n\n` +
        `📝 【 】內的資訊可以自行修改\n` +
        `⚠️ 格式區段（=== 以下格式請勿修改 === 至 ====== 之間）切勿調整，否則可能導致匯入失敗\n\n` +
        `貼回後將直接匯入，若需先確認請點「取消」。`,
      quickReply: getCancelQuickReply()
    };

    const command: messagingApi.Message = {
      type: 'text',
      text: prompt,
      quickReply: getCancelQuickReply()
    };

    return [intro, command];
  }

  // ─── 轉換格式：給使用者格式轉換 prompt ────────────────────────────────────
  async showConvertPrompt(groupId: string, userId: string): Promise<messagingApi.Message[]> {
    await this.crud.upsertSession(userId, groupId, 'AWAITING_ITINERARY_IMPORT', '{}');

    const intro: messagingApi.Message = {
      type: 'text',
      text:
        `📋 行程格式轉換\n\n` +
        `請複製下方指令，貼到 ChatGPT 或 Gemini，\n` +
        `再把你自己的行程計畫貼在指令後面，讓 AI 轉換格式後再貼回群組。\n\n` +
        `⚠️ 貼回後將直接匯入，若需先確認請點「取消」。`,
      quickReply: getCancelQuickReply()
    };

    const command: messagingApi.Message = {
      type: 'text',
      text:
        `請將以下行程轉換成指定格式，不要多餘說明，每個景點一行：\n\n` +
        `格式規則：\n` +
        `• D1、D2... 代表第幾天\n` +
        `• 每行：D天數 景點名稱（可加 | Google Maps 連結）\n` +
        `• 同一天多個景點請分多行\n\n` +
        `輸出範例：\n` +
        `D1 淺草寺 | https://maps.app.goo.gl/xxx\n` +
        `D1 上野公園\n` +
        `D2 新宿御苑\n\n` +
        `--- 以下是我的行程 ---\n` +
        `（請在此貼上你的行程）`,
      quickReply: getCancelQuickReply()
    };

    return [intro, command];
  }

  // ─── 解析 AI 貼回的文字，批次匯入景點 ────────────────────────────────────
  async importSpots(groupId: string, text: string): Promise<string | messagingApi.Message | messagingApi.Message[] | null> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程，請先輸入「開始記帳」建立旅程 🗺️';

    const lines = text.split('\n');
    const valid: { day: number; name: string; mapsUrl?: string }[] = [];
    const skipped: string[] = [];

    lines.forEach((line) => {
      if (!line.trim()) return;
      const parsed = parseLine(line);
      if (parsed) valid.push(parsed);
      else skipped.push(line.trim());
    });

    if (valid.length === 0) return null;

    for (const spot of valid) {
      await this.crud.addSpot(trip.id, spot.day, spot.name, spot.mapsUrl);
    }

    const days = [...new Set(valid.map(v => v.day))].sort((a, b) => a - b);
    const skippedNote = skipped.length > 0
      ? `\n\n⚠️ 以下 ${skipped.length} 行格式不符已略過：\n${skipped.slice(0, 5).map(l => `• ${l}`).join('\n')}${skipped.length > 5 ? '\n...' : ''}`
      : '';

    const successMsg: messagingApi.Message = {
      type: 'text',
      text: `✅ 已匯入 ${valid.length} 個景點，共 ${days.length} 天${skippedNote}`,
    };

    // 補上住宿位置連結（有填寫 maps_url 才顯示）
    const accomList = await this.crud.getAccommodations(trip.id);
    const accomWithUrl = accomList.filter(a => a.maps_url &&
      days.some(d => d >= a.day_from && d <= a.day_to)
    );
    const messages: messagingApi.Message[] = [successMsg];
    if (accomWithUrl.length > 0) {
      const lines = accomWithUrl.map(a => {
        const range = a.day_from === a.day_to ? `D${a.day_from}` : `D${a.day_from}-D${a.day_to}`;
        return `${range} 🏨 ${a.name}\n${a.maps_url}`;
      });
      messages.push({
        type: 'text',
        text: `🏨 住宿位置連結：\n\n${lines.join('\n\n')}`,
      });
    }

    const carousel = await this.showDayItinerary(groupId);
    messages.push(carousel as messagingApi.Message);
    return messages;
  }

  // ─── 建立單天 bubble ──────────────────────────────────────────────────────
  private buildDayBubble(tripName: string, day: number, daySpots: ItinerarySpot[]): any {
    const rows: any[] = daySpots.map((s, idx) => {
      // 第一行：序號 + 名稱
      const nameRow: any = {
        type: 'box', layout: 'horizontal', margin: idx === 0 ? 'none' : 'md',
        contents: [
          { type: 'text', text: `${idx + 1}.`, size: 'xs', color: '#7a9aaa', flex: 0 },
          { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, color: '#333333', weight: 'bold', margin: 'sm' }
        ]
      };

      // 第二行：操作按鈕（各佔 flex:1，避免 flex:0 導致 LINE API 拒絕）
      const btnContents: any[] = [];
      if (idx > 0) {
        btnContents.push({ type: 'button', action: { type: 'postback', label: '↑ 上移', data: `cmd=上移景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 1 });
      }
      if (idx < daySpots.length - 1) {
        btnContents.push({ type: 'button', action: { type: 'postback', label: '↓ 下移', data: `cmd=下移景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 1 });
      }
      if (s.maps_url) {
        btnContents.push({ type: 'button', action: { type: 'uri', label: '🗺️ 導航', uri: s.maps_url }, style: 'secondary', height: 'sm', flex: 1 });
      }
      btnContents.push({ type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 1 });

      return {
        type: 'box', layout: 'vertical',
        contents: [
          nameRow,
          { type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'xs', contents: btnContents }
        ]
      };
    });

    return {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#7a8898', paddingAll: 'lg',
        contents: [
          { type: 'text', text: `🗺️ ${tripName}`, size: 'xs', color: '#cccccc' },
          { type: 'text', text: `第 ${day} 天`, weight: 'bold', color: '#ffffff', size: 'xl', margin: 'xs' },
          { type: 'text', text: `共 ${daySpots.length} 個景點`, size: 'xs', color: '#cccccc', margin: 'xs' }
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'button', action: { type: 'postback', label: '＋ 新增景點', data: `cmd=新增景點 D${day}` }, style: 'primary', height: 'sm', color: '#7a9aaa' }
        ]
      }
    };
  }

  // ─── 顯示所有天行程（純文字版，避免 Flex 格式問題）───────────────────────
  async showDayItinerary(groupId: string, day?: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const spots = await this.crud.getAllSpots(trip.id);
    if (spots.length === 0) {
      return '目前沒有行程景點。\n\n輸入「新增旅遊行程」取得 AI 提示詞來匯入行程。';
    }

    const byDay = new Map<number, ItinerarySpot[]>();
    for (const s of spots) {
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day)!.push(s);
    }

    let days = [...byDay.keys()].sort((a, b) => a - b);
    if (day && byDay.has(day)) {
      days = [day, ...days.filter(d => d !== day)];
    }

    const lines: string[] = [`🗺️ ${trip.trip_name} 行程\n`];
    for (const d of days) {
      const daySpots = byDay.get(d)!;
      lines.push(`【第 ${d} 天】`);
      daySpots.forEach((s, i) => {
        const nav = s.maps_url ? ` 📍` : '';
        lines.push(`${i + 1}. ${s.name}${nav}`);
        if (s.maps_url) lines.push(`   ${s.maps_url}`);
      });
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  // ─── showFullItinerary 直接呼叫 showDayItinerary（從第一天開始）────────────
  async showFullItinerary(groupId: string): Promise<string | messagingApi.Message> {
    return this.showDayItinerary(groupId);
  }

  // ─── 刪除景點 ─────────────────────────────────────────────────────────────
  async moveSpot(groupId: string, spotId: number, direction: 'up' | 'down'): Promise<messagingApi.Message | messagingApi.Message[] | string> {
    await this.crud.moveSpot(spotId, direction);
    return await this.showDayItinerary(groupId);
  }

  async deleteSpot(groupId: string, spotId: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    await this.crud.deleteSpot(spotId);
    return await this.showDayItinerary(groupId);
  }

  // ─── 新增單筆景點：啟動 wizard ─────────────────────────────────────────────
  async startAddSpotWizard(groupId: string, userId: string, day: number): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, 'AWAITING_SPOT_INPUT', JSON.stringify({ day }));
    return {
      type: 'text',
      text: `請輸入第 ${day} 天新景點：\n\n格式：景點名稱 [| 地圖連結]\n\n範例：\n淺草寺\n新宿御苑 | https://maps.app.goo.gl/xxx`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 新增單筆景點：解析並儲存 ─────────────────────────────────────────────
  async handleAddSpotInput(groupId: string, text: string, day: number): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const [name, mapsUrl] = text.split('|').map(s => s.trim());
    if (!name) return null as any;
    await this.crud.addSpot(trip.id, day, name, mapsUrl || undefined);
    const successMsg: messagingApi.Message = { type: 'text', text: `✅ 已新增景點：${name}（第 ${day} 天）` };
    const carousel = await this.showDayItinerary(groupId, day);
    return [successMsg, carousel as messagingApi.Message];
  }

  // ─── 清空行程：確認提示 ────────────────────────────────────────────────────
  async promptClearAllSpots(groupId: string): Promise<messagingApi.Message> {
    return {
      type: 'text',
      text: '⚠️ 確定要清空所有行程景點嗎？此操作無法復原。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '✅ 確認清空', data: 'cmd=確認清空行程' } },
          { type: 'action', action: { type: 'postback', label: '❌ 取消', data: 'cmd=取消' } },
        ]
      }
    };
  }

  // ─── 清空行程：執行 ────────────────────────────────────────────────────────
  async confirmClearAllSpots(groupId: string): Promise<messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return { type: 'text', text: '目前沒有進行中的旅程 🗺️' };
    await this.crud.clearAllSpots(trip.id);
    return {
      type: 'text',
      text: '🗑️ 已清空所有行程。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '新增旅遊行程', data: 'cmd=新增旅遊行程' } },
        ]
      }
    };
  }

  // ─── 偵測貼入文字是否為 AI 行程格式（≥2 行符合 D\d 格式）────────────────
  static isAIItineraryFormat(text: string): boolean {
    const lines = text.split('\n').filter(l => l.trim());
    const matches = lines.filter(l => /^[Dd]\d+\s+.+/.test(l.trim()));
    return matches.length >= 2;
  }

  // ─── 班機輸入解析（tokenizer 方式，支援機場代碼）──────────────────────────
  private parseFlightInput(text: string): {
    departDate: string; departTime: string; arriveTime: string;
    flightNo?: string; departAirport?: string; arriveAirport?: string;
  } | null {
    const parts = text.trim().split(/\s+/);
    let i = 0;
    const isTime = (s: string) => /^\d{2}:\d{2}$/.test(s);
    const isDate = (s: string) => /^(\d{4}\/)?\d{1,2}\/\d{1,2}$/.test(s);
    const isArrow = (s: string) => /^[→>\-]$/.test(s);
    const isTerminal = (s: string) => /^T\d+$/i.test(s);
    // 機場：非時間、非日期、非箭頭，且後面緊接時間（可能中間夾一個航廈 token，如 T1）
    const isAirport = (idx: number) => {
      const s = parts[idx] || '';
      if (isTime(s) || isDate(s) || isArrow(s)) return false;
      const next = parts[idx + 1] || '';
      return isTime(next) || (isTerminal(next) && isTime(parts[idx + 2] || ''));
    };
    // 讀取機場（含可選航廈），回傳合併字串並推進 i
    const readAirport = (): string => {
      let name = parts[i++];
      if (isTerminal(parts[i] || '')) name += ' ' + parts[i++];
      return name;
    };
    const normalizeDate = (s: string) => {
      if (/^\d{4}\//.test(s)) return s;
      return `${new Date().getFullYear()}/${s}`;
    };

    if (!isDate(parts[i] || '')) return null;
    const departDate = normalizeDate(parts[i++]);

    let departAirport: string | undefined;
    if (isAirport(i)) departAirport = readAirport();

    if (!isTime(parts[i] || '')) return null;
    const departTime = parts[i++];

    if (i < parts.length && isArrow(parts[i])) i++;

    let arriveAirport: string | undefined;
    if (isAirport(i)) arriveAirport = readAirport();

    if (!isTime(parts[i] || '')) return null;
    const arriveTime = parts[i++];

    const flightNo = i < parts.length ? parts.slice(i).join(' ') : undefined;
    return { departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport };
  }

  // ─── 班機資訊：啟動 wizard ─────────────────────────────────────────────────
  async startFlightWizard(groupId: string, userId: string, flightType: 'outbound' | 'return', addedByName?: string): Promise<messagingApi.Message> {
    const typeLabel = flightType === 'outbound' ? '去程' : '回程';
    await this.crud.upsertSession(userId, groupId, 'AWAITING_FLIGHT_INPUT', JSON.stringify({ flightType, addedByName: addedByName || '' }));
    return {
      type: 'text',
      text:
        `請輸入${typeLabel}班機資訊（有轉機可一次貼多行，每行一段）：\n\n` +
        `格式：日期 [機場 航廈] 出發時間 → [機場 航廈] 抵達時間 [航班號]\n\n` +
        `範例（直飛）：\n` +
        `2026/5/10 桃園 T1 08:30 → 東京成田 13:45 CI-100\n\n` +
        `範例（轉機，一次貼兩行）：\n` +
        `2026/5/10 桃園 T1 08:30 → 香港 T1 10:30 CX456\n` +
        `2026/5/10 香港 T1 12:00 → 東京成田 17:00 CX102\n\n` +
        `（機場、航廈和航班號均為選填；日期可略去年份，系統自動補上）`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 班機資訊：解析輸入並儲存 ─────────────────────────────────────────────
  async handleFlightInput(groupId: string, text: string, flightType: 'outbound' | 'return', addedByName?: string): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const typeLabel = flightType === 'outbound' ? '去程' : '回程';

    const successes: string[] = [];
    const failures: string[] = [];

    for (const line of lines) {
      const parsed = this.parseFlightInput(line);
      if (!parsed) {
        failures.push(line);
        continue;
      }
      const { departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport } = parsed;
      await this.crud.addFlight(trip.id, flightType, departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport, addedByName);
      const routeText = departAirport && arriveAirport ? ` ${departAirport}→${arriveAirport}` : '';
      successes.push(`${departDate} ${departTime}→${arriveTime}${routeText}${flightNo ? `（${flightNo}）` : ''}`);
    }

    if (successes.length === 0) {
      return {
        type: 'text',
        text: `格式不符，請重新輸入。\n\n每行一筆，例：\n5/10 桃園 T1 08:30 → 香港 T1 10:30 CX456\n5/10 香港 T1 12:00 → 東京成田 17:00 CX102`,
        quickReply: getCancelQuickReply()
      };
    }

    const failNote = failures.length > 0
      ? `\n\n⚠️ 以下 ${failures.length} 行格式不符已略過：\n${failures.map(l => `• ${l}`).join('\n')}`
      : '';
    const successMsg: messagingApi.Message = {
      type: 'text',
      text: `✅ 已新增 ${successes.length} 筆${typeLabel}班機：\n${successes.map(s => `• ${s}`).join('\n')}${failNote}`
    };
    const flexMsg = await this.showFlights(groupId);
    return [successMsg, flexMsg as messagingApi.Message];
  }

  // ─── 班機資訊：顯示 Flex（支援多筆、每筆有刪除鈕）─────────────────────────
  async showFlights(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const flights = await this.crud.getFlights(trip.id);
    const outbounds = flights.filter(f => f.type === 'outbound');
    const returns = flights.filter(f => f.type === 'return');

    // 尚無任何班機 → 顯示輸入說明
    if (outbounds.length === 0 && returns.length === 0) {
      return {
        type: 'text',
        text: '✈️ 目前尚未設定班機資訊。\n\n請選擇要新增的方向：',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '新增去程', data: 'cmd=班機 去程' } },
            { type: 'action', action: { type: 'postback', label: '新增回程', data: 'cmd=班機 回程' } },
            { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
          ]
        }
      };
    }

    const buildFlightRow = (f: FlightInfo): any => {
      // 頂列：航班號（左）＋刪除按鈕（右）
      const topRow: any = {
        type: 'box', layout: 'horizontal', contents: [
          {
            type: 'text',
            text: [f.flight_no, f.depart_date].filter(Boolean).join('  '),
            size: 'sm', weight: 'bold', color: '#333333', flex: 1
          },
          { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除班機 #${f.id}` }, style: 'secondary', height: 'sm', flex: 0 }
        ]
      };

      // 路線列：出發（左）→ 到達（右）
      const departCol: any = {
        type: 'box', layout: 'vertical', flex: 1, contents: [
          { type: 'text', text: f.depart_airport || '─', size: 'sm', weight: 'bold', color: '#444444' },
          { type: 'text', text: f.depart_time, size: 'lg', weight: 'bold', color: '#222222', margin: 'xs' },
        ]
      };
      const arrowCol: any = {
        type: 'text', text: '→', size: 'md', color: '#aaaaaa', align: 'center',
        gravity: 'center', flex: 0, margin: 'md'
      };
      const arriveCol: any = {
        type: 'box', layout: 'vertical', flex: 1, contents: [
          { type: 'text', text: f.arrive_airport || '─', size: 'sm', weight: 'bold', color: '#444444', align: 'end' },
          { type: 'text', text: f.arrive_time, size: 'lg', weight: 'bold', color: '#222222', margin: 'xs', align: 'end' },
        ]
      };
      const routeRow: any = {
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [departCol, arrowCol, arriveCol]
      };

      // 底列：新增者
      const bottomContents: any[] = [];
      if (f.added_by_name) {
        bottomContents.push({ type: 'text', text: `由 ${f.added_by_name} 新增`, size: 'xs', color: '#aaaaaa', margin: 'xs' });
      }

      return {
        type: 'box', layout: 'vertical', margin: 'md',
        contents: [topRow, routeRow, ...bottomContents]
      };
    };

    const buildSection = (label: string, list: FlightInfo[], emptyText: string): any[] => {
      const header = { type: 'text', text: label, size: 'sm', weight: 'bold', color: '#6b7f8c', margin: 'lg' };
      const sep = { type: 'separator', margin: 'sm' };
      if (list.length === 0) {
        return [header, sep, { type: 'text', text: emptyText, size: 'sm', color: '#bbbbbb', margin: 'sm' }];
      }
      const rows: any[] = [];
      list.forEach((f, idx) => {
        if (idx > 0) rows.push({ type: 'separator', margin: 'md' });
        rows.push(buildFlightRow(f));
      });
      return [header, sep, ...rows];
    };

    const bodyContents: any[] = [
      ...buildSection('✈️ 去程', outbounds, '尚未設定'),
      ...buildSection('🛬 回程', returns, '尚未設定'),
    ];

    return {
      type: 'flex', altText: '班機資訊',
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#6b7f8c',
          contents: [
            { type: 'text', text: `✈️ ${trip.trip_name}`, weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: '班機資訊', size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: bodyContents },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'postback', label: '新增去程', data: 'cmd=班機 去程' }, style: 'primary', height: 'sm', flex: 1, color: '#7a9aaa' },
            { type: 'button', action: { type: 'postback', label: '新增回程', data: 'cmd=班機 回程' }, style: 'primary', height: 'sm', flex: 1, color: '#7a9aaa' },
          ]
        }
      }
    } as any;
  }

  async deleteFlightById(groupId: string, flightId: number): Promise<string | messagingApi.Message> {
    await this.crud.deleteFlightById(flightId);
    return this.showFlights(groupId);
  }

  // ─── 住宿資訊：顯示 ────────────────────────────────────────────────────────
  async showAccommodations(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const list = await this.crud.getAccommodations(trip.id);

    if (list.length === 0) {
      return {
        type: 'text',
        text: `「${trip.trip_name}」還沒有住宿資訊！`,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '＋ 新增住宿', data: 'cmd=新增住宿' } },
            { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
          ]
        }
      } as messagingApi.Message;
    }

    const body: any[] = [];
    list.forEach((a, i) => {
      if (i > 0) body.push({ type: 'separator', margin: 'md' });

      const nights = a.day_to - a.day_from + 1;
      const dayLabel = a.day_from === a.day_to
        ? `D${a.day_from}（1晚）`
        : `D${a.day_from} - D${a.day_to}（${nights}晚）`;
      const whoLabel = a.who ? a.who : '全員';
      const timeLabel = (a.checkin_time || a.checkout_time)
        ? `入住 ${a.checkin_time || '--:--'}  ·  退房 ${a.checkout_time || '--:--'}`
        : null;

      const rowContents: any[] = [
        {
          type: 'box', layout: 'horizontal', margin: i === 0 ? 'none' : 'md',
          contents: [
            { type: 'text', text: a.name, size: 'sm', weight: 'bold', color: '#333333', flex: 1, wrap: true },
            { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除住宿 #${a.id}` }, style: 'secondary', height: 'sm', flex: 0 }
          ]
        },
        { type: 'text', text: `${dayLabel}  ·  ${whoLabel}`, size: 'xs', color: '#888888', margin: 'xs' },
      ];
      if (timeLabel) {
        rowContents.push({ type: 'text', text: timeLabel, size: 'xs', color: '#7a9aaa', margin: 'none' });
      }
      if (a.added_by_name) {
        rowContents.push({ type: 'text', text: `由 ${a.added_by_name} 新增`, size: 'xs', color: '#bbbbbb', margin: 'none' });
      }
      if (a.maps_url) {
        rowContents.push({
          type: 'button',
          action: { type: 'uri', label: '🗺️ 導航', uri: a.maps_url },
          style: 'secondary', height: 'sm', margin: 'xs'
        });
      }

      body.push({ type: 'box', layout: 'vertical', contents: rowContents, margin: 'md' });
    });

    return {
      type: 'flex', altText: '住宿資訊',
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8898',
          contents: [
            { type: 'text', text: `🏨 ${trip.trip_name}`, weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: '住宿資訊', size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: body },
        footer: {
          type: 'box', layout: 'vertical',
          contents: [
            { type: 'button', action: { type: 'postback', label: '＋ 新增住宿', data: 'cmd=新增住宿' }, style: 'primary', height: 'sm', color: '#7a9aaa' }
          ]
        }
      }
    } as any;
  }

  // ─── 住宿資訊：啟動 wizard ─────────────────────────────────────────────────
  async startAccommodationWizard(groupId: string, userId: string, addedByName?: string): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, 'AWAITING_ACCOMMODATION_INPUT', JSON.stringify({ addedByName: addedByName || '' }));
    return {
      type: 'text',
      text:
        `請輸入住宿資訊：\n\n` +
        `格式：D開始天[-結束天] 飯店名稱 [check-in-check-out] [/ Maps連結] [@誰]\n\n` +
        `範例：\n` +
        `D1-D3 台北凱撒大飯店 15:00-11:00 / https://maps.app.goo.gl/xxx\n` +
        `D4 大阪難波飯店 14:00-12:00 @Alice\n` +
        `D4-D5 京都旅館 @Bob @Carol\n\n` +
        `（時間、Maps連結和@誰均為選填）`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 住宿資訊：解析並儲存 ─────────────────────────────────────────────────
  async handleAccommodationInput(groupId: string, text: string, addedByName?: string): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    // 格式：D1[-D3] 名稱 [HH:MM-HH:MM] [/ maps] [@who...]
    const m = text.trim().match(/^[Dd](\d+)(?:-[Dd](\d+))?\s+([^/@\d:]+?)(?:\s+(\d{2}:\d{2})-(\d{2}:\d{2}))?(?:\s*\/\s*(https?:\/\/\S+))?(?:\s+((?:@\S+\s*)+))?$/);
    if (!m) {
      return {
        type: 'text',
        text: '格式不符，請重新輸入：\n格式：D開始天[-結束天] 飯店名稱 [check-in-check-out] [/ Maps連結] [@誰]\n例：D1-D3 台北凱撒大飯店 15:00-11:00 / https://maps.app.goo.gl/xxx',
        quickReply: getCancelQuickReply()
      };
    }
    const dayFrom = parseInt(m[1], 10);
    const dayTo = m[2] ? parseInt(m[2], 10) : dayFrom;
    const name = m[3].trim();
    const checkinTime = m[4]?.trim();
    const checkoutTime = m[5]?.trim();
    const mapsUrl = m[6]?.trim();
    const whoRaw = m[7]?.trim();
    const who = whoRaw ? whoRaw.split(/\s+/).map(w => w.replace(/^@/, '')).join('、') : undefined;

    await this.crud.addAccommodation(trip.id, dayFrom, dayTo, name, checkinTime, checkoutTime, mapsUrl, who, addedByName);
    const nights = dayTo - dayFrom + 1;
    const nightLabel = nights === 1 ? '1晚' : `${nights}晚`;
    const whoLabel = who ? `（${who}）` : '';
    const successMsg: messagingApi.Message = { type: 'text', text: `✅ 已新增住宿：${name}，D${dayFrom}${dayTo !== dayFrom ? `-D${dayTo}` : ''}（${nightLabel}）${whoLabel}` };
    const flex = await this.showAccommodations(groupId);
    return [successMsg, flex as messagingApi.Message];
  }

  // ─── 住宿資訊：刪除 ────────────────────────────────────────────────────────
  async deleteAccommodationById(groupId: string, id: number): Promise<string | messagingApi.Message> {
    await this.crud.deleteAccommodation(id);
    return this.showAccommodations(groupId);
  }
}
