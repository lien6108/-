import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';
import { Env } from '../env';

const ADMIN_PALETTE = {
  sky: '#9ccfe8',
  cream: '#fff8e8',
  paper: '#fffdf5',
  wood: '#b98a55',
  woodDark: '#7a5632',
  passport: '#234b68',
  ink: '#3f3328',
  muted: '#8f7a62',
  danger: '#a66b5b',
  border: '#ead8b8',
  green: '#5a8a6a',
};

function adminCmdBtn(label: string, cmd: string, style: 'primary' | 'secondary' | 'danger' = 'secondary'): any {
  const colorMap = {
    primary: { bg: ADMIN_PALETTE.passport, text: '#ffffff' },
    secondary: { bg: ADMIN_PALETTE.cream, text: ADMIN_PALETTE.ink },
    danger: { bg: ADMIN_PALETTE.danger, text: '#ffffff' },
  };
  const c = colorMap[style];
  return {
    type: 'box', layout: 'horizontal', paddingAll: 'sm',
    backgroundColor: c.bg, cornerRadius: 'md',
    action: { type: 'message', label, text: cmd },
    contents: [
      { type: 'text', text: label, size: 'sm', color: c.text, weight: 'bold', align: 'center', flex: 1 }
    ]
  };
}

function adminSection(title: string, icon: string, buttons: any[]): any {
  return {
    type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md',
    contents: [
      {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'text', text: icon, size: 'sm' },
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: ADMIN_PALETTE.muted }
        ]
      },
      { type: 'separator', color: ADMIN_PALETTE.border },
      ...buttons
    ]
  };
}

