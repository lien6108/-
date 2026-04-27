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

    // Private DM: only admin control commands are supported
    if (groupId === 'unknown') {
      if (userId === this.env.ADMIN_LINE_USER_ID) {
        const adminReply = await this.handleAdminDM(text);
        if (adminReply && event.replyToken) await this.reply(event.replyToken, adminReply);
      } else if (event.replyToken) {
        await this.reply(event.replyToken, '請在群組中使用分帳功能。');
      }
      return;
    }

    const displayName = await this.getDisplayName(groupId, userId);
    const botUserId = await this.getBotUserId();
    let botMentionedOnly = false;
    const mentionMap: Record<string, string> = {};

    if (textMessage.mention?.mentionees) {
      const sortedMentions = [...textMessage.mention.mentionees].sort((a, b) => b.index - a.index);
      for (const mentee of sortedMentions) {
        if (!('userId' in mentee) || !mentee.userId) continue;
        if (mentee.userId === botUserId) {
          const textWithoutBot = (text.substring(0, mentee.index) + text.substring(mentee.index + mentee.length)).trim();
          if (textWithoutBot === '') botMentionedOnly = true;
        }

        try {
          const name = await this.getDisplayName(groupId, mentee.userId);
          await this.crud.upsertMember(groupId, mentee.userId, name);
          const original = text.substring(mentee.index, mentee.index + mentee.length);
          const safeMention = original.replace(/\s+/g, '_');
          text = text.substring(0, mentee.index) + safeMention + text.substring(mentee.index + mentee.length);

          mentionMap[safeMention] = mentee.userId;
          if (safeMention.startsWith('@')) mentionMap[safeMention.substring(1)] = mentee.userId;
          mentionMap[name] = mentee.userId;
          mentionMap[name.replace(/\s+/g, '_')] = mentee.userId;
        } catch (e) {
          console.error('Error updating mentioned user', e);
        }
      }
    }

    if (botMentionedOnly) text = 'help';

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
    await this.reply(
      event.replyToken,
      '感謝加入分帳神器。\n你可以先把我拉進群組，輸入「加入」後開始分帳。'
    );
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
    try {
      const profile = await this.client.getGroupMemberProfile(groupId, userId);
      return profile.displayName;
    } catch {
      return `User${userId.slice(-4)}`;
    }
  }

  private async reply(replyToken: string, message: string | messagingApi.Message) {
    let msgObj: messagingApi.Message;
    if (typeof message === 'string') {
      const text = message.length > 5000 ? `${message.substring(0, 4990)}...` : message;
      msgObj = { type: 'text', text };
    } else {
      msgObj = message;
    }
    await this.client.replyMessage({ replyToken, messages: [msgObj] });
  }
}
