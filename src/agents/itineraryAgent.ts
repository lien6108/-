import { messagingApi } from '@line/bot-sdk';
import { CRUD, ItinerarySpot } from '../db/crud';

export class ItineraryAgent {
  constructor(private crud: CRUD) {}

  // ─── 取得今天是行程第幾天（依 created_at 推算）─────────────────────────────
  private getTodayDay(tripCreatedAt: string): number {
    const start = new Date(tripCreatedAt);
    const now = new Date();
    const diff = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(1, diff + 1);
  }

  // ─── 顯示某天行程 ─────────────────────────────────────────────────────────
  async showDayItinerary(groupId: string, day?: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程，請先輸入「開始記帳」建立旅程 🗺️';

    const targetDay = day ?? this.getTodayDay(trip.created_at);
    const spots = await this.crud.getSpotsByDay(trip.id, targetDay);

    if (spots.length === 0) {
      return `第 ${targetDay} 天還沒有行程景點喔！\n可以輸入「新增行程 D${targetDay} 景點名稱」來加入 🗺️`;
    }

    const rows: any[] = spots.map(s => {
      const isDone = s.status === 'done';
      const icon = isDone ? '✅' : '📍';
      const nameStyle = isDone ? { color: '#aaaaaa', decoration: 'line-through' } : { color: '#333333', weight: 'bold' };
      const contents: any[] = [
        {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'text', text: `${icon} #${s.id}`, size: 'xs', flex: 0, color: isDone ? '#aaaaaa' : '#7a9aaa', gravity: 'center' },
            { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, ...nameStyle },
          ]
        }
      ];
      if (s.maps_url && !isDone) {
        contents.push({
          type: 'button',
          action: { type: 'uri', label: '🗺️ 導航', uri: s.maps_url },
          style: 'secondary', height: 'sm', margin: 'xs'
        });
      }
      return { type: 'box', layout: 'vertical', margin: 'md', contents };
    });

    const doneCount = spots.filter(s => s.status === 'done').length;

    return {
      type: 'flex',
      altText: `第 ${targetDay} 天行程`,
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8898',
          contents: [
            { type: 'text', text: `🗺️ ${trip.trip_name}`, weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: `第 ${targetDay} 天・${doneCount}/${spots.length} 完成`, size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'message', label: '下一站', text: '下一站' }, style: 'secondary', height: 'sm', flex: 1 },
            { type: 'button', action: { type: 'message', label: '到了', text: '到了' }, style: 'primary', height: 'sm', flex: 1, color: '#7a9aaa' },
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
    if (spots.length === 0) return `「${trip.trip_name}」還沒有行程景點！\n輸入「新增行程 D1 景點名稱」開始規劃 ✈️`;

    // 依天分組
    const byDay = new Map<number, ItinerarySpot[]>();
    for (const s of spots) {
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day)!.push(s);
    }

    const bubbles: any[] = [];
    for (const [day, daySpots] of byDay) {
      const doneCount = daySpots.filter(s => s.status === 'done').length;
      const rows = daySpots.map(s => {
        const isDone = s.status === 'done';
        const contents: any[] = [
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: [
              { type: 'text', text: isDone ? '✅' : '📍', size: 'xs', flex: 0, gravity: 'center' },
              { type: 'text', text: s.name, size: 'sm', flex: 1, wrap: true, color: isDone ? '#aaaaaa' : '#333333' }
            ]
          }
        ];
        if (s.maps_url && !isDone) {
          contents.push({
            type: 'button',
            action: { type: 'uri', label: '導航', uri: s.maps_url },
            style: 'secondary', height: 'sm', margin: 'xs'
          });
        }
        return { type: 'box', layout: 'vertical', contents };
      });

      bubbles.push({
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8898',
          contents: [
            { type: 'text', text: `第 ${day} 天`, weight: 'bold', color: '#ffffff', size: 'lg' },
            { type: 'text', text: `${doneCount}/${daySpots.length} 完成`, size: 'xs', color: '#cccccc' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows },
        footer: {
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'button', action: { type: 'message', label: '下一站', text: '下一站' }, style: 'secondary', height: 'sm' }
          ]
        }
      });
    }

    if (bubbles.length === 1) {
      return { type: 'flex', altText: '完整行程', contents: bubbles[0] } as any;
    }
    return { type: 'flex', altText: '完整行程', contents: { type: 'carousel', contents: bubbles.slice(0, 10) } } as any;
  }

  // ─── 下一站 ────────────────────────────────────────────────────────────────
  async showNextSpot(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const spot = await this.crud.getNextPendingSpot(trip.id);
    if (!spot) return '🎉 所有景點都完成了！旅途愉快～';

    const contents: any[] = [
      { type: 'text', text: '📍 下一站', size: 'sm', color: '#888888' },
      { type: 'text', text: spot.name, size: 'xl', weight: 'bold', margin: 'sm', wrap: true },
      { type: 'text', text: `第 ${spot.day} 天 #${spot.id}`, size: 'xs', color: '#aaaaaa', margin: 'xs' }
    ];

    if (spot.maps_url) {
      contents.push({
        type: 'button',
        action: { type: 'uri', label: '🗺️ 開啟導航', uri: spot.maps_url },
        style: 'primary', margin: 'md', color: '#7a9aaa'
      });
    }

    contents.push({
      type: 'button',
      action: { type: 'message', label: '✅ 到了！', text: '到了' },
      style: 'secondary', margin: 'sm'
    });

    return {
      type: 'flex',
      altText: `下一站：${spot.name}`,
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', spacing: 'sm', contents }
      }
    } as any;
  }

  // ─── 到了（標記完成，顯示下一站）───────────────────────────────────────────
  async markArrived(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const spot = await this.crud.getNextPendingSpot(trip.id);
    if (!spot) return '🎉 所有景點都已完成了！';

    await this.crud.markSpotDone(spot.id);

    const next = await this.crud.getNextPendingSpot(trip.id);
    if (!next) {
      return `✅ 「${spot.name}」完成！\n🎉 今天所有景點都打卡完成了，辛苦了！`;
    }

    const contents: any[] = [
      { type: 'text', text: `✅ 已到達「${spot.name}」`, size: 'sm', color: '#5a9a6a' },
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '📍 下一站', size: 'sm', color: '#888888', margin: 'md' },
      { type: 'text', text: next.name, size: 'xl', weight: 'bold', margin: 'sm', wrap: true },
      { type: 'text', text: `第 ${next.day} 天 #${next.id}`, size: 'xs', color: '#aaaaaa', margin: 'xs' }
    ];

    if (next.maps_url) {
      contents.push({
        type: 'button',
        action: { type: 'uri', label: '🗺️ 開啟導航', uri: next.maps_url },
        style: 'primary', margin: 'md', color: '#7a9aaa'
      });
    }

    return {
      type: 'flex',
      altText: `下一站：${next.name}`,
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', spacing: 'sm', contents }
      }
    } as any;
  }

  // ─── 新增景點 ─────────────────────────────────────────────────────────────
  // 格式：新增行程 D1 景點名稱 [maps_url]
  async addSpot(groupId: string, day: number, name: string, mapsUrl?: string): Promise<string> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程，請先輸入「開始記帳」建立旅程 🗺️';

    await this.crud.addSpot(trip.id, day, name, mapsUrl);
    return `✅ 已新增第 ${day} 天景點：「${name}」${mapsUrl ? '（附導航連結）' : ''}\n輸入「行程 D${day}」查看當天完整行程 🗺️`;
  }

  // ─── 刪除景點 ─────────────────────────────────────────────────────────────
  async deleteSpot(groupId: string, spotId: number): Promise<string> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    await this.crud.deleteSpot(spotId);
    return `🗑️ 景點 #${spotId} 已刪除。`;
  }

  // ─── 購物清單 ─────────────────────────────────────────────────────────────
  async addShoppingItem(groupId: string, assignee: string, item: string): Promise<string> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    await this.crud.addShoppingItem(trip.id, assignee, item);
    return `🛍️ 已將「${item}」加入 ${assignee} 的購物清單！\n輸入「購物清單」查看所有清單 🛒`;
  }

  async showShoppingList(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const items = await this.crud.getShoppingItems(trip.id);
    if (items.length === 0) return '購物清單是空的～\n輸入「買 品項名稱」可以加入自己的購物清單 🛍️';

    // 依人分組
    const byPerson = new Map<string, typeof items>();
    for (const it of items) {
      if (!byPerson.has(it.assignee)) byPerson.set(it.assignee, []);
      byPerson.get(it.assignee)!.push(it);
    }

    const rows: any[] = [];
    for (const [person, personItems] of byPerson) {
      rows.push({
        type: 'text', text: `👤 ${person}`,
        weight: 'bold', size: 'sm', margin: 'md', color: '#555555'
      });
      for (const it of personItems) {
        const bought = it.is_bought === 1;
        rows.push({
          type: 'box', layout: 'horizontal', margin: 'xs', spacing: 'sm',
          contents: [
            { type: 'text', text: bought ? '✅' : '🛍️', size: 'xs', flex: 0, gravity: 'center' },
            {
              type: 'text', text: `#${it.id} ${it.item}`, size: 'sm', flex: 1,
              color: bought ? '#aaaaaa' : '#333333',
              decoration: bought ? 'line-through' : 'none'
            },
            ...(!bought ? [{
              type: 'button',
              action: { type: 'message', label: '買到了', text: `買到了 #${it.id}` },
              style: 'secondary', height: 'sm', flex: 0
            }] : [])
          ]
        });
      }
      rows.push({ type: 'separator', margin: 'sm' });
    }

    const boughtCount = items.filter(i => i.is_bought).length;

    return {
      type: 'flex', altText: '購物清單',
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#8a7f9e',
          contents: [
            { type: 'text', text: '🛒 購物清單', weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: `${boughtCount}/${items.length} 已購買`, size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows }
      }
    } as any;
  }

  async markItemBought(groupId: string, itemId: number): Promise<string> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    await this.crud.markItemBought(itemId);
    return `✅ 品項 #${itemId} 已標記為購買！`;
  }
}
