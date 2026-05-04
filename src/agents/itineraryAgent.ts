import { messagingApi } from '@line/bot-sdk';
import { CRUD, ItinerarySpot, FlightInfo } from '../db/crud';
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
  async showAIPrompt(groupId: string, userId: string): Promise<messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    const tripName = trip?.trip_name || '旅程';

    // 設定 session，等待使用者貼回 AI 結果
    await this.crud.upsertSession(userId, groupId, 'AWAITING_ITINERARY_IMPORT', '{}');

    // 第一則：說明 + 警語
    const intro: messagingApi.Message = {
      type: 'text',
      text:
        `🗺️ 旅遊行程規劃\n\n` +
        `請複製下方指令，貼到 ChatGPT 或 Gemini 生成行程後，再貼回群組。\n\n` +
        `格式說明：\n` +
        `• D1、D2... 代表第幾天\n` +
        `• 每個景點一行\n` +
        `• 可在景點後加 | 地圖連結（選填）\n\n` +
        `⚠️ 注意：現在貼入的內容將直接新增為行程。\n` +
        `若需要先討論，請點「取消」後再操作。`,
      quickReply: getCancelQuickReply()
    };

    // 第二則：純指令，方便長按複製
    const command: messagingApi.Message = {
      type: 'text',
      text:
        `幫我規劃${tripName}的行程，每天 3-5 個景點，請依照以下格式輸出，不要多餘說明：\n\n` +
        `D1 景點名稱\n` +
        `D1 另一個景點 | https://maps.app.goo.gl/xxx\n` +
        `D2 景點名稱\n` +
        `D2 另一個景點`,
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

    const carousel = await this.showDayItinerary(groupId);
    return [successMsg, carousel as messagingApi.Message];
  }

  // ─── 建立單天 bubble ──────────────────────────────────────────────────────
  private buildDayBubble(tripName: string, day: number, daySpots: ItinerarySpot[]): any {
    const rows: any[] = daySpots.map((s, idx) => {
      const bodyContents: any[] = [
        {
          type: 'box', layout: 'horizontal', margin: idx === 0 ? 'none' : 'md',
          contents: [
            { type: 'text', text: `${idx + 1}.`, size: 'xs', color: '#7a9aaa', flex: 0 },
            { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, color: '#333333', weight: 'bold', margin: 'sm' },
            { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 0 }
          ]
        }
      ];
      if (s.maps_url) {
        bodyContents.push({
          type: 'button',
          action: { type: 'uri', label: '🗺️ 導航', uri: s.maps_url },
          style: 'secondary', height: 'sm', margin: 'xs'
        });
      }
      return { type: 'box', layout: 'vertical', contents: bodyContents };
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

  // ─── 顯示所有天行程（carousel），可指定從哪天開始 ────────────────────────
  async showDayItinerary(groupId: string, day?: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const spots = await this.crud.getAllSpots(trip.id);
    if (spots.length === 0) {
      return '目前沒有行程景點。';
    }

    const byDay = new Map<number, ItinerarySpot[]>();
    for (const s of spots) {
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day)!.push(s);
    }

    // 排序所有天，指定天排到第一張
    let days = [...byDay.keys()].sort((a, b) => a - b);
    if (day && byDay.has(day)) {
      days = [day, ...days.filter(d => d !== day)];
    }

    const bubbles = days.map(d => this.buildDayBubble(trip.trip_name, d, byDay.get(d)!));

    const itinQuickReply: messagingApi.QuickReply = {
      items: [
        { type: 'action', action: { type: 'postback', label: '🗑️ 清空行程', data: 'cmd=清空行程' } },
        { type: 'action', action: { type: 'postback', label: '⬅️ 返回主選單', data: 'action=menu_main' } },
      ]
    };

    if (bubbles.length === 1) {
      return { type: 'flex', altText: `${trip.trip_name} 行程`, contents: bubbles[0], quickReply: itinQuickReply } as any;
    }
    return { type: 'flex', altText: `${trip.trip_name} 行程`, contents: { type: 'carousel', contents: bubbles.slice(0, 10) }, quickReply: itinQuickReply } as any;
  }

  // ─── showFullItinerary 直接呼叫 showDayItinerary（從第一天開始）────────────
  async showFullItinerary(groupId: string): Promise<string | messagingApi.Message> {
    return this.showDayItinerary(groupId);
  }

  // ─── 刪除景點 ─────────────────────────────────────────────────────────────
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
        `請輸入${typeLabel}班機資訊：\n\n` +
        `格式：日期 [機場 航廈] 出發時間 - [機場 航廈] 抵達時間 [航班號]\n\n` +
        `範例：\n` +
        `2026/5/10 08:30 - 13:45 CI-100\n` +
        `2026/9/24 桃園 T1 16:10 - 香港 T1 18:10 CX443\n` +
        `（機場、航廈和航班號均為選填；日期可略去年份，系統自動補上）`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 班機資訊：解析輸入並儲存 ─────────────────────────────────────────────
  async handleFlightInput(groupId: string, text: string, flightType: 'outbound' | 'return', addedByName?: string): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const parsed = this.parseFlightInput(text);
    if (!parsed) {
      return {
        type: 'text',
        text: `格式不符，請重新輸入：\n例：5/10 TPE 08:30 → NRT 13:45 CI-100\n（機場代碼和航班號均為選填）`,
        quickReply: getCancelQuickReply()
      };
    }

    const { departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport } = parsed;
    const typeLabel = flightType === 'outbound' ? '去程' : '回程';
    await this.crud.addFlight(trip.id, flightType, departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport, addedByName);

    const routeText = departAirport && arriveAirport ? ` ${departAirport}→${arriveAirport}` : '';
    const flexMsg = await this.showFlights(groupId);
    const successMsg: messagingApi.Message = {
      type: 'text',
      text: `✅ ${typeLabel}班機已新增！${flightNo ? `（${flightNo}）` : ''}${routeText}\n${departDate} ${departTime} → ${arriveTime}`
    };
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
}
