import { messagingApi } from '@line/bot-sdk';
import { CRUD, ItinerarySpot } from '../db/crud';

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

  // ─── 顯示給使用者複製的 AI 提示詞 ──────────────────────────────────────────
  async showAIPrompt(groupId: string): Promise<messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    const tripName = trip?.trip_name || '旅程';

    // 第一則：說明
    const intro: messagingApi.Message = {
      type: 'text',
      text:
        `🗺️ 旅遊行程規劃\n\n` +
        `請複製下方指令，貼到 ChatGPT 或 Gemini 生成行程。\n\n` +
        `📌 生成後直接把結果貼回群組，系統會自動匯入！\n\n` +
        `格式說明：\n` +
        `• D1、D2... 代表第幾天\n` +
        `• 每個景點一行\n` +
        `• 可在景點後加 | 地圖連結（選填）`,
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
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '查看行程', text: '行程' } },
          { type: 'action', action: { type: 'message', label: '全部行程', text: '全部行程' } },
        ]
      }
    };

    return [intro, command];
  }

  // ─── 解析 AI 貼回的文字，批次匯入景點 ────────────────────────────────────
  async importSpots(groupId: string, text: string): Promise<string | messagingApi.Message | null> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程，請先輸入「開始記帳」建立旅程 🗺️';

    const lines = text.split('\n');
    const valid: { day: number; name: string; mapsUrl?: string }[] = [];
    const skipped: number[] = [];

    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const parsed = parseLine(line);
      if (parsed) valid.push(parsed);
      else skipped.push(i + 1);
    });

    if (valid.length === 0) return null;

    for (const spot of valid) {
      await this.crud.addSpot(trip.id, spot.day, spot.name, spot.mapsUrl);
    }

    const days = [...new Set(valid.map(v => v.day))].sort((a, b) => a - b);
    const skippedNote = skipped.length > 0 ? `\n⚠️ 第 ${skipped.join('、')} 行格式不符已略過` : '';

    const rows: any[] = valid.map(v => ({
      type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm',
      contents: [
        { type: 'text', text: `D${v.day}`, size: 'xs', flex: 0, color: '#7a9aaa', gravity: 'center', minWidth: '28px' },
        { type: 'text', text: v.name, size: 'sm', flex: 1, wrap: true, color: '#333333' },
        ...(v.mapsUrl ? [{ type: 'text', text: '🗺️', size: 'xs', flex: 0, gravity: 'center' }] : [])
      ]
    }));

    return {
      type: 'flex',
      altText: `✅ 已匯入 ${valid.length} 個景點`,
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8898',
          contents: [
            { type: 'text', text: `✅ 已匯入 ${valid.length} 個景點`, weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: `共 ${days.length} 天・${trip.trip_name}${skippedNote}`, size: 'xs', color: '#cccccc', margin: 'xs', wrap: true }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'message', label: '查看行程', text: '行程' }, style: 'primary', height: 'sm', flex: 1, color: '#7a9aaa' },
            { type: 'button', action: { type: 'message', label: '全部行程', text: '全部行程' }, style: 'secondary', height: 'sm', flex: 1 },
          ]
        }
      }
    } as any;
  }

  // ─── 顯示某天行程 ─────────────────────────────────────────────────────────
  async showDayItinerary(groupId: string, day?: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    let targetDay = day;
    if (!targetDay) {
      const all = await this.crud.getAllSpots(trip.id);
      if (all.length === 0) {
        return `「${trip.trip_name}」還沒有行程！\n輸入「新增旅遊行程」，讓 AI 幫你規劃 ✈️`;
      }
      targetDay = Math.min(...all.map(s => s.day));
    }

    const spots = await this.crud.getSpotsByDay(trip.id, targetDay);
    if (spots.length === 0) {
      return `第 ${targetDay} 天還沒有景點喔！\n輸入「新增旅遊行程」讓 AI 規劃 🗺️`;
    }

    const rows: any[] = spots.map(s => {
      const contents: any[] = [
        {
          type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
          contents: [
            { type: 'text', text: `📍 #${s.id}`, size: 'xs', flex: 0, color: '#7a9aaa', gravity: 'center' },
            { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, color: '#333333', weight: 'bold' },
          ]
        }
      ];
      if (s.maps_url) {
        contents.push({
          type: 'button',
          action: { type: 'uri', label: '🗺️ 導航', uri: s.maps_url },
          style: 'secondary', height: 'sm', margin: 'xs'
        });
      }
      return { type: 'box', layout: 'vertical', margin: 'md', contents };
    });

    return {
      type: 'flex',
      altText: `第 ${targetDay} 天行程`,
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8898',
          contents: [
            { type: 'text', text: `🗺️ ${trip.trip_name}`, weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: `第 ${targetDay} 天・共 ${spots.length} 個景點`, size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'message', label: '全部行程', text: '全部行程' }, style: 'secondary', height: 'sm', flex: 1 },
          ]
        }
      }
    } as any;
  }

  // ─── 顯示所有天行程總覽 ───────────────────────────────────────────────────
  async showFullItinerary(groupId: string): Promise<string | messagingApi.Message> {
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

    const bubbles: any[] = [];
    for (const [day, daySpots] of byDay) {
      const rows = daySpots.map(s => ({
        type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
        contents: [
          { type: 'text', text: '📍', size: 'xs', flex: 0, gravity: 'center' },
          { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, color: '#333333' },
          ...(s.maps_url ? [{
            type: 'button',
            action: { type: 'uri', label: '導航', uri: s.maps_url },
            style: 'secondary', height: 'sm', flex: 0
          }] : [])
        ]
      }));

      bubbles.push({
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8898',
          contents: [
            { type: 'text', text: `第 ${day} 天`, weight: 'bold', color: '#ffffff', size: 'lg' },
            { type: 'text', text: `${daySpots.length} 個景點`, size: 'xs', color: '#cccccc' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows },
      });
    }

    if (bubbles.length === 1) {
      return { type: 'flex', altText: '完整行程', contents: bubbles[0] } as any;
    }
    return { type: 'flex', altText: '完整行程', contents: { type: 'carousel', contents: bubbles.slice(0, 10) } } as any;
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
}
