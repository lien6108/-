import { messagingApi, webhook } from '@line/bot-sdk';
import { Env } from './env';
import { MainAgent } from './agents/mainAgent';
import { AdminAgent } from './agents/adminAgent';
import { CRUD } from './db/crud';
import { getJoinQuickReply, getFollowQuickReply } from './utils/ui';

const { MessagingApiClient } = messagingApi;

const DM_PALETTE = {
  sky: '#9ccfe8',
  cream: '#fff8e8',
  paper: '#fffdf5',
  wood: '#b98a55',
  woodDark: '#7a5632',
  passport: '#234b68',
  ink: '#3f3328',
  muted: '#8f7a62',
  border: '#ead8b8'
};

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
    console.log('[LineHandler.dispatch] 收到事件類型:', event.type);
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
    console.log('[LineHandler.handleText] 收到訊息:', text.substring(0, 50));

    let groupId = 'unknown';
    if (source?.type === 'group') groupId = source.groupId;
    if (source?.type === 'room') groupId = source.roomId;
    console.log('[LineHandler.handleText] groupId:', groupId, 'userId:', userId);

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

      if (t === '查看現有旅程') {
        const msg = await this.buildCurrentFlex(userId);
        if (event.replyToken) await this.reply(event.replyToken, msg);
        return;
      }

      if (t === '查看歷史旅程') {
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

      const dmItineraryMatch = t.match(/^私訊行程\s*#(\d+)$/);
      if (dmItineraryMatch) {
        const msg = await this.buildTripItineraryFlex(userId, parseInt(dmItineraryMatch[1], 10));
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
      return { type: 'text', text: '你目前沒有進行中的旅程。' };
    }

    const bubbles: any[] = [];
    for (const gid of groupIds) {
      const trip = await this.crud.getCurrentTrip(gid);
      if (!trip) continue;
      const meta = await this.getTripMeta(trip);

      bubbles.push({
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: DM_PALETTE.sky, paddingAll: 'md', spacing: 'xs',
          contents: [
            { type: 'text', text: '🧳 現有旅程', weight: 'bold', color: DM_PALETTE.passport, size: 'xs' },
            { type: 'text', text: trip.trip_name || '（未命名旅程）', weight: 'bold', color: DM_PALETTE.ink, size: 'md', wrap: true }
          ]
        },
        body: {
          type: 'box', layout: 'vertical', backgroundColor: DM_PALETTE.cream, paddingAll: 'md', spacing: 'sm',
          contents: [
            this.metaRow('✈️ 出發日期', meta.departDate),
            this.metaRow('🗓️ 天數', `${meta.days} 天`),
            this.metaRow('📍 狀態', '進行中')
          ]
        }
      });
    }

    if (bubbles.length === 0) return { type: 'text', text: '你目前沒有進行中的旅程。' };

    if (bubbles.length === 1) {
      return { type: 'flex', altText: '現有旅程清單', contents: bubbles[0] } as any;
    }
    return { type: 'flex', altText: '現有旅程清單', contents: { type: 'carousel', contents: bubbles.slice(0, 10) } } as any;
  }

  private async buildHistoryFlex(userId: string): Promise<messagingApi.Message> {
    const groupIds = [...new Set([...(await this.crud.getAllGroupsByUserId(userId)), ...(await this.crud.getGroupsByUserId(userId))])];
    if (groupIds.length === 0) {
      return { type: 'text', text: '你目前未加入任何分帳群組。' };
    }

    const tripMap = new Map<number, any>();
    for (const gid of groupIds) {
      const trips = await this.crud.getTripHistory(gid);
      for (const trip of trips) tripMap.set(trip.id, trip);
    }
    const allTrips = [...tripMap.values()];

    if (allTrips.length === 0) {
      return { type: 'text', text: '目前無歷史旅程紀錄。' };
    }

    allTrips.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return 0;
    });

    const rows: any[] = [];
    for (const t of allTrips) {
      const meta = await this.getTripMeta(t);
      const isActive = t.status === 'active';
      const statusText = isActive ? '● 進行中' : '● 已完成';
      const statusColor = isActive ? DM_PALETTE.passport : DM_PALETTE.muted;

      const rightCol: any = isActive
        ? { type: 'text', text: statusText, size: 'xs', color: statusColor, align: 'end', flex: 2, gravity: 'center', weight: 'bold' }
        : {
            type: 'box', layout: 'vertical', flex: 3, contents: [
              { type: 'text', text: statusText, size: 'xs', color: statusColor, align: 'end', weight: 'bold' },
              {
                type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'xs', contents: [
                  { type: 'button', action: { type: 'postback', label: '🗺️', data: `cmd=私訊行程 #${t.id}` }, style: 'secondary', height: 'sm', flex: 1 },
                  { type: 'button', action: { type: 'postback', label: '🧾', data: `cmd=私訊清單 #${t.id}` }, style: 'secondary', height: 'sm', flex: 1 }
                ]
              }
            ]
          };

      rows.push({
        type: 'box', layout: 'vertical', margin: 'md', paddingAll: 'sm', backgroundColor: DM_PALETTE.paper, cornerRadius: 'md', borderColor: DM_PALETTE.border, borderWidth: '1px',
        contents: [
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            { type: 'box', layout: 'vertical', flex: 4, contents: [
              { type: 'text', text: `✈️ ${t.trip_name}`, size: 'sm', weight: 'bold', wrap: true, color: DM_PALETTE.ink },
              { type: 'text', text: `${meta.departDate}・${meta.days} 天`, size: 'xs', color: DM_PALETTE.muted, wrap: true }
            ]},
            rightCol
          ]}
        ]
      });
    }

    return {
      type: 'flex', altText: '歷史旅程',
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: DM_PALETTE.sky, paddingAll: 'md',
          contents: [{ type: 'text', text: '🗂 歷史旅程', weight: 'bold', color: DM_PALETTE.passport, size: 'md' }]
        },
        body: { type: 'box', layout: 'vertical', contents: rows, backgroundColor: DM_PALETTE.cream, paddingAll: 'md' }
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
    if (!trip) return { type: 'text', text: '找不到指定的旅程記錄。' };

    const expenses = await this.crud.getExpensesByTripId(tripId);
    if (expenses.length === 0) return { type: 'text', text: `「${trip.trip_name}」沒有任何記帳。` };

    let total = 0;
    const rows: any[] = expenses.map((exp: any) => {
      total += exp.amount;
      const amt = exp.currency && exp.currency !== 'TWD' && exp.original_amount
        ? `${exp.currency} ${exp.original_amount}` : `TWD ${exp.amount}`;
      return {
        type: 'box', layout: 'vertical', margin: 'sm', paddingAll: 'sm', backgroundColor: DM_PALETTE.paper, cornerRadius: 'md', borderColor: DM_PALETTE.border, borderWidth: '1px',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `#${exp.group_seq}`, size: 'xs', color: DM_PALETTE.woodDark, flex: 1, weight: 'bold' },
            { type: 'text', text: exp.description, size: 'sm', flex: 4, weight: 'bold', wrap: true, color: DM_PALETTE.ink },
            { type: 'text', text: amt, size: 'sm', flex: 3, align: 'end', color: DM_PALETTE.passport, weight: 'bold' }
          ]},
          { type: 'text', text: `付款人：${exp.payer_name}`, size: 'xs', color: DM_PALETTE.muted, align: 'end', margin: 'xs' }
        ]
      };
    });

    return {
      type: 'flex', altText: `${trip.trip_name} 完整清單`,
      contents: {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: DM_PALETTE.sky, paddingAll: 'md',
          contents: [
            { type: 'text', text: `✈️ ${trip.trip_name}`, weight: 'bold', color: DM_PALETTE.passport, size: 'md', wrap: true },
            { type: 'text', text: `共 ${expenses.length} 筆，合計 TWD ${Math.round(total * 100) / 100}`, size: 'xs', color: DM_PALETTE.woodDark, margin: 'xs' }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: rows, backgroundColor: DM_PALETTE.cream, paddingAll: 'md' },
        footer: {
          type: 'box', layout: 'horizontal', backgroundColor: DM_PALETTE.cream, paddingAll: 'md',
          contents: [{ type: 'button', action: { type: 'postback', label: '返回歷史', data: 'cmd=查看歷史旅程' }, style: 'secondary', height: 'sm' }]
        }
      }
    } as any;
  }

  private metaRow(label: string, value: string): any {
    return {
      type: 'box', layout: 'horizontal', paddingAll: 'sm', backgroundColor: DM_PALETTE.paper, cornerRadius: 'md', borderColor: DM_PALETTE.border, borderWidth: '1px',
      contents: [
        { type: 'text', text: label, size: 'sm', color: DM_PALETTE.muted, flex: 3 },
        { type: 'text', text: value, size: 'sm', color: DM_PALETTE.ink, weight: 'bold', align: 'end', flex: 4, wrap: true }
      ]
    };
  }

  private async getTripMeta(trip: any): Promise<{ departDate: string; days: number }> {
    const flights = await this.crud.getFlights(trip.id);
    const outbounds = flights
      .filter(f => f.type === 'outbound')
      .sort((a, b) => a.depart_date.localeCompare(b.depart_date) || a.depart_time.localeCompare(b.depart_time));
    const departDate = outbounds[0]?.depart_date || '未填班機';

    const spots = await this.crud.getAllSpots(trip.id);
    const accoms = await this.crud.getAccommodations(trip.id);
    const maxSpotDay = spots.length > 0 ? Math.max(...spots.map(s => s.day)) : 1;
    const maxAccomDay = accoms.length > 0 ? Math.max(...accoms.map(a => a.day_to + 1)) : 1;
    return { departDate, days: Math.max(1, maxSpotDay, maxAccomDay) };
  }

  private async findUserTrip(userId: string, tripId: number): Promise<any | null> {
    const groupIds = [...new Set([...(await this.crud.getAllGroupsByUserId(userId)), ...(await this.crud.getGroupsByUserId(userId))])];
    for (const gid of groupIds) {
      const trips = await this.crud.getTripHistory(gid);
      const trip = trips.find((t: any) => t.id === tripId);
      if (trip) return trip;
    }
    return null;
  }

  private async buildTripItineraryFlex(userId: string, tripId: number): Promise<messagingApi.Message> {
    const trip = await this.findUserTrip(userId, tripId);
    if (!trip) return { type: 'text', text: '找不到指定的旅程記錄。' };

    const spots = await this.crud.getAllSpots(tripId);
    if (spots.length === 0) return { type: 'text', text: `「${trip.trip_name}」沒有行程資訊。` };

    const byDay = new Map<string, { day: number; branch: string; spots: any[] }>();
    for (const spot of spots) {
      const branch = (spot.branch || '').toUpperCase();
      const key = `${spot.day}|${branch}`;
      if (!byDay.has(key)) byDay.set(key, { day: spot.day, branch, spots: [] });
      byDay.get(key)!.spots.push(spot);
    }

    const bubbles = [...byDay.values()].sort((a, b) => {
      if (a.day !== b.day) return a.day - b.day;
      return a.branch.localeCompare(b.branch);
    }).map(group => ({
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: DM_PALETTE.sky, paddingAll: 'md', spacing: 'xs',
        contents: [
          { type: 'text', text: `DAY ${group.day}${group.branch ? `-${group.branch}` : ''}`, size: 'xs', color: DM_PALETTE.passport, weight: 'bold' },
          { type: 'text', text: trip.trip_name, size: 'md', color: DM_PALETTE.ink, weight: 'bold', wrap: true }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: DM_PALETTE.cream, paddingAll: 'md',
        contents: group.spots.map((s, idx) => {
          const validUrl = s.maps_url && typeof s.maps_url === 'string' && s.maps_url.startsWith('http') ? s.maps_url : null;
          const contents: any[] = [
            { type: 'text', text: `${idx + 1}`, size: 'xs', weight: 'bold', color: DM_PALETTE.woodDark, flex: 0 },
            { type: 'text', text: s.name, size: 'sm', weight: 'bold', color: DM_PALETTE.ink, wrap: true, flex: 1 }
          ];
          if (validUrl) contents.push({ type: 'button', action: { type: 'uri', label: '🗺️', uri: validUrl }, style: 'link', height: 'sm', flex: 0 });
          return { type: 'box', layout: 'horizontal', spacing: 'xs', paddingAll: 'sm', backgroundColor: DM_PALETTE.paper, cornerRadius: 'md', borderColor: DM_PALETTE.border, borderWidth: '1px', contents };
        })
      }
    }));

    if (bubbles.length === 1) return { type: 'flex', altText: `${trip.trip_name} 行程資訊`, contents: bubbles[0] } as any;
    return { type: 'flex', altText: `${trip.trip_name} 行程資訊`, contents: { type: 'carousel', contents: bubbles.slice(0, 10) } } as any;
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
    console.log('[LineHandler.handlePostback] data:', data);

    let groupId = 'unknown';
    if (source?.type === 'group') groupId = source.groupId;
    if (source?.type === 'room') groupId = source.roomId;

    const displayName = await this.getDisplayName(groupId, userId);
    try {
      if (groupId === 'unknown') {
        const cmd = data.startsWith('cmd=') ? decodeURIComponent(data.substring(4)) : data;
        let dmReply: messagingApi.Message | null = null;
        if (cmd === '查看現有旅程') dmReply = await this.buildCurrentFlex(userId);
        if (cmd === '查看歷史旅程') dmReply = await this.buildHistoryFlex(userId);
        const dmListMatch = cmd.match(/^私訊清單\s*#(\d+)$/);
        if (dmListMatch) dmReply = await this.buildTripDetailFlex(userId, parseInt(dmListMatch[1], 10));
        const dmItineraryMatch = cmd.match(/^私訊行程\s*#(\d+)$/);
        if (dmItineraryMatch) dmReply = await this.buildTripItineraryFlex(userId, parseInt(dmItineraryMatch[1], 10));
        const dmOldHistoryMatch = cmd.match(/^歷史\s*#(\d+)$/);
        if (dmOldHistoryMatch) dmReply = await this.buildTripDetailFlex(userId, parseInt(dmOldHistoryMatch[1], 10));
        if (dmReply && event.replyToken) {
          await this.reply(event.replyToken, dmReply);
          return;
        }
      }
      const replyText = await this.mainAgent.processPostback(groupId, userId, displayName, data);
      console.log('[LineHandler.handlePostback] replyText 類型:', typeof replyText, replyText ? '有內容' : '沒有內容');
      if (replyText && event.replyToken) {
        await this.reply(event.replyToken, replyText);
      }
    } catch (e: any) {
      console.error('[handlePostback] error:', e);
      if (event.replyToken) {
        try {
          await this.reply(event.replyToken, `⚠️ 發生錯誤：${e?.message || String(e)}`);
        } catch (_) {}
      }
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
    
    try {
      console.log('[LineHandler.reply] 準備發送訊息，數量:', messages.length, '第一則類型:', messages[0]?.type);
      
      // 詳細檢查 Flex Message
      if (messages[0]?.type === 'flex') {
        const flexMsg = messages[0] as any;
        console.log('[LineHandler.reply] Flex altText:', flexMsg.altText);
        console.log('[LineHandler.reply] Flex contents type:', flexMsg.contents?.type);
        
        // 分段輸出 JSON 避免被截斷
        const fullJson = JSON.stringify(flexMsg.contents, null, 2);
        console.log('[LineHandler.reply] Flex JSON 長度:', fullJson.length);
        console.log('[LineHandler.reply] Flex JSON (0-800):', fullJson.substring(0, 800));
        if (fullJson.length > 800) {
          console.log('[LineHandler.reply] Flex JSON (800-1600):', fullJson.substring(800, 1600));
        }
        if (fullJson.length > 1600) {
          console.log('[LineHandler.reply] Flex JSON (1600-2400):', fullJson.substring(1600, 2400));
        }
      }
      
      await this.client.replyMessage({ replyToken, messages });
      console.log('[LineHandler.reply] 發送成功');
    } catch (e: any) {
      // 錯誤時也輸出完整訊息內容
      console.error('[LineHandler.reply] 發送失敗:', e.message);
      console.error('[LineHandler.reply] 錯誤的 message 類型:', messages[0]?.type);
      if (messages[0]?.type === 'flex') {
        try {
          const json = JSON.stringify(messages[0], null, 2);
          console.error('[LineHandler.reply] 錯誤的 Flex JSON 前 1000 字:', json.substring(0, 1000));
        } catch (jsonErr) {
          console.error('[LineHandler.reply] 無法序列化錯誤的 Flex Message');
        }
      }
      throw e;
    }
  }
}
