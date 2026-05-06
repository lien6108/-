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

    if (['db', '查看db容量', 'db size', 'db容量'].includes(t)) {
      const bytes = await this.crud.getDbSize();
      const mb = (bytes / 1024 / 1024).toFixed(2);
      const gb = (bytes / 1024 / 1024 / 1024).toFixed(4);
      const pct = ((bytes / (5 * 1024 * 1024 * 1024)) * 100).toFixed(2);
      return `📦 資料庫容量\n\n大小：${mb} MB（${gb} GB）\n使用率：${pct}%（上限 5 GB）\n${Number(pct) >= 80 ? '⚠️ 已達 80%，請注意！' : '✅ 正常'}`;
    }

    if (['統計', '系統統計', 'stats'].includes(t)) {
      const s = await this.crud.getSystemStats();
      return `📊 系統統計\n\n群組數：${s.groups}\n旅程數：${s.trips}\n記帳筆數：${s.expenses}\n成員總數：${s.members}\n活躍 session：${s.sessions}`;
    }

    if (t.startsWith('推播 ') || t.startsWith('broadcast ')) {
      const content = text.trim().replace(/^(推播|broadcast)\s+/i, '');
      if (!content) return '❌ 請輸入公告內容，例如：推播 系統將於今晚維護 30 分鐘';
      const groupIds = await this.crud.getActiveGroupIds();
      if (groupIds.length === 0) return '📭 目前沒有活躍群組。';
      let success = 0;
      for (const gid of groupIds) {
        try {
          await this.client.pushMessage({ to: gid, messages: [{ type: 'text', text: `📢 系統公告\n\n${content}` }] });
          success++;
        } catch { /* 忽略已離開的群組 */ }
      }
      return `📢 公告已發送至 ${success}/${groupIds.length} 個群組。`;
    }

    if (['清除session', 'clear sessions', '清除逾期session'].includes(t)) {
      const deleted = await this.crud.clearExpiredSessions(24);
      return `🧹 已清除 ${deleted} 筆逾期 session（超過 24 小時）。`;
    }

    if (['說明', 'help', '指令'].includes(t)) {
      return '🔧 管理員指令清單：\n\n' +
        '• 維修開啟 — 開啟維修模式（封鎖一般使用者）\n' +
        '• 維修關閉 — 關閉維修模式\n' +
        '• 維修狀態 — 查看目前維修模式\n' +
        '• 清除資料 — 刪除所有記帳、旅程、session 資料\n' +
        '• 查看DB容量 — 查看資料庫大小與使用率\n' +
        '• 系統統計 — 群組數、旅程數、記帳筆數統計\n' +
        '• 推播 <內容> — 向所有活躍群組發送公告\n' +
        '• 清除session — 清除超過 24 小時的殭屍 session';
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

  /** 檢查 D1 容量，超過 thresholdPct（0~1）時通知管理者 */
  async checkDbCapacity(thresholdPct = 0.8, maxBytes = 5 * 1024 * 1024 * 1024): Promise<void> {
    if (!this.env.ADMIN_LINE_USER_ID) return;
    try {
      const bytes = await this.crud.getDbSize();
      const pct = bytes / maxBytes;
      if (pct >= thresholdPct) {
        const mb = (bytes / 1024 / 1024).toFixed(1);
        const pctStr = (pct * 100).toFixed(1);
        await this.notifyAdmin(
          `⚠️ 資料庫容量警報\n\n目前使用：${mb} MB / 5 GB（${pctStr}%）\n已達 ${Math.round(thresholdPct * 100)}% 警戒線，請盡快清理或升級方案。`
        );
      }
    } catch (e) {
      console.error('[AdminAgent.checkDbCapacity] 檢查失敗:', e);
    }
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
