import { messagingApi, webhook } from '@line/bot-sdk';
import { Env } from './env';
import { MainAgent } from './agents/mainAgent';
import { CRUD } from './db/crud';

const { MessagingApiClient } = messagingApi;

export class LineEventHandler {
  private client: messagingApi.MessagingApiClient;
  private mainAgent: MainAgent;
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

    // Private DM: only admin control commands are supported (already handled globally by ID check)
    if (groupId === 'unknown' && userId !== this.env.ADMIN_LINE_USER_ID) {
      if (event.replyToken) await this.reply(event.replyToken, '請在群組中使用分帳功能。');
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

    // Administrative controls (Maintenance Mode etc.) - ONLY in Private DM
    if (groupId === 'unknown' && userId === this.env.ADMIN_LINE_USER_ID) {
      const adminReply = await this.handleAdminDM(text);
      if (adminReply && event.replyToken) {
        await this.reply(event.replyToken, adminReply);
        return;
      }
    }

    const replyText = await this.mainAgent.processMessage(groupId, userId, displayName, text, mentionMap);
    if (!replyText || !event.replyToken) return;

    if (typeof replyText === 'string' && replyText.startsWith('[NOTIFY_ADMIN]')) {
      const actualReply = replyText.replace('[NOTIFY_ADMIN]', '');
      await this.reply(event.replyToken, actualReply);
      if (this.env.ADMIN_LINE_USER_ID) {
        await this.client.pushMessage({
          to: this.env.ADMIN_LINE_USER_ID,
          messages: [{ type: 'text', text: `AI 通知\n群組：${groupId}\n使用者：${displayName}\n內容：${actualReply}` }]
        });
      }
      return;
    }

    if (typeof replyText === 'string' && replyText.startsWith('[FEEDBACK]')) {
      const content = replyText.replace('[FEEDBACK]', '').trim();
      await this.reply(event.replyToken, `已收到你的回饋：\n${content}`);

      if (this.env.ADMIN_LINE_USER_ID) {
        const trip = await this.crud.getCurrentTrip(groupId);
        const tripName = trip?.trip_name || '未命名旅程';
        await this.client.pushMessage({
          to: this.env.ADMIN_LINE_USER_ID,
          messages: [{
            type: 'text',
            text: `回饋通知\n旅程：${tripName}\n群組：${groupId}\n使用者：${displayName} (${userId})\n內容：${content}`
          }]
        });
      }
      return;
    }

    await this.reply(event.replyToken, replyText);
  }

  private async handleJoin(event: webhook.JoinEvent) {
    if (event.replyToken) await this.reply(event.replyToken, await this.mainAgent.handleBotJoinGroup());
  }

  private async handleFollow(event: webhook.FollowEvent) {
    if (!event.replyToken) return;
    const tutorialMsg: messagingApi.Message = {
      type: 'text',
      text: '感謝加入「分帳小幫手」！✨\n我是一個可以幫你在群組中輕鬆記帳、自動換算匯率並結算的工具。\n\n🚀 快速開始：\n1. 把我拉進旅遊/聚餐群組\n2. 在群組輸入「加入」\n3. 輸入「開始記帳」即可開始！\n\n💡 提示：輸入「說明」可查看完整指令清單。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '查看說明', text: '說明' } },
          { type: 'action', action: { type: 'message', label: '歷史紀錄', text: '歷史' } },
        ]
      }
    };
    await this.reply(event.replyToken, tutorialMsg);
  }

  private async handleAdminDM(text: string): Promise<string | null> {
    const t = text.trim().toLowerCase();
    if (['維修開啟', 'maintenance on', '維修 on'].includes(t)) {
      await this.crud.setMaintenanceMode(true);
      return '已開啟維修模式。';
    }
    if (['維修關閉', 'maintenance off', '維修 off'].includes(t)) {
      await this.crud.setMaintenanceMode(false);
      return '已關閉維修模式。';
    }
    if (['維修狀態', 'maintenance status'].includes(t)) {
      const on = await this.crud.isMaintenanceMode();
      return `目前維修模式：${on ? '開啟' : '關閉'}`;
    }
    return '可用管理指令：維修開啟 / 維修關閉 / 維修狀態';
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
