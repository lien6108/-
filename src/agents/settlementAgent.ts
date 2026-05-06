import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';

export class SettlementAgent {
  private crud: CRUD;

  constructor(crud: CRUD) {
    this.crud = crud;
  }

  async showSettlement(groupId: string): Promise<string | messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) {
      return '目前還沒有記帳可以結算喔～';
    }

    const { balances, transactions } = await this.crud.calculateSettlement(groupId);

    // 各成員淨額列
    const balanceRows: any[] = Object.values(balances)
      .filter(b => Math.abs(b.net) > 0.01)
      .sort((a, b) => b.net - a.net)
      .map(b => ({
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          { type: 'text', text: b.name, size: 'sm', flex: 3 },
          {
            type: 'text',
            text: `${b.net > 0 ? '+' : ''}${Math.round(b.net * 100) / 100}`,
            size: 'sm', flex: 2, align: 'end', weight: 'bold',
            color: b.net > 0 ? '#8fa8b8' : '#b87070'
          }
        ]
      }));

    // 建議轉帳列
    const txRows: any[] = transactions.length === 0
      ? [{ type: 'text', text: '✅ 已經平衡，不需要轉帳', size: 'sm', color: '#8fa8b8', margin: 'sm' }]
      : transactions.map(t => ({
          type: 'box', layout: 'vertical', margin: 'sm',
          contents: [
            {
              type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: `${t.from_name} → ${t.to_name}`, size: 'sm', flex: 3, wrap: true, weight: 'bold' },
                { type: 'text', text: `TWD ${Math.round(t.amount * 100) / 100}`, size: 'sm', flex: 2, align: 'end', color: '#b87070', weight: 'bold' }
              ]
            }
          ]
        }));

    const section = (title: string): any => ({
      type: 'text', text: title, weight: 'bold', size: 'sm', color: '#555555', margin: 'lg'
    });
    const separator: any = { type: 'separator', margin: 'md', color: '#eeeeee' };

    const bodyContents: any[] = [
      section('📊 各成員淨額（+ 應收 / − 應付）'),
      ...balanceRows,
      separator,
      section('💸 建議轉帳'),
      ...txRows,
      { type: 'separator', margin: 'lg', color: '#eeeeee' },
      { type: 'text', text: '確認結算後會封存本單，並重置參與成員。', size: 'xs', color: '#aaaaaa', wrap: true, margin: 'md' }
    ];

    return {
      type: 'flex',
      altText: '結算預覽',
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7a8f88',
          contents: [
            { type: 'text', text: '🧾 結算預覽', weight: 'bold', size: 'lg', color: '#ffffff' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: bodyContents },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'postback', label: '取消', data: 'cmd=取消' }, style: 'secondary', height: 'sm', flex: 1 },
            { type: 'button', action: { type: 'message', label: '確認結算', text: '確認結算' }, style: 'primary', height: 'sm', flex: 2 }
          ]
        }
      }
    } as any;
  }

  async confirmSettlement(groupId: string): Promise<string | messagingApi.Message> {
    const count = await this.crud.settleAllExpenses(groupId);
    if (count === 0) return '目前還沒有記帳可以結算喔～';

    await this.crud.closeCurrentTrip(groupId);
    await this.crud.resetParticipatingMembers(groupId);

    return {
      type: 'text',
      text: `✅ 結算完成，本單已封存！共 ${count} 筆記帳。`
    };
  }

  async listHistory(groupId: string): Promise<string | messagingApi.Message> {
    const trips = await this.crud.getTripHistory(groupId);
    if (trips.length === 0) return '還沒有歷史分帳記錄喔～';

    const rows: any[] = trips.map(t => {
      const statusText = t.status === 'active' ? '進行中' : '已結算';
      const statusColor = t.status === 'active' ? '#7a9aaa' : '#aaaaaa';
      const dateStr = t.closed_at
        ? new Date(t.closed_at).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })
        : new Date(t.created_at!).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
      return {
        type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm',
        contents: [
          {
            type: 'box', layout: 'vertical', flex: 5,
            contents: [
              { type: 'text', text: t.trip_name || `旅程 #${t.id}`, size: 'sm', weight: 'bold', wrap: true },
              {
                type: 'box', layout: 'horizontal', margin: 'xs',
                contents: [
                  { type: 'text', text: statusText, size: 'xs', color: statusColor, flex: 0 },
                  { type: 'text', text: `  ${dateStr}`, size: 'xs', color: '#aaaaaa', flex: 1 }
                ]
              }
            ]
          },
          {
            type: 'button',
            action: { type: 'postback', label: '查看', data: `cmd=歷史 #${t.id}` },
            style: 'secondary', height: 'sm', flex: 2
          }
        ]
      };
    });

    return {
      type: 'flex',
      altText: '歷史分帳',
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7c8a78',
          contents: [{ type: 'text', text: '📜 歷史分帳', weight: 'bold', size: 'lg', color: '#ffffff' }]
        },
        body: { type: 'box', layout: 'vertical', contents: rows }
      }
    } as any;
  }

  async showTripExpenses(groupId: string, tripId: number): Promise<string | messagingApi.Message> {
    const trips = await this.crud.getTripHistory(groupId);
    const trip = trips.find(t => t.id === tripId);
    if (!trip) return '找不到指定的分帳記錄喔！';

    const expenses = await this.crud.getExpensesByTripId(tripId);
    if (expenses.length === 0) return `「${trip.trip_name || `旅程 #${tripId}`}」沒有任何記帳喔。`;

    let total = 0;
    const rows: any[] = expenses.map(exp => {
      total += exp.amount;
      const amountText = exp.currency && exp.currency !== 'TWD' && exp.original_amount
        ? `${exp.currency} ${exp.original_amount}`
        : `TWD ${exp.amount}`;
      return {
        type: 'box', layout: 'vertical', margin: 'md',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: `#${exp.group_seq}`, size: 'xs', color: '#888888', flex: 1 },
              { type: 'text', text: exp.description, size: 'sm', flex: 3, weight: 'bold', wrap: true },
              { type: 'text', text: amountText, size: 'sm', flex: 3, align: 'end' },
              { type: 'text', text: exp.payer_name, size: 'xs', flex: 2, align: 'end', color: '#555555' }
            ]
          },
          { type: 'separator', margin: 'md', color: '#eeeeee' }
        ]
      };
    });

    return {
      type: 'flex',
      altText: `${trip.trip_name || `旅程 #${tripId}`} 完整清單`,
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#7c8a78',
          contents: [
            { type: 'text', text: trip.trip_name || `旅程 #${tripId}`, weight: 'bold', size: 'lg', color: '#ffffff' },
            { type: 'text', text: `共 ${expenses.length} 筆，合計 TWD ${Math.round(total * 100) / 100}`, size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: {
          type: 'box', layout: 'vertical',
          contents: [
            {
              type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: '編號', size: 'xs', color: '#aaaaaa', flex: 1 },
                { type: 'text', text: '項目', size: 'xs', color: '#aaaaaa', flex: 3 },
                { type: 'text', text: '金額', size: 'xs', color: '#aaaaaa', flex: 3, align: 'end' },
                { type: 'text', text: '付款人', size: 'xs', color: '#aaaaaa', flex: 2, align: 'end' }
              ]
            },
            { type: 'separator', margin: 'sm' },
            ...rows
          ]
        },
        footer: {
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'button', action: { type: 'postback', label: '返回歷史', data: 'cmd=歷史' }, style: 'secondary', height: 'sm' }
          ]
        }
      }
    } as any;
  }
}