function createAdminFlex(): messagingApi.FlexMessage {
  const bubble1: any = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.passport, paddingAll: 'md', spacing: 'xs',
      contents: [
        { type: 'text', text: 'ADMIN', size: 'xs', weight: 'bold', color: '#aec8db' },
        { type: 'text', text: '🔧 系統監控', size: 'lg', weight: 'bold', color: '#ffffff' },
        { type: 'text', text: '查看狀態與資源使用', size: 'xs', color: '#b0c8d8', wrap: true },
      ]
    },
    body: {
      type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.paper, paddingAll: 'lg', spacing: 'none',
      contents: [
        adminSection('維修模式', '🚧', [
          adminCmdBtn('🟢 開啟維修', '維修開啟', 'danger'),
          adminCmdBtn('✅ 關閉維修', '維修關閉', 'primary'),
          adminCmdBtn('❓ 查看狀態', '維修狀態', 'secondary'),
        ]),
        adminSection('資源監控', '📊', [
          adminCmdBtn('📦 查看DB容量', '查看DB容量', 'secondary'),
          adminCmdBtn('📊 系統統計', '系統統計', 'secondary'),
        ]),
      ]
    }
  };

  const bubble2: any = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.wood, paddingAll: 'md', spacing: 'xs',
      contents: [
        { type: 'text', text: 'ADMIN', size: 'xs', weight: 'bold', color: '#e8d5b8' },
        { type: 'text', text: '🗂️ 資料管理', size: 'lg', weight: 'bold', color: '#ffffff' },
        { type: 'text', text: '清理資料與向群組推播', size: 'xs', color: '#e0ccaa', wrap: true },
      ]
    },
    body: {
      type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.paper, paddingAll: 'lg', spacing: 'none',
      contents: [
        adminSection('Session 管理', '🧹', [
          adminCmdBtn('🧹 清除逾期 Session', '清除session', 'secondary'),
        ]),
        adminSection('推播公告', '📢', [
          {
            type: 'box', layout: 'vertical', paddingAll: 'sm',
            backgroundColor: ADMIN_PALETTE.cream, cornerRadius: 'md',
            contents: [
              { type: 'text', text: '📋 複製指令格式後編輯發送', size: 'xs', color: ADMIN_PALETTE.muted, wrap: true },
              {
                type: 'box', layout: 'horizontal', margin: 'sm',
                contents: [
                  {
                    type: 'box', layout: 'vertical', flex: 1, paddingAll: 'xs',
                    backgroundColor: ADMIN_PALETTE.passport, cornerRadius: 'md',
                    action: { type: 'clipboard', label: '複製', clipboardText: '推播 ' },
                    contents: [
                      { type: 'text', text: '📋 複製「推播 」', size: 'xs', color: '#ffffff', align: 'center', weight: 'bold' }
                    ]
                  }
                ]
              }
            ]
          }
        ]),
        adminSection('危險操作', '🗑️', [
          adminCmdBtn('🎯 指定清除', '指定清除', 'secondary'),
          adminCmdBtn('🗑️ 清除所有資料', '清除資料', 'danger'),
        ]),
      ]
    }
  };

  return {
    type: 'flex',
    altText: '🔧 管理員指令面板',
    contents: { type: 'carousel', contents: [bubble1, bubble2] }
  };
}

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

  // Handle a private DM from the admin user. Returns a reply string/Flex or null (unhandled).
  async handleAdminDM(text: string): Promise<string | messagingApi.FlexMessage | null> {
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
      // Show confirmation Flex instead of executing immediately
      const confirmFlex: messagingApi.FlexMessage = {
        type: 'flex',
        altText: '⚠️ 確認清除所有資料？',
        contents: {
          type: 'bubble', size: 'kilo',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.danger, paddingAll: 'md',
            contents: [
              { type: 'text', text: '⚠️ 危險操作', size: 'xs', weight: 'bold', color: '#ffdddd' },
              { type: 'text', text: '確認清除所有資料？', size: 'lg', weight: 'bold', color: '#ffffff', wrap: true },
            ]
          },
          body: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.paper, paddingAll: 'lg', spacing: 'md',
            contents: [
              { type: 'text', text: '這將永久刪除所有：', size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold' },
              { type: 'text', text: '• 所有記帳紀錄（expenses）\n• 所有旅程（trips）\n• 所有 session\n• 成員參與狀態', size: 'sm', color: ADMIN_PALETTE.danger, wrap: true },
              { type: 'text', text: '此操作無法復原。', size: 'xs', color: ADMIN_PALETTE.muted, margin: 'sm' },
            ]
          },
          footer: {
            type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'md',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1, paddingAll: 'sm',
                backgroundColor: ADMIN_PALETTE.muted, cornerRadius: 'md',
                action: { type: 'message', label: '取消', text: '指令' },
                contents: [{ type: 'text', text: '✖ 取消', size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
              },
              {
                type: 'box', layout: 'vertical', flex: 1, paddingAll: 'sm',
                backgroundColor: ADMIN_PALETTE.danger, cornerRadius: 'md',
                action: { type: 'message', label: '確認清除', text: '確認清除資料' },
                contents: [{ type: 'text', text: '🗑️ 確認清除', size: 'sm', color: '#ffffff', align: 'center', weight: 'bold' }]
              },
            ]
          }
        } as any
      };
      return confirmFlex;
    }

    if (t === '確認清除資料') {
      try {
        await this.crud.clearAllData();
        return '🗑️ 已清除所有記帳資料（expenses、trips、sessions、成員參與狀態）。';
      } catch (e: any) {
        return `❌ 清除失敗：${e?.message || e}`;
      }
    }

    if (['db', '查看db容量', 'db size', 'db容量'].includes(t)) {
      const bytes = await this.crud.getDbSize();
      const MAX = 5 * 1024 * 1024 * 1024;
      let usedText: string;
      let pctText = '';
      let statusText = '';
      if (bytes < 0) {
        usedText = '無法取得（D1 不支援此查詢）';
      } else {
        const mb = (bytes / 1024 / 1024).toFixed(2);
        const pct = ((bytes / MAX) * 100).toFixed(2);
        usedText = `${mb} MB`;
        pctText = `${pct}%`;
        statusText = Number(pct) >= 80 ? '⚠️ 已達 80%' : '✅ 正常';
      }
      const flex: messagingApi.FlexMessage = {
        type: 'flex',
        altText: '📦 資料庫容量',
        contents: {
          type: 'bubble', size: 'kilo',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.passport, paddingAll: 'md', spacing: 'xs',
            contents: [
              { type: 'text', text: '📦 資料庫容量', size: 'lg', weight: 'bold', color: '#ffffff' },
              { type: 'text', text: new Date().toLocaleString('zh-TW', { hour12: false }), size: 'xs', color: '#aec8db' },
            ]
          },
          body: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.paper, paddingAll: 'lg', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '目前使用', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: usedText, size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' }] },
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '總容量', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: '5 GB', size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' }] },
              ...(pctText ? [{ type: 'box' as const, layout: 'horizontal' as const, contents: [{ type: 'text', text: '使用率', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: pctText, size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' as const }] }] : []),
              ...(statusText ? [{ type: 'text' as const, text: statusText, size: 'sm' as const, color: statusText.startsWith('⚠') ? ADMIN_PALETTE.danger : ADMIN_PALETTE.green, margin: 'sm' as const, align: 'center' as const }] : []),
            ]
          }
        } as any
      };
      return flex;
    }

    if (['統計', '系統統計', 'stats'].includes(t)) {
      const s = await this.crud.getSystemStats();
      const flex: messagingApi.FlexMessage = {
        type: 'flex',
        altText: '📊 系統統計',
        contents: {
          type: 'bubble', size: 'kilo',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.wood, paddingAll: 'md', spacing: 'xs',
            contents: [
              { type: 'text', text: '📊 系統統計', size: 'lg', weight: 'bold', color: '#ffffff' },
              { type: 'text', text: new Date().toLocaleString('zh-TW', { hour12: false }), size: 'xs', color: '#e8d5b8' },
            ]
          },
          body: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.paper, paddingAll: 'lg', spacing: 'sm',
            contents: [
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '群組數', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: `${s.groups}`, size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' }] },
              { type: 'separator', color: ADMIN_PALETTE.border, margin: 'xs' },
              { type: 'box', layout: 'horizontal', margin: 'xs', contents: [{ type: 'text', text: '旅程（執行中）', size: 'sm', color: ADMIN_PALETTE.green, flex: 1 }, { type: 'text', text: `${s.activeTrips}`, size: 'sm', color: ADMIN_PALETTE.green, weight: 'bold', align: 'end' }] },
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '旅程（歷史）', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: `${s.closedTrips}`, size: 'sm', color: ADMIN_PALETTE.muted, weight: 'bold', align: 'end' }] },
              { type: 'separator', color: ADMIN_PALETTE.border, margin: 'xs' },
              { type: 'box', layout: 'horizontal', margin: 'xs', contents: [{ type: 'text', text: '記帳筆數', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: `${s.expenses}`, size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' }] },
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '成員總數', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: `${s.members}`, size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' }] },
              { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '活躍 Session', size: 'sm', color: ADMIN_PALETTE.muted, flex: 1 }, { type: 'text', text: `${s.sessions}`, size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold', align: 'end' }] },
            ]
          }
        } as any
      };
      return flex;
    }

    if (['指定清除', '選擇清除'].includes(t)) {
      const selectFlex: messagingApi.FlexMessage = {
        type: 'flex',
        altText: '🎯 指定清除資料',
        contents: {
          type: 'bubble', size: 'kilo',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.wood, paddingAll: 'md',
            contents: [
              { type: 'text', text: '🎯 指定清除', size: 'lg', weight: 'bold', color: '#ffffff' },
              { type: 'text', text: '選擇要刪除的類型', size: 'xs', color: '#e8d5b8' },
            ]
          },
          body: {
            type: 'box', layout: 'vertical', backgroundColor: ADMIN_PALETTE.paper, paddingAll: 'lg', spacing: 'md',
            contents: [
              {
                type: 'box', layout: 'vertical', spacing: 'xs',
                contents: [
                  { type: 'text', text: '💰 僅清除記帳資料', size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold' },
                  { type: 'text', text: '刪除所有 expenses 與分攤明細，保留旅程與成員', size: 'xs', color: ADMIN_PALETTE.muted, wrap: true },
                  adminCmdBtn('💰 清除記帳資料', '確認清除記帳', 'secondary'),
                ]
              },
              { type: 'separator', color: ADMIN_PALETTE.border },
              {
                type: 'box', layout: 'vertical', spacing: 'xs',
                contents: [
                  { type: 'text', text: '🗃️ 清除歷史旅程', size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold' },
                  { type: 'text', text: '刪除已結束的旅程（含記帳、行程），保留執行中旅程', size: 'xs', color: ADMIN_PALETTE.muted, wrap: true },
                  adminCmdBtn('🗃️ 清除歷史旅程', '確認清除歷史旅程', 'secondary'),
                ]
              },
              { type: 'separator', color: ADMIN_PALETTE.border },
              {
                type: 'box', layout: 'vertical', spacing: 'xs',
                contents: [
                  { type: 'text', text: '🧹 清除全部 Session', size: 'sm', color: ADMIN_PALETTE.ink, weight: 'bold' },
                  { type: 'text', text: '清除所有 session（含未逾期），使用者需重新開始流程', size: 'xs', color: ADMIN_PALETTE.muted, wrap: true },
                  adminCmdBtn('🧹 清除全部 Session', '確認清除sessions', 'secondary'),
                ]
              },
            ]
          },
          footer: {
            type: 'box', layout: 'vertical', paddingAll: 'md', backgroundColor: ADMIN_PALETTE.paper,
            contents: [adminCmdBtn('← 返回指令面板', '指令', 'primary')]
          }
        } as any
      };
      return selectFlex;
    }

    if (t === '確認清除記帳') {
      try {
        await this.crud.clearExpenses();
        return '💰 已清除所有記帳資料（expenses 與分攤明細）。';
      } catch (e: any) { return `❌ 清除失敗：${e?.message || e}`; }
    }

    if (t === '確認清除歷史旅程') {
      try {
        const count = await this.crud.clearClosedTrips();
        return count > 0 ? `🗃️ 已清除 ${count} 個歷史旅程（含記帳、行程）。` : '📭 目前沒有歷史旅程可清除。';
      } catch (e: any) { return `❌ 清除失敗：${e?.message || e}`; }
    }

    if (t === '確認清除sessions') {
      try {
        const count = await this.crud.clearSessions();
        return `🧹 已清除 ${count} 個 session。`;
      } catch (e: any) { return `❌ 清除失敗：${e?.message || e}`; }
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
      return createAdminFlex();
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
      if (bytes < 0) return; // D1 pragma not supported, skip
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
