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
            color: b.net > 0 ? '#2ecc71' : '#e74c3c'
          }
        ]
      }));

    // 建議轉帳列
    const txRows: any[] = transactions.length === 0
      ? [{ type: 'text', text: '✅ 已經平衡，不需要轉帳', size: 'sm', color: '#2ecc71', margin: 'sm' }]
      : transactions.map(t => ({
          type: 'box', layout: 'vertical', margin: 'sm',
          contents: [
            {
              type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: `${t.from_name} → ${t.to_name}`, size: 'sm', flex: 3, wrap: true, weight: 'bold' },
                { type: 'text', text: `TWD ${Math.round(t.amount * 100) / 100}`, size: 'sm', flex: 2, align: 'end', color: '#e74c3c', weight: 'bold' }
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
          type: 'box', layout: 'vertical', backgroundColor: '#46494c',
          contents: [
            { type: 'text', text: '🧾 結算預覽', weight: 'bold', size: 'lg', color: '#ffffff' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: bodyContents },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'message', label: '取消', text: '取消' }, style: 'secondary', height: 'sm', flex: 1 },
            { type: 'button', action: { type: 'message', label: '確認結算', text: '確認結算' }, style: 'primary', height: 'sm', color: '#e74c3c', flex: 2 }
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
}
