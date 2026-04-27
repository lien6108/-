import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';
import { getStandardQuickReply } from '../utils/ui';

export class SettlementAgent {
  private crud: CRUD;

  constructor(crud: CRUD) {
    this.crud = crud;
  }

  async showSettlement(groupId: string): Promise<string | messagingApi.Message> {
    const expenses = await this.crud.getUnsettledExpenses(groupId);
    if (expenses.length === 0) {
      return '目前沒有可結算的記帳。';
    }

    const { balances, transactions } = await this.crud.calculateSettlement(groupId);
    let msg = '結算預覽\n\n';
    msg += '各成員淨額（+ 應收 / - 應付）\n';
    for (const uid in balances) {
      const b = balances[uid];
      if (Math.abs(b.net) > 0.01) {
        msg += `- ${b.name}: ${b.net > 0 ? '+' : ''}${b.net}\n`;
      }
    }

    msg += '\n建議轉帳：\n';
    if (transactions.length === 0) {
      msg += '已經平衡，不需要轉帳。';
    } else {
      for (const t of transactions) {
        msg += `- ${t.from_name} -> ${t.to_name}: ${t.amount}\n`;
      }
    }

    msg += '\n\n確認結算後會封存本單，並重置參與成員。';
    return {
      type: 'text',
      text: msg,
      quickReply: getStandardQuickReply({ showSettleConfirm: true })
    };
  }

  async confirmSettlement(groupId: string): Promise<string | messagingApi.Message> {
    const count = await this.crud.settleAllExpenses(groupId);
    if (count === 0) return '目前沒有可結算的記帳。';

    await this.crud.closeCurrentTrip(groupId);
    await this.crud.resetParticipatingMembers(groupId);

    return {
      type: 'text',
      text: `已完成結算並封存本單，共 ${count} 筆記帳。`
    };
  }
}
