import { messagingApi, webhook } from '@line/bot-sdk';
import { Env } from './env';
import { MainAgent } from './agents/mainAgent';
import { AdminAgent } from './agents/adminAgent';
import { CRUD } from './db/crud';
import { getJoinQuickReply, getFollowQuickReply } from './utils/ui';

const { MessagingApiClient } = messagingApi;

export class LineEventHandler {
  private client: messagingApi.MessagingApiClient;
  private mainAgent: MainAgent;
  private adminAgent: AdminAgent;
  private crud: CRUD;
  private env: Env;
  private botUserId: string | null = null;

  constructor(env: Env) {
    this.env = env;
    this.client = new MessagingApiClient({
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN
    });
    this.crud = new CRUD(env);
    this.mainAgent = new MainAgent(env, this.crud);
    this.adminAgent = new AdminAgent(env, this.crud);
    // 自動執行 DB migration（IF NOT EXISTS，安全冪等）
    this.crud.runMigrations().catch(e => console.error('[Migration] failed:', e));
  }

  async handleEvents(events: webhook.Event[]) {
    const tasks = events.map(event => this.dispatch(event));
    await Promise.allSettled(tasks);
  }

  private async dispatch(event: webhook.Event) {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        await this.handleText(event as webhook.MessageEvent);
      } else if (event.type === 'join') {
        await this.handleJoin(event as webhook.JoinEvent);
      } else if (event.type === 'follow') {
        await this.handleFollow(event as webhook.FollowEvent);
      } else if (event.type === 'postback') {
        await this.handlePostback(event as webhook.PostbackEvent);
      }
    } catch (e) {
      console.error('[LineEventHandler] Event processing error:', e);
    }
  }

  private async getBotUserId(): Promise<string> {
    if (this.botUserId) return this.botUserId;
    try {
      const info = await this.client.getBotInfo();
      this.botUserId = info.userId;
      return this.botUserId;
    } catch (e) {
      console.error('Failed to get bot info', e);
      return 'unknown';
    }
  }

  private async handleText(event: webhook.MessageEvent) {
    const source = event.source as any;
    const userId = source?.userId || 'unknown';
    const textMessage = event.message as webhook.TextMessageContent;
    let text = textMessage.text.trim();

    let groupId = 'unknown';
    if (source?.type === 'group') groupId = source.groupId;
    if (source?.type === 'room') groupId = source.roomId;

    // Private DM: handle admin commands and view requests
    if (groupId === 'unknown') {
      const t = text.trim();

      // Check pending DM session first
      const dmSession = await this.crud.getSession(userId);
      if (dmSession?.group_id === 'dm' && dmSession?.step === 'AWAITING_FEEDBACK') {
        await this.crud.deleteSession(userId);
        await this.adminAgent.notifyAdmin(`💬 使用者回饋\n來自：${await this.getDisplayName('unknown', userId)} (${userId})\n內容：${t}`);
        if (event.replyToken) await this.reply(event.replyToken, '謝謝您的回饋，我們收到囉！🐾');
        return;
      }

      if (t === '我要回饋') {
        await this.crud.upsertSession(userId, 'dm', 'AWAITING_FEEDBACK', '{}');
        if (event.replyToken) await this.reply(event.replyToken, '請輸入您想回饋的內容吧～');
        return;
      }

      if (t === '查看目前分帳') {
        const msg = await this.buildCurrentFlex(userId);
        if (event.replyToken) await this.reply(event.replyToken, msg);
        return;
      }

      if (t === '查看歷史分帳') {
        const msg = await this.buildHistoryFlex(userId);
        if (event.replyToken) await this.reply(event.replyToken, msg);
        return;
      }

      const dmHistoryMatch = t.match(/^歷史\s*#(\d+)$/);
      if (dmHistoryMatch) {
        const msg = await this.buildTripDetailFlex(userId, parseInt(dmHistoryMatch[1], 10));
        if (event.replyToken) await this.reply(event.replyToken, msg);
        return;
      }

      if (this.adminAgent.isAdmin(userId)) {
        const adminReply = await this.adminAgent.handleAdminDM(t);
        if (event.replyToken) await this.reply(event.replyToken, adminReply ?? '管理員模式中，輸入「指令」查看可用指令。');
        return;
      }

      if (event.replyToken) await this.reply(event.replyToken, '分帳功能需要在群組中使用喔～');
      return;
    }

    const displayName = await this.getDisplayName(groupId, userId);
    const botUserId = await this.getBotUserId();
    let botMentionedOnly = false;
    const mentionMap: Record<string, string> = {};

    if (textMessage.mention?.mentionees) {
      const sortedMentions = [...textMessage.mention.mentionees].sort((a, b) => b.index - a.index);

      // First pass: identify if bot is mentioned and if it's the only content
      for (const mentee of sortedMentions) {
        if (!('userId' in mentee) || !mentee.userId) continue;
        if (mentee.userId === botUserId) {
          const before = text.substring(0, mentee.index);
          const after = text.substring(mentee.index + mentee.length);
          if ((before + after).trim() === '') {
            botMentionedOnly = true;
          }
        }
      }

      // Second pass: process all mentions
      for (const mentee of sortedMentions) {
        if (!('userId' in mentee) || !mentee.userId) continue;

        const isBot = mentee.userId === botUserId;
        const original = text.substring(mentee.index, mentee.index + mentee.length);
        const safeMention = original.replace(/\s+/g, '_');

        if (isBot) {
          text = text.substring(0, mentee.index) + safeMention + text.substring(mentee.index + mentee.length);
          continue;
        }

        try {
          const name = await this.getDisplayName(groupId, mentee.userId);
          await this.crud.upsertMember(groupId, mentee.userId, name);
          text = text.substring(0, mentee.index) + safeMention + text.substring(mentee.index + mentee.length);

          mentionMap[safeMention] = mentee.userId;
          if (safeMention.startsWith('@')) mentionMap[safeMention.substring(1)] = mentee.userId;
          mentionMap[name] = mentee.userId;
          mentionMap[name.replace(/\s+/g, '_')] = mentee.userId;
        } catch (e) {
          console.error('[handleText] Error updating mentioned user:', e);
        }
      }
    }

    if (botMentionedOnly) text = 'GREETING';

    const replyText = await this.mainAgent.processMessage(groupId, userId, displayName, text, mentionMap);
    if (!replyText || !event.replyToken) return;

    if (typeof replyText === 'string' && (replyText.startsWith('[NOTIFY_ADMIN]') || replyText.startsWith('[FEEDBACK]'))) {
      const handled = await this.adminAgent.handleSpecialReply(
        event.replyToken,
        replyText,
        { groupId, displayName, userId },
        (token, msg) => this.reply(token, msg)
      );
      if (handled) return;
    }

    await this.reply(event.replyToken, replyText);
  }

  private async handleJoin(event: webhook.JoinEvent) {
    if (!event.replyToken) return;
    const joinMsg: messagingApi.Message = {
      type: 'text',
      text: '大家好！我是分帳小幫手 🐾\n\n我可以幫你們在這個群組輕鬆記帳、自動換算匯率並結算分帳金額！\n\n✨ 只要@我，然後選擇你要的功能，就可以使用了汪～',
      quickReply: getJoinQuickReply()
    };
    await this.reply(event.replyToken, joinMsg);
  }

  private async handleFollow(event: webhook.FollowEvent) {
    if (!event.replyToken) return;
    const tutorialMsg: messagingApi.Message = {
      type: 'text',
      text: '感謝加入「分帳小幫手」！🐾\n我是一個可以幫你在群組中輕鬆記帳、自動換算匯率並結算的工具。\n\n🐕 快速開始：\n1. 把我拉進旅遊/聚餐群組\n2. 在群組輸入「加入」\n3. 輸入「開始記帳」即可開始！\n\n🦴 提示：輸入「說明」可查看完整指令清單。',
      quickReply: getFollowQuickReply()
    };
    await this.reply(event.replyToken, tutorialMsg);
  }

  private async buildCurrentFlex(userId: string): Promise<messagingApi.Message> {
    const groupIds = await this.crud.getGroupsByUserId(userId);
    if (groupIds.length === 0) {
      return { type: 'text', text: '你目前未加入任何分帳群組。' };
    }

    const bubbles: any[] = [];
    for (const gid of groupIds) {
      const trip = await this.crud.getCurrentTrip(gid);
      const expenses = await this.crud.getUnsettledExpenses(gid);
      const tripName = trip?.trip_name || '（未命名旅程）';
      let total = 0;

      const rows = expenses.length === 0
        ? [{ type: 'text', text: '目前無記帳資料', size: 'sm', color: '#aaaaaa', margin: 'md' }]
        : expenses.map(exp => {
            const amt = exp.currency && exp.currency !== 'TWD' && exp.original_amount
              ? `${exp.currency} ${exp.original_amount}` : `TWD ${exp.amount}`;
            total += exp.amount;
            return {
              type: 'box', layout: 'horizontal', margin: 'sm',
              contents: [
                { type: 'text', text: `#${exp.group_seq}`, size: 'xs', color: '#aaaaaa', flex: 1 },
                { type: 'text', text: exp.description, size: 'sm', flex: 4, weight: 'bold', wrap: true },
                { type: 'box', layout: 'vertical', flex: 3, contents: [
                  { type: 'text', text: amt, size: 'xs', align: 'end' },
                  { type: 'text', text: exp.payer_name, size: 'xs', color: '#888888', align: 'end' }
                ]}
              ]
            };
          });

      const totalRow = expenses.length > 0 ? {
        type: 'box', layout: 'horizontal', margin: 'md',
        contents: [
          { type: 'text', text: '總計 (TWD)', weight: 'bold', size: 'sm', flex: 1 },
          { type: 'text', text: `${Math.round(total * 100) / 100}`, weight: 'bold', size: 'sm', align: 'end', flex: 1 }
        ]
      } : null;

      bubbles.push({
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#6b7f8c',
          contents: [
            { type: 'text', text: '📋 目前分帳清單', weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: `✈️ ${tripName}`, color: '#cccccc', size: 'xs' }
          ]
        },
        body: {
          type: 'box', layout: 'vertical',
          contents: [
            ...rows,
            ...(totalRow ? [{ type: 'separator', margin: 'md' }, totalRow] : [])
          ]
        }
      });
    }

    if (bubbles.length === 1) {
      return { type: 'flex', altText: '目前分帳清單', contents: bubbles[0] } as any;
    }
    return { type: 'flex', altText: '目前分帳清單', contents: { type: 'carousel', contents: bubbles } } as any;
  }

  private async buildHistoryFlex(userId: string): Promise<messagingApi.Message> {
    const groupIds = await this.crud.getAllGroupsByUserId(userId);
    if (groupIds.length === 0) {
      return { type: 'text', text: '你目前未加入任何分帳群組。' };
    }

    const allTrips: any[] = [];
    for (const gid of groupIds) {
      const trips = await this.crud.getTripHistory(gid);
      allTrips.push(...trips);
    }

    if (allTrips.length === 0) {
      return { type: 'text', text: '目前無歷史分帳紀錄。' };
    }

    allTrips.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return 0;
    });

    const rows = allTrips.map(t => {
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString('zh-TW') : '';
      const isActive = t.status === 'active';
      const statusText = isActive ? '● 進行中' : '● 已結算';
      const statusColor = isActive ? '#5a9a6a' : '#aaaaaa';

      const rightCol: any = isActive
        ? { type: 'text', text: statusText, size: 'xs', color: statusColor, align: 'end', flex: 2, gravity: 'center' }
        : {
            type: 'box', layout: 'vertical', flex: 2, contents: [
              { type: 'text', text: statusText, size: 'xs', color: statusColor, align: 'end' },
              {
                type: 'button',
                action: { type: 'postback', label: '查看', data: `cmd=歷史 #${t.id}` },
                style: 'secondary', height: 'sm', margin: 'xs'
              }
            ]
          };

      return {
        type: 'box', layout: 'horizontal', margin: 'md',
        contents: [
          { type: 'box', layout: 'vertical', flex: 4, contents: [
            { type: 'text', text: `✈️ ${t.trip_name}`, size: 'sm', weight: 'bold', wrap: true },
            { type: 'text', text: date, size: 'xs', color: '#aaaaaa' }
          ]},
          rightCol
        ]
      };
    });

    return {
      type: 'flex', altText: '歷史分帳',
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#6b7f8c',
          contents: [{ type: 'text', text: '🗂 歷史分帳', weight: 'bold', color: '#ffffff', size: 'md' }]
        },
        body: { type: 'box', layout: 'vertical', contents: rows }
      }
    } as any;
  }

  private async buildTripDetailFlex(userId: string, tripId: number): Promise<messagingApi.Message> {
    const groupIds = await this.crud.getAllGroupsByUserId(userId);
    let trip: any = null;
    for (const gid of groupIds) {
      const trips = await this.crud.getTripHistory(gid);
      trip = trips.find((t: any) => t.id === tripId);
      if (trip) break;
    }
    if (!trip) return { type: 'text', text: '找不到指定的分帳記錄。' };

    const expenses = await this.crud.getExpensesByTripId(tripId);
    if (expenses.length === 0) return { type: 'text', text: `「${trip.trip_name}」沒有任何記帳。` };

    let total = 0;
    const rows: any[] = expenses.map((exp: any) => {
      total += exp.amount;
      const amt = exp.currency && exp.currency !== 'TWD' && exp.original_amount
        ? `${exp.currency} ${exp.original_amount}` : `TWD ${exp.amount}`;
      return {
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          { type: 'text', text: `#${exp.group_seq}`, size: 'xs', color: '#aaaaaa', flex: 1 },
          { type: 'text', text: exp.description, size: 'sm', flex: 4, weight: 'bold', wrap: true },
          { type: 'box', layout: 'vertical', flex: 3, contents: [
            { type: 'text', text: amt, size: 'xs', align: 'end' },
            { type: 'text', text: exp.payer_name, size: 'xs', color: '#888888', align: 'end' }
          ]}
        ]
      };
    });

    return {
      type: 'flex', altText: `${trip.trip_name} 完整清單`,
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#6b7f8c',
          contents: [
            { type: 'text', text: `✈️ ${trip.trip_name}`, weight: 'bold', color: '#ffffff', size: 'md' },
            { type: 'text', text: `共 ${expenses.length} 筆，合計 TWD ${Math.round(total * 100) / 100}`, size: 'xs', color: '#cccccc', margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows },
        footer: {
          type: 'box', layout: 'horizontal',
          contents: [{ type: 'button', action: { type: 'postback', label: '返回歷史', data: 'cmd=查看歷史分帳' }, style: 'secondary', height: 'sm' }]
        }
      }
    } as any;
  }

  private async getDisplayName(groupId: string, userId: string): Promise<string> {
    if (userId === 'unknown') return 'User';
    try {
      if (groupId === 'unknown') {
        const profile = await this.client.getProfile(userId);
        return profile.displayName;
      } else {
        const profile = await this.client.getGroupMemberProfile(groupId, userId);
        return profile.displayName;
      }
    } catch (e) {
      console.error(`[getDisplayName] Failed for user ${userId} in ${groupId}:`, e);
      return `User${userId.slice(-4)}`;
    }
  }

  private async handlePostback(event: webhook.PostbackEvent) {
    const source = event.source as any;
    const userId = source?.userId || 'unknown';
    const data = event.postback.data;

    let groupId = 'unknown';
    if (source?.type === 'group') groupId = source.groupId;
    if (source?.type === 'room') groupId = source.roomId;

    const displayName = await this.getDisplayName(groupId, userId);
    const replyText = await this.mainAgent.processPostback(groupId, userId, displayName, data);

    if (replyText && event.replyToken) {
      await this.reply(event.replyToken, replyText);
    }
  }

  private async reply(replyToken: string, message: string | messagingApi.Message | messagingApi.Message[]) {
    let messages: messagingApi.Message[];
    if (Array.isArray(message)) {
      messages = message;
    } else if (typeof message === 'string') {
      const text = message.length > 5000 ? `${message.substring(0, 4990)}...` : message;
      messages = [{ type: 'text', text }];
    } else {
      messages = [message];
    }
    await this.client.replyMessage({ replyToken, messages });
  }
}
