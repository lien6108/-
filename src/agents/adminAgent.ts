import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';
import { Env } from '../env';

export class AdminAgent {
  private crud: CRUD;
  private env: Env;
  private client: messagingApi.MessagingApiClient;

  constructor(env: Env, crud: CRUD) {
    this.env = env;
    this.crud = crud;
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN
    });
  }

  isAdmin(userId: string): boolean {
    return !!this.env.ADMIN_LINE_USER_ID && userId === this.env.ADMIN_LINE_USER_ID;
  }

  // Handle a private DM from the admin user. Returns a reply string or null (unhandled).
  async handleAdminDM(text: string): Promise<string | null> {
    const t = text.trim().toLowerCase();

    if (['維修開啟', 'maintenance on', '維修 on'].includes(t)) {
      await this.crud.setMaintenanceMode(true);
      return '🔧 已開啟維修模式。';
    }

    if (['維修關閉', 'maintenance off', '維修 off'].includes(t)) {
      await this.crud.setMaintenanceMode(false);
      return '🔧 已關閉維修模式。';
    }

    if (['維修狀態', 'maintenance status'].includes(t)) {
      const on = await this.crud.isMaintenanceMode();
      return `目前維修模式：${on ? '🔴 開啟' : '🟢 關閉'}`;
    }

    if (['清除資料', 'clear data', 'reset all'].includes(t)) {
      try {
        await this.crud.clearAllData();
        return '🗑️ 已清除所有記帳資料（expenses、trips、sessions、成員參與狀態）。';
      } catch (e: any) {
        return `❌ 清除失敗：${e?.message || e}`;
      }
    }

    if (['說明', 'help', '指令'].includes(t)) {
      return '🔧 管理員指令清單：\n\n' +
        '• 維修開啟 — 開啟維修模式（封鎖一般使用者）\n' +
        '• 維修關閉 — 關閉維修模式\n' +
        '• 維修狀態 — 查看目前維修模式\n' +
        '• 清除資料 — 刪除所有記帳、旅程、session 資料';
    }

    return null;
  }

  // Push a notification to the admin user
  async notifyAdmin(message: string): Promise<void> {
    if (!this.env.ADMIN_LINE_USER_ID) return;
    await this.client.pushMessage({
      to: this.env.ADMIN_LINE_USER_ID,
      messages: [{ type: 'text', text: message }]
    });
  }

  // Handle [NOTIFY_ADMIN] and [FEEDBACK] special prefixes from mainAgent
  async handleSpecialReply(
    replyToken: string,
    replyText: string,
    context: { groupId: string; displayName: string; userId: string },
    replyFn: (token: string, msg: string) => Promise<void>
  ): Promise<boolean> {
    if (replyText.startsWith('[NOTIFY_ADMIN]')) {
      const actualReply = replyText.replace('[NOTIFY_ADMIN]', '');
      await replyFn(replyToken, actualReply);
      await this.notifyAdmin(`AI 通知\n群組：${context.groupId}\n使用者：${context.displayName}\n內容：${actualReply}`);
      return true;
    }

    if (replyText.startsWith('[FEEDBACK]')) {
      const content = replyText.replace('[FEEDBACK]', '').trim();
      await replyFn(replyToken, `已收到你的回饋：\n${content}`);
      const trip = await this.crud.getCurrentTrip(context.groupId);
      const tripName = trip?.trip_name || '未命名旅程';
      await this.notifyAdmin(
        `回饋通知\n旅程：${tripName}\n群組：${context.groupId}\n使用者：${context.displayName} (${context.userId})\n內容：${content}`
      );
      return true;
    }

    return false;
  }
}
