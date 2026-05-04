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
      const contents: any[] = [
        {
          type: 'box', layout: 'horizontal', spacing: 'sm', margin: idx === 0 ? 'none' : 'md',
          contents: [
            {
              type: 'box', layout: 'vertical', flex: 0, width: '18px',
              contents: [{ type: 'text', text: `${idx + 1}.`, size: 'xs', color: '#7a9aaa' }]
            },
            { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, color: '#333333', weight: 'bold' },
          ]
        }
      ];
      if (s.maps_url) {
        contents.push({
          type: 'button',
          action: { type: 'uri', label: '🗺️ 導航', uri: s.maps_url },
          style: 'secondary', height: 'sm', margin: 'xs', color: '#7a9aaa'
        });
      }
      return { type: 'box', layout: 'vertical', contents };
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
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: '新增旅遊行程', data: 'cmd=新增旅遊行程' }, style: 'secondary', height: 'sm', flex: 1 },
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
      return `「${trip.trip_name}」還沒有行程！\n輸入「新增旅遊行程」，讓 AI 幫你規劃 ✈️`;
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

    if (bubbles.length === 1) {
      return { type: 'flex', altText: `${trip.trip_name} 行程`, contents: bubbles[0] } as any;
    }
    return { type: 'flex', altText: `${trip.trip_name} 行程`, contents: { type: 'carousel', contents: bubbles.slice(0, 10) } } as any;
  }

  // ─── showFullItinerary 直接呼叫 showDayItinerary（從第一天開始）────────────
  async showFullItinerary(groupId: string): Promise<string | messagingApi.Message> {
    return this.showDayItinerary(groupId);
  }

  // ─── 刪除景點 ─────────────────────────────────────────────────────────────
  async deleteSpot(groupId: string, spotId: number): Promise<string> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    await this.crud.deleteSpot(spotId);
    return `🗑️ 景點 #${spotId} 已刪除。`;
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
    const isAirport = (s: string) => /^[A-Za-z]{2,4}$/.test(s);
    const isTime = (s: string) => /^\d{2}:\d{2}$/.test(s);
    const isDate = (s: string) => /^\d{1,2}\/\d{1,2}$/.test(s);

    if (!isDate(parts[i] || '')) return null;
    const departDate = parts[i++];

    let departAirport: string | undefined;
    if (i < parts.length && isAirport(parts[i]) && !isTime(parts[i])) departAirport = parts[i++].toUpperCase();

    if (!isTime(parts[i] || '')) return null;
    const departTime = parts[i++];

    if (i < parts.length && /^[→>]$/.test(parts[i])) i++;

    let arriveAirport: string | undefined;
    if (i < parts.length && isAirport(parts[i]) && !isTime(parts[i])) arriveAirport = parts[i++].toUpperCase();

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
        `格式：日期 [出發機場] 出發時間 → [抵達機場] 抵達時間 [航班號]\n\n` +
        `範例：\n` +
        `5/10 08:30 → 13:45 CI-100\n` +
        `5/10 TPE 08:30 → NRT 13:45 CI-100\n` +
        `（機場代碼和航班號均為選填）`,
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
      const flightNoText = f.flight_no ? `${f.flight_no}  ` : '';
      const routeText = f.depart_airport && f.arrive_airport
        ? `${f.depart_airport} ${f.depart_time} → ${f.arrive_airport} ${f.arrive_time}`
        : `${f.depart_time} → ${f.arrive_time}`;
      const infoLines: any[] = [
        { type: 'text', text: `${flightNoText}${f.depart_date}`, size: 'sm', weight: 'bold', color: '#333333' },
        { type: 'text', text: routeText, size: 'xs', color: '#555555', margin: 'xs' },
      ];
      if (f.added_by_name) {
        infoLines.push({ type: 'text', text: f.added_by_name, size: 'xs', color: '#aaaaaa', margin: 'xs' });
      }
      return {
        type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
        contents: [
          { type: 'box', layout: 'vertical', flex: 1, contents: infoLines },
          { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除班機 #${f.id}` }, style: 'secondary', height: 'sm', flex: 0 }
        ]
      };
    };

    const buildSection = (label: string, list: FlightInfo[], emptyText: string): any[] => {
      const header = { type: 'text', text: label, size: 'sm', weight: 'bold', color: '#6b7f8c', margin: 'lg' };
      const sep = { type: 'separator', margin: 'sm' };
      if (list.length === 0) {
        return [header, sep, { type: 'text', text: emptyText, size: 'sm', color: '#bbbbbb', margin: 'sm' }];
      }
      return [header, sep, ...list.map(buildFlightRow)];
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
