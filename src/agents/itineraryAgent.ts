import { messagingApi } from '@line/bot-sdk';
import { CRUD, ItinerarySpot, FlightInfo, Accommodation, FoodItem } from '../db/crud';
import { getCancelQuickReply } from '../utils/ui';

type DayRef = { day: number; branch: string };

function normalizeBranch(branch?: string | null): string {
  return (branch || '').trim().replace(/^-/, '').toUpperCase();
}

function dayKey(day: number, branch = ''): string {
  const b = normalizeBranch(branch);
  return `${day}|${b}`;
}

function formatDayRef(day: number, branch = ''): string {
  const b = normalizeBranch(branch);
  return `D${day}${b ? `-${b}` : ''}`;
}

function parseDayRef(raw: string): DayRef | null {
  const m = raw.trim().match(/^[Dd](\d+)(?:-?([A-Za-z]))?$/);
  if (!m) return null;
  return { day: parseInt(m[1], 10), branch: normalizeBranch(m[2]) };
}

function sortDayRefs(a: DayRef, b: DayRef): number {
  if (a.day !== b.day) return a.day - b.day;
  return a.branch.localeCompare(b.branch);
}

// 解析一行 AI 輸出：D1 / D1-A 景點名稱 [| maps_url]
function parseLine(line: string): { day: number; branch: string; name: string; mapsUrl?: string } | null {
  const m = line.trim().match(/^[Dd](\d+)(?:-?([A-Za-z]))?\s+([^|]+?)(?:\s*\|\s*(https?:\/\/\S+))?$/);
  if (!m) return null;
  return {
    day: parseInt(m[1], 10),
    branch: normalizeBranch(m[2]),
    name: m[3].trim(),
    mapsUrl: m[4]?.trim(),
  };
}

export class ItineraryAgent {
  constructor(private crud: CRUD) {}

  // ─── 顯示給使用者複製的 AI 提示詞，並進入等待匯入狀態 ─────────────────────
  // ─── 新增行程：先讓使用者選方式 ──────────────────────────────────────────
  async showAIPrompt(groupId: string, userId: string): Promise<messagingApi.Message> {
    return {
      type: 'text',
      text: '🗺️ 請選擇新增行程的方式：\n\n🤖 AI 規劃\n讓 AI 根據班機、住宿資訊幫你安排最順的路線\n\n📋 轉換格式\n你已有規劃，讓 AI 幫你轉換成系統格式',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '🤖 AI 規劃', data: 'cmd=行程 AI規劃' } },
          { type: 'action', action: { type: 'postback', label: '📋 轉換格式', data: 'cmd=行程 轉換格式' } },
          { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
        ]
      }
    };
  }

  // ─── AI 規劃：組出含班機/住宿 context 的 prompt ────────────────────────────
  async showAIPlanPrompt(groupId: string, userId: string): Promise<messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    const tripName = trip?.trip_name || '旅程';

    await this.crud.upsertSession(userId, groupId, 'AWAITING_ITINERARY_IMPORT', '{}');

    // 讀取班機與住宿
    let flightContext = '';
    let accommodationContext = '';
    let daysHint = '';

    if (trip) {
      const flights = await this.crud.getFlights(trip.id);
      const outbounds = flights.filter(f => f.type === 'outbound').sort((a, b) => a.depart_date.localeCompare(b.depart_date) || a.depart_time.localeCompare(b.depart_time));
      const returns = flights.filter(f => f.type === 'return').sort((a, b) => a.depart_date.localeCompare(b.depart_date) || a.depart_time.localeCompare(b.depart_time));

      if (outbounds.length > 0) {
        const first = outbounds[0];
        const last = outbounds[outbounds.length - 1];
        const dept = first.depart_airport ? `${first.depart_airport} ` : '';
        const arr = last.arrive_airport ? `→ ${last.arrive_airport} ` : '';
        flightContext += `去程：${first.depart_date} ${dept}${first.depart_time} ${arr}抵達 ${last.arrive_time}${outbounds.length > 1 ? `（含 ${outbounds.length - 1} 次轉機）` : first.flight_no ? `（${first.flight_no}）` : ''}\n`;
      }
      if (returns.length > 0) {
        const first = returns[0];
        const last = returns[returns.length - 1];
        const dept = first.depart_airport ? `${first.depart_airport} ` : '';
        const arr = last.arrive_airport ? `→ ${last.arrive_airport} ` : '';
        flightContext += `回程：${first.depart_date} ${dept}${first.depart_time} ${arr}抵達 ${last.arrive_time}${returns.length > 1 ? `（含 ${returns.length - 1} 次轉機）` : first.flight_no ? `（${first.flight_no}）` : ''}\n`;
      }

      const accoms = await this.crud.getAccommodations(trip.id);
      if (accoms.length > 0) {
        const maxDay = Math.max(...accoms.map(a => a.day_to));
        daysHint = `${maxDay + 1}天${maxDay}夜`;
        for (const a of accoms) {
          const range = a.day_from === a.day_to ? `D${a.day_from}` : `D${a.day_from}-D${a.day_to}`;
          const ci = a.checkin_time ? ` 入住${a.checkin_time}` : '';
          const co = a.checkout_time ? ` 退房${a.checkout_time}` : '';
          const who = a.who ? `（${a.who}）` : '';
          accommodationContext += `${range}：${a.name}${ci}${co}${who}\n`;
        }
      }
    }

    // 組 context 區段
    let contextBlock = '';
    if (flightContext || accommodationContext) {
      contextBlock += '\n\n【旅程資訊】\n';
      if (flightContext) contextBlock += flightContext;
      if (accommodationContext) contextBlock += '住宿：\n' + accommodationContext;
      contextBlock +=
        '\n【規劃原則】\n' +
        '1. 第一天根據去程班機抵達時間安排，抵達前不排景點\n' +
        '2. 最後一天根據回程班機出發時間安排，需預留前往機場的交通時間（至少2小時前）\n' +
        '3. 每天路線從當晚住宿地點附近出發，最終回到當晚住宿地點附近\n' +
        '4. 如同天更換飯店，下午行程安排在新飯店附近\n' +
        '5. 入住／退房時間前後的景點需安排在飯店附近\n' +
        '6. 每個景點都必須附上 Google Maps 連結（住宿地點除外）';
    }

    const prompt =
      `幫我規劃【${tripName}】${daysHint ? daysHint : ''}的旅遊行程，每天3-5個景點，路線要最順（減少重複移動）。${contextBlock}\n\n` +
      `========== 以下格式請勿修改 ==========\n` +
      `請按以下格式輸出，不要多餘說明，每個景點一行：\n` +
      `D1 景點名稱 | google map對應連結\n` +
      `D1 另一個景點 | google map對應連結\n` +
      `D2 景點名稱 | google map對應連結\n` +
      `（每個景點都必須附 Google Maps 連結；住宿地點不需要輸出）\n` +
      `======================================`;

    const intro: messagingApi.Message = {
      type: 'text',
      text:
        `🤖 AI 行程規劃\n\n` +
        `請複製下方指令，貼到 ChatGPT 或 Gemini，生成後再貼回群組。\n\n` +
        `📝 【 】內的資訊可以自行修改\n` +
        `⚠️ 格式區段（=== 以下格式請勿修改 === 至 ====== 之間）切勿調整，否則可能導致匯入失敗\n\n` +
        `貼回後將直接匯入，若需先確認請點「取消」。`,
      quickReply: getCancelQuickReply()
    };

    const command: messagingApi.Message = {
      type: 'text',
      text: prompt,
      quickReply: getCancelQuickReply()
    };

    return [intro, command];
  }

  // ─── 轉換格式：給使用者格式轉換 prompt ────────────────────────────────────
  async showConvertPrompt(groupId: string, userId: string): Promise<messagingApi.Message[]> {
    await this.crud.upsertSession(userId, groupId, 'AWAITING_ITINERARY_IMPORT', '{}');

    const intro: messagingApi.Message = {
      type: 'text',
      text:
        `📋 行程格式轉換\n\n` +
        `請複製下方指令，貼到 ChatGPT 或 Gemini，\n` +
        `再把你自己的行程計畫貼在指令後面，讓 AI 轉換格式後再貼回群組。\n\n` +
        `⚠️ 貼回後將直接匯入，若需先確認請點「取消」。`,
      quickReply: getCancelQuickReply()
    };

    const command: messagingApi.Message = {
      type: 'text',
      text:
        `請將以下行程轉換成指定格式，不要多餘說明，每個景點一行：\n\n` +
        `格式規則：\n` +
        `• D1、D2... 代表第幾天\n` +
        `• 每行：D天數 景點名稱（需加 | Google Maps 連結）\n` +
        `• 同一天多個景點請分多行\n\n` +
        `輸出範例：\n` +
        `D1 淺草寺 | google map 連結\n` +
        `D1 上野公園 | google map 連結\n` +
        `D2 新宿御苑 | google map 連結\n\n` +
        `--- 以下是我的行程 ---\n` +
        `（請在此貼上你的行程）`,
      quickReply: getCancelQuickReply()
    };

    return [intro, command];
  }

  // ─── 解析 AI 貼回的文字，批次匯入景點 ────────────────────────────────────
  async importSpots(groupId: string, text: string): Promise<string | messagingApi.Message | messagingApi.Message[] | null> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程，請先輸入「加入」建立旅程 🗺️';

    const lines = text.split('\n');
    const valid: { day: number; branch: string; name: string; mapsUrl?: string }[] = [];
    const skipped: string[] = [];

    lines.forEach((line) => {
      if (!line.trim()) return;
      const parsed = parseLine(line);
      if (parsed) valid.push(parsed);
      else skipped.push(line.trim());
    });

    if (valid.length === 0) return null;

    for (const spot of valid) {
      await this.crud.addSpot(trip.id, spot.day, spot.name, spot.mapsUrl, spot.branch);
    }

    const days = [...new Set(valid.map(v => v.day))].sort((a, b) => a - b);
    const dayRefs = [...new Set(valid.map(v => formatDayRef(v.day, v.branch)))];
    const skippedNote = skipped.length > 0
      ? `\n\n⚠️ 以下 ${skipped.length} 行格式不符已略過：\n${skipped.slice(0, 5).map(l => `• ${l}`).join('\n')}${skipped.length > 5 ? '\n...' : ''}`
      : '';

    const successMsg: messagingApi.Message = {
      type: 'text',
      text: `✅ 已匯入 ${valid.length} 個景點，共 ${days.length} 天${dayRefs.some(ref => ref.includes('-')) ? `（含 ${dayRefs.join('、')}）` : ''}${skippedNote}`,
    };

    // 補上住宿位置連結（有填寫 maps_url 才顯示）
    const accomList = await this.crud.getAccommodations(trip.id);
    const accomWithUrl = accomList.filter(a => a.maps_url &&
      days.some(d => d >= a.day_from && d <= a.day_to)
    );
    const messages: messagingApi.Message[] = [successMsg];
    if (accomWithUrl.length > 0) {
      const lines = accomWithUrl.map(a => {
        const range = a.day_from === a.day_to ? `D${a.day_from}` : `D${a.day_from}-D${a.day_to}`;
        return `${range} 🏨 ${a.name}\n${a.maps_url}`;
      });
      messages.push({
        type: 'text',
        text: `🏨 住宿位置連結：\n\n${lines.join('\n\n')}`,
      });
    }

    const carousel = await this.showDayItinerary(groupId);
    messages.push(carousel as messagingApi.Message);
    return messages;
  }

  // ─── 建立單天 bubble ──────────────────────────────────────────────────────
  private buildDayBubble(tripName: string, day: number, daySpots: ItinerarySpot[], forCarousel = false, branch = ''): any {
    const branchLabel = formatDayRef(day, branch);
    const branchSuffix = normalizeBranch(branch) ? `-${normalizeBranch(branch)}` : '';
    const palette = {
      sky: '#9ccfe8',
      skyDark: '#5f8fa8',
      cream: '#fff8e8',
      paper: '#fffdf5',
      wood: '#b98a55',
      woodDark: '#7a5632',
      passport: '#234b68',
      ink: '#3f3328',
      muted: '#8f7a62',
      orange: '#f4a261',
      danger: '#a66b5b',
      border: '#ead8b8'
    };

    const rows: any[] = daySpots.map((s, idx) => {
      const validUrl = s.maps_url && typeof s.maps_url === 'string' && s.maps_url.startsWith('http') ? s.maps_url : null;
      if (forCarousel) {
        // carousel 模式：純瀏覽，只顯示名稱和地圖連結，不放刪除按鈕
        const titleBox: any = {
          type: 'box', layout: 'vertical', flex: 1,
          contents: [
            {
              type: 'box', layout: 'baseline', spacing: 'sm',
              contents: [
                { type: 'text', text: `${idx + 1}`, size: 'xs', weight: 'bold', color: palette.woodDark, flex: 0 },
                { type: 'text', text: s.name, size: 'sm', wrap: true, weight: 'bold', color: palette.ink, flex: 1 }
              ]
            }
          ]
        };
        if (s.notes) {
          titleBox.contents.push({
            type: 'text', text: s.notes, size: 'xxs', color: palette.muted, wrap: true, margin: 'xs'
          });
        }
        const contents: any[] = [titleBox];
        if (validUrl) {
          contents.push({ type: 'button', action: { type: 'uri', label: '🗺️', uri: validUrl }, style: 'link', height: 'sm', flex: 0 });
        }
        contents.push({ type: 'button', action: { type: 'postback', label: '🍜', data: `cmd=景點美食 #${s.id}` }, style: 'link', height: 'sm', flex: 0 });
        return {
          type: 'box', layout: 'horizontal', spacing: 'xs', margin: idx === 0 ? 'none' : 'sm', paddingAll: 'sm',
          backgroundColor: palette.paper, cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px',
          contents
        };
      }
      // single bubble 管理模式：地點旁直接上下移動，刪除放在下方，不顯示地圖
      const titleBox: any = {
        type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: `${idx + 1}. ${s.name}`, size: 'sm', wrap: true, color: palette.ink, weight: 'bold' }
        ]
      };
      if (s.notes) {
        titleBox.contents.push(
          { type: 'text', text: s.notes, size: 'xxs', color: palette.muted, wrap: true, margin: 'xs' }
        );
      }
      const rowContents: any[] = [
        {
          type: 'box', layout: 'horizontal', spacing: 'xs', contents: [
            titleBox,
            { type: 'button', action: { type: 'postback', label: '↑', data: `cmd=上移景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 0 },
            { type: 'button', action: { type: 'postback', label: '↓', data: `cmd=下移景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 0 }
          ]
        },
        {
          type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'xs', contents: [
            { type: 'button', action: { type: 'postback', label: '備註', data: `cmd=景點備註 #${s.id}` }, style: 'secondary', height: 'sm', flex: 1 },
            { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除景點 #${s.id}` }, style: 'secondary', height: 'sm', flex: 1 }
          ]
        }
      ];
      return {
        type: 'box', layout: 'vertical', spacing: 'xs', margin: idx === 0 ? 'none' : 'sm', paddingAll: 'sm',
        backgroundColor: palette.paper, cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px',
        contents: rowContents
      };
    });

    const bodyContents: any[] = rows.length > 0 ? rows : [{ type: 'text', text: '（尚未新增景點）', size: 'sm', color: palette.muted }];
    const isDayDone = daySpots.length > 0 && daySpots.every(s => s.status === 'done');

    const footerContents = forCarousel
      ? [
          { type: 'button', action: { type: 'postback', label: '管理', data: `cmd=管理行程 D${day}${branchSuffix}` }, style: 'secondary', height: 'sm' },
          { type: 'button', action: { type: 'postback', label: '🛍️', data: `cmd=購物車 D${day}` }, style: 'secondary', height: 'sm' },
          { type: 'button', action: { type: 'postback', label: isDayDone ? '復原' : '完成', data: `${isDayDone ? 'cmd=復原行程' : 'cmd=完成行程'} D${day}${branchSuffix}` }, style: 'secondary', height: 'sm' }
        ]
      : [
          { type: 'button', action: { type: 'postback', label: '新增', data: `cmd=新增景點 D${day}${branchSuffix}` }, style: 'secondary', height: 'sm' }
        ];

    const headerContents: any[] = forCarousel
      ? [{
          type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            {
              type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
                { type: 'text', text: branchLabel.replace('D', 'DAY '), weight: 'bold', color: palette.passport, size: 'xs' },
                { type: 'text', text: tripName, weight: 'bold', color: palette.ink, size: 'md', wrap: true }
              ]
            },
            ...(normalizeBranch(branch) ? [] : [{ type: 'button', action: { type: 'postback', label: '分組', data: `cmd=分組行程 D${day}` }, style: 'link', height: 'sm', flex: 0 }])
          ]
        }]
      : [
          { type: 'text', text: `${branchLabel.replace('D', 'DAY ')} 管理`, weight: 'bold', color: '#ffffff', size: 'xs' },
          { type: 'text', text: '景點調整小木牌', weight: 'bold', color: '#ffffff', size: 'md', wrap: true }
        ];

    return {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: forCarousel ? palette.sky : palette.passport, paddingAll: 'md', spacing: 'xs',
        contents: headerContents
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
        contents: bodyContents
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
        contents: footerContents
      }
    };
  }

  // ─── 單天管理 bubble（帶刪除按鈕）────────────────────────────────────────
  async showSingleDayManage(groupId: string, day: number, branch = ''): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const spots = await this.crud.getSpotsByDay(trip.id, day, branch);
    const bubble = this.buildDayBubble(trip.trip_name, day, spots, false, branch);
    return { type: 'flex', altText: `${formatDayRef(day, branch)} 管理`, contents: bubble } as any;
  }

  async completeDay(groupId: string, day: number, branch?: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    await this.crud.markDaySpotsDone(trip.id, day, branch);
    return await this.showDayItinerary(groupId, day, branch);
  }

  async restoreDay(groupId: string, day: number, branch?: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    await this.crud.markDaySpotsPending(trip.id, day, branch);
    return await this.showDayItinerary(groupId, day, branch);
  }

  async showDayBranches(groupId: string, day: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const palette = {
      cream: '#fff8e8', paper: '#fffdf5', ink: '#3f3328', muted: '#8f7a62', border: '#ead8b8',
      branches: [
        { key: 'A', bg: '#9ccfe8', title: '#234b68', accent: '#5f8fa8' },
        { key: 'B', bg: '#f0b98a', title: '#7a5632', accent: '#b98a55' }
      ]
    };

    const buildBranch = (branch: typeof palette.branches[number], branchSpots: ItinerarySpot[]) => ({
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: branch.bg, paddingAll: 'md', spacing: 'xs',
        contents: [
          { type: 'text', text: `D${day}-${branch.key}`, weight: 'bold', color: branch.title, size: 'lg' },
          { type: 'text', text: `${trip.trip_name}・分組路線`, size: 'xs', color: branch.title, wrap: true }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
        contents: branchSpots.length > 0 ? branchSpots.map((s, idx) => ({
          type: 'box', layout: 'horizontal', spacing: 'xs', paddingAll: 'sm', cornerRadius: 'md', backgroundColor: palette.paper, borderColor: palette.border, borderWidth: '1px',
          contents: [
            { type: 'text', text: `${idx + 1}`, size: 'xs', weight: 'bold', color: branch.accent, flex: 0 },
            { type: 'text', text: s.name, size: 'sm', weight: 'bold', color: palette.ink, wrap: true, flex: 1 }
          ]
        })) : [{ type: 'text', text: '（尚未新增分組景點）', size: 'sm', color: palette.muted }]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
        contents: [
          { type: 'button', action: { type: 'postback', label: '新增', data: `cmd=新增景點 D${day}-${branch.key}` }, style: 'secondary', height: 'sm', flex: 1 },
          { type: 'button', action: { type: 'postback', label: '管理', data: `cmd=管理行程 D${day}-${branch.key}` }, style: 'secondary', height: 'sm', flex: 1 }
        ]
      }
    });

    const branchA = await this.crud.getSpotsByDay(trip.id, day, 'A');
    const branchB = await this.crud.getSpotsByDay(trip.id, day, 'B');
    return {
      type: 'flex',
      altText: `D${day} 分組行程`,
      contents: { type: 'carousel', contents: [buildBranch(palette.branches[0], branchA), buildBranch(palette.branches[1], branchB)] }
    } as any;
  }

  async showMoveSpotMenu(groupId: string, day: number): Promise<messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return { type: 'text', text: '目前沒有進行中的旅程 🗺️' };
    const spots = await this.crud.getSpotsByDay(trip.id, day);
    if (spots.length <= 1) return { type: 'text', text: `第 ${day} 天只有 ${spots.length} 個景點，無需調整順序。` };

    const items: messagingApi.QuickReplyItem[] = [];
    for (const s of spots) {
      const shortName = s.name.length > 8 ? s.name.slice(0, 8) + '..' : s.name;
      items.push({ type: 'action', action: { type: 'postback', label: `${shortName} 上移`, data: `cmd=上移景點 #${s.id}` } });
      items.push({ type: 'action', action: { type: 'postback', label: `${shortName} 下移`, data: `cmd=下移景點 #${s.id}` } });
    }
    items.push({ type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } });

    const spotList = spots.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    return {
      type: 'text',
      text: `第 ${day} 天景點順序：\n\n${spotList}\n\n請選擇要移動的景點：`,
      quickReply: { items: items.slice(0, 13) }
    };
  }

  // ─── 顯示所有天行程（carousel）────────────────────────────────────────────
  async showDayItinerary(groupId: string, day?: number, branch?: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const spots = await this.crud.getAllSpots(trip.id);
    if (spots.length === 0) {
      return '目前沒有行程景點。\n\n輸入「新增旅遊行程」取得 AI 提示詞來匯入行程。';
    }

    const byDay = new Map<string, { ref: DayRef; spots: ItinerarySpot[] }>();
    for (const s of spots) {
      const ref = { day: s.day, branch: normalizeBranch(s.branch) };
      const key = dayKey(ref.day, ref.branch);
      if (!byDay.has(key)) byDay.set(key, { ref, spots: [] });
      byDay.get(key)!.spots.push(s);
    }

    let refs = [...byDay.values()].map(group => group.ref).sort((a, b) => {
      const aDone = byDay.get(dayKey(a.day, a.branch))!.spots.every(s => s.status === 'done');
      const bDone = byDay.get(dayKey(b.day, b.branch))!.spots.every(s => s.status === 'done');
      if (aDone !== bDone) return aDone ? 1 : -1;
      return sortDayRefs(a, b);
    });
    if (day) {
      const targetKey = dayKey(day, branch);
      if (byDay.has(targetKey)) {
        refs = [byDay.get(targetKey)!.ref, ...refs.filter(ref => dayKey(ref.day, ref.branch) !== targetKey)];
      } else {
        refs = refs.sort((a, b) => {
          if (a.day === day && b.day !== day) return -1;
          if (a.day !== day && b.day === day) return 1;
          return sortDayRefs(a, b);
        });
      }
    }

    if (refs.length === 1) {
      const ref = refs[0];
      const bubble = this.buildDayBubble(trip.trip_name, ref.day, byDay.get(dayKey(ref.day, ref.branch))!.spots, true, ref.branch);
      return { type: 'flex', altText: `${trip.trip_name} 行程`, contents: bubble } as any;
    }
    const bubbles = refs.map(ref => this.buildDayBubble(trip.trip_name, ref.day, byDay.get(dayKey(ref.day, ref.branch))!.spots, true, ref.branch));
    return { type: 'flex', altText: `${trip.trip_name} 行程`, contents: { type: 'carousel', contents: bubbles.slice(0, 10) } } as any;
  }

  // ─── showFullItinerary 直接呼叫 showDayItinerary（從第一天開始）────────────
  async showFullItinerary(groupId: string): Promise<string | messagingApi.Message> {
    return this.showDayItinerary(groupId);
  }

  // ─── 刪除景點 ─────────────────────────────────────────────────────────────
  async moveSpot(groupId: string, spotId: number, direction: 'up' | 'down'): Promise<messagingApi.Message | messagingApi.Message[] | string> {
    const spot = await this.crud.getSpotById(spotId);
    await this.crud.moveSpot(spotId, direction);
    return spot ? await this.showSingleDayManage(groupId, spot.day, spot.branch || '') : await this.showDayItinerary(groupId);
  }

  async deleteSpot(groupId: string, spotId: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const spot = await this.crud.getSpotById(spotId);
    await this.crud.deleteSpot(spotId);
    return spot ? await this.showSingleDayManage(groupId, spot.day, spot.branch || '') : await this.showDayItinerary(groupId);
  }

  // ─── 景點備註：啟動 wizard ─────────────────────────────────────────────────────
  async startSpotNotesWizard(groupId: string, userId: string, spotId: number): Promise<messagingApi.Message> {
    const spot = await this.crud.getSpotById(spotId);
    if (!spot) return { type: 'text', text: '找不到該景點。' };
    await this.crud.upsertSession(userId, groupId, 'AWAITING_SPOT_NOTES', JSON.stringify({ spotId, day: spot.day, branch: spot.branch || '' }));
    const currentNotes = spot.notes ? `\n\n目前備註：${spot.notes}` : '';
    return {
      type: 'text',
      text: `請輸入「${spot.name}」的備註：${currentNotes}\n\n（輸入「清空」可刪除備註）`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 景點備註：處理輸入 ───────────────────────────────────────────────────────
  async handleSpotNotesInput(groupId: string, text: string, spotId: number, day: number, branch: string): Promise<string | messagingApi.Message> {
    const spot = await this.crud.getSpotById(spotId);
    if (!spot) return '找不到該景點。';
    const notes = text.trim() === '清空' ? '' : text.trim();
    await this.crud.updateSpotNotes(spotId, notes);
    return await this.showSingleDayManage(groupId, day, branch);
  }

  private async getCurrentShoppingDay(tripId: number): Promise<number> {
    const spots = await this.crud.getAllSpots(tripId);
    if (spots.length === 0) return 1;
    const pending = spots.find(s => s.status !== 'done');
    return pending?.day ?? spots[0].day;
  }

  async showMyShoppingList(groupId: string, displayName: string, day?: number): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const palette = {
      cream: '#fff8e8', paper: '#fffdf5', wood: '#b98a55', passport: '#234b68', ink: '#3f3328', muted: '#8f7a62', border: '#ead8b8'
    };

    const isImageUrl = (url: string) => /\.(jpe?g|png|gif|webp|bmp)(\?.*)?$/i.test(url);
    const buildShoppingBubble = (targetDay: number, items: any[]): any => {
      const rows = items.length > 0 ? items.map(item => {
        // 向後相容：若 url 欄位為空，但 item 中包含 "/http"，則 parse 出來
        let itemName = item.item;
        let itemUrl = item.url;
        if (!itemUrl && typeof item.item === 'string') {
          // 找最後一個 / 且後面緊跟 http 的位置
          const matches = [...item.item.matchAll(/\/\s*(https?:\/\/[^\s]+)/gi)];
          if (matches.length > 0) {
            const lastMatch = matches[matches.length - 1];
            itemName = item.item.slice(0, lastMatch.index).trim();
            itemUrl = lastMatch[1].trim();
          }
        }
        const hasUrl = itemUrl && typeof itemUrl === 'string' && itemUrl.startsWith('http');
        const isImg = hasUrl && isImageUrl(itemUrl);
        const titleRow: any = {
          type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [
            { type: 'text', text: `${item.is_bought ? '✅' : '🛍️'} ${itemName}`, size: 'sm', weight: 'bold', color: item.is_bought ? palette.muted : palette.ink, wrap: true, flex: 1 },
            ...(hasUrl && !isImg ? [{ type: 'button', action: { type: 'uri', label: '🔗', uri: itemUrl }, style: 'link', height: 'sm', flex: 0 }] : [])
          ]
        };
        const rowContents: any[] = [titleRow];
        if (isImg) {
          rowContents.push({
            type: 'image', url: itemUrl, size: 'full', aspectMode: 'cover', aspectRatio: '20:13',
            margin: 'sm', action: { type: 'uri', uri: itemUrl }
          });
        }
        if (!item.is_bought) {
          rowContents.push({
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs', contents: [
              { type: 'button', action: { type: 'postback', label: '買好了', data: `cmd=買好了 #${item.id}` }, style: 'secondary', height: 'sm', flex: 1 },
              { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除購買 #${item.id}` }, style: 'secondary', height: 'sm', flex: 1 }
            ]
          });
        }
        return {
          type: 'box', layout: 'vertical', margin: 'sm', paddingAll: 'sm', backgroundColor: palette.paper,
          cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px',
          contents: rowContents
        };
      }) : [{ type: 'text', text: `第 ${targetDay} 天還沒有你的購買項目。`, size: 'sm', color: palette.muted, wrap: true }];

      return {
        type: 'bubble', size: 'kilo',
        header: { type: 'box', layout: 'vertical', backgroundColor: palette.wood, paddingAll: 'md', spacing: 'xs', contents: [
          { type: 'text', text: `DAY ${targetDay}`, size: 'xs', weight: 'bold', color: '#fff6df' },
          { type: 'text', text: '購物車', size: 'md', weight: 'bold', color: '#ffffff' }
        ] },
        body: { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md', contents: rows },
        footer: { type: 'box', layout: 'horizontal', backgroundColor: palette.cream, paddingAll: 'md', contents: [
          { type: 'button', action: { type: 'postback', label: '新增項目', data: `cmd=新增購物車 D${targetDay}` }, style: 'secondary', height: 'sm' }
        ] }
      };
    };

    if (day !== undefined) {
      const items = await this.crud.getShoppingItems(trip.id, day, displayName);
      return { type: 'flex', altText: '購物車', contents: buildShoppingBubble(day, items) } as any;
    }

    const spots = await this.crud.getAllSpots(trip.id);
    const allItems = await this.crud.getShoppingItems(trip.id, undefined, displayName);
    const days = [...new Set([...spots.map(s => s.day), ...allItems.map(item => item.day)])].sort((a, b) => a - b);
    const targetDays = days.length > 0 ? days : [await this.getCurrentShoppingDay(trip.id)];
    const bubbles = targetDays.slice(0, 10).map(targetDay => buildShoppingBubble(
      targetDay,
      allItems.filter(item => item.day === targetDay)
    ));
    return {
      type: 'flex', altText: '購物車',
      contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles }
    } as any;
  }

  async startShoppingWizard(groupId: string, userId: string, displayName: string, day?: number): Promise<messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return { type: 'text', text: '目前沒有進行中的旅程 🗺️' };
    const targetDay = day ?? await this.getCurrentShoppingDay(trip.id);
    await this.crud.upsertSession(userId, groupId, 'AWAITING_SHOPPING_INPUT', JSON.stringify({ day: targetDay, assignee: displayName }));
    return {
      type: 'text',
      text: `請輸入第 ${targetDay} 天要買的東西，可一次多行：\n\n例：\n防曬乳\n伴手禮\nD2 明信片\n餅乾 / https://example.com/image.jpg\n\n（加 / 連結 可附上圖片或商品連結）`,
      quickReply: getCancelQuickReply()
    };
  }

  async handleShoppingInput(groupId: string, text: string, assignee: string, defaultDay?: number): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const fallbackDay = defaultDay ?? await this.getCurrentShoppingDay(trip.id);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '請輸入要購買的項目。';

    let lastDay = fallbackDay;
    let count = 0;
    for (const line of lines) {
      // 支援格式：項目名稱 / 連結  或  D2 項目名稱 / 連結
      const dayMatch = line.match(/^[Dd](\d+)\s+(.+)$/);
      let restText = line;
      let day = fallbackDay;
      if (dayMatch) {
        day = parseInt(dayMatch[1], 10);
        restText = dayMatch[2];
      }
      // 切割 item 和 url（用 / 分隔）
      const slashIdx = restText.lastIndexOf('/');
      let itemName = restText.trim();
      let url: string | undefined;
      if (slashIdx > 0) {
        const possibleUrl = restText.slice(slashIdx + 1).trim();
        if (possibleUrl.startsWith('http')) {
          itemName = restText.slice(0, slashIdx).trim();
          url = possibleUrl;
        }
      }
      if (!itemName) continue;
      await this.crud.addShoppingItem(trip.id, assignee, itemName, day, url);
      lastDay = day;
      count++;
    }
    const msg: messagingApi.Message = { type: 'text', text: `✅ 已新增 ${count} 個購買項目。` };
    const list = await this.showMyShoppingList(groupId, assignee, lastDay);
    return [msg, list as messagingApi.Message];
  }

  async markShoppingBought(groupId: string, displayName: string, itemId: number): Promise<string | messagingApi.Message> {
    const item = await this.crud.getShoppingItemById(itemId);
    await this.crud.markItemBought(itemId);
    return await this.showMyShoppingList(groupId, displayName, item?.day);
  }

  async deleteShoppingItem(groupId: string, displayName: string, itemId: number): Promise<string | messagingApi.Message> {
    const item = await this.crud.getShoppingItemById(itemId);
    await this.crud.deleteShoppingItem(itemId);
    return await this.showMyShoppingList(groupId, displayName, item?.day);
  }

  // ─── 新增景點：啟動 wizard（支援多行）────────────────────────────────────────
  async startAddSpotWizard(groupId: string, userId: string, day: number, branch = ''): Promise<messagingApi.Message> {
    const normalizedBranch = normalizeBranch(branch);
    const ref = formatDayRef(day, normalizedBranch);
    await this.crud.upsertSession(userId, groupId, 'AWAITING_SPOT_INPUT', JSON.stringify({ day, branch: normalizedBranch }));
    return {
      type: 'text',
      text: `請輸入 ${ref} 新景點：\n\n格式：景點名稱 [| 地圖連結]\n\n範例：\n淺草寺\n新宿御苑 | https://maps.app.goo.gl/xxx`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 新增景點：解析並儲存（支援多行）────────────────────────────────────────
  async handleAddSpotInput(groupId: string, text: string, day: number, branch = ''): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const normalizedBranch = normalizeBranch(branch);
    const ref = formatDayRef(day, normalizedBranch);

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null as any;

    let count = 0;
    for (const line of lines) {
      const [name, mapsUrl] = line.split('|').map(s => s.trim());
      if (!name) continue;
      await this.crud.addSpot(trip.id, day, name, mapsUrl || undefined, normalizedBranch);
      count++;
    }
    if (count === 0) return null as any;

    const successMsg: messagingApi.Message = {
      type: 'text',
      text: count === 1
        ? `✅ 已新增景點：${lines[0].split('|')[0].trim()}（${ref}）`
        : `✅ 已新增 ${count} 個景點（${ref}）`
    };
    const manage = await this.showSingleDayManage(groupId, day, normalizedBranch);
    return [successMsg, manage as messagingApi.Message];
  }

  // ─── 清空行程：確認提示 ────────────────────────────────────────────────────
  async promptClearAllSpots(groupId: string): Promise<messagingApi.Message> {
    return {
      type: 'text',
      text: '⚠️ 確定要清空所有行程景點嗎？此操作無法復原。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '✅ 確認清空', data: 'cmd=確認清空行程' } },
          { type: 'action', action: { type: 'postback', label: '❌ 取消', data: 'cmd=取消' } },
        ]
      }
    };
  }

  // ─── 清空行程：執行 ────────────────────────────────────────────────────────
  async confirmClearAllSpots(groupId: string): Promise<messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return { type: 'text', text: '目前沒有進行中的旅程 🗺️' };
    await this.crud.clearAllSpots(trip.id);
    return {
      type: 'text',
      text: '🗑️ 已清空所有行程。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '新增旅遊行程', data: 'cmd=新增旅遊行程' } },
        ]
      }
    };
  }

  // ─── 偵測貼入文字是否為 AI 行程格式（≥2 行符合 D\d 格式）────────────────
  static isAIItineraryFormat(text: string): boolean {
    const lines = text.split('\n').filter(l => l.trim());
    const matches = lines.filter(l => /^[Dd]\d+\s+.+/.test(l.trim()));
    return matches.length >= 2;
  }

  // ─── 班機輸入解析（tokenizer 方式，支援機場代碼）──────────────────────────
  private parseFlightInput(text: string): {
    departDate: string; departTime: string; arriveTime: string;
    flightNo?: string; departAirport?: string; arriveAirport?: string;
  } | null {
    const parts = text.trim().split(/\s+/).map(p => {
      // 補齊時間格式：6:40 → 06:40
      return /^\d{1}:\d{2}$/.test(p) ? '0' + p : p;
    });
    let i = 0;
    const isTime = (s: string) => /^\d{2}:\d{2}$/.test(s);
    const isDate = (s: string) => /^(\d{4}\/)?\d{1,2}\/\d{1,2}$/.test(s);
    const isArrow = (s: string) => /^[→>\-]$/.test(s);
    const isTerminal = (s: string) => /^T\d+$/i.test(s);
    // 機場：非時間、非日期、非箭頭，且後面緊接時間（可能中間夾一個航廈 token，如 T1）
    const isAirport = (idx: number) => {
      const s = parts[idx] || '';
      if (isTime(s) || isDate(s) || isArrow(s)) return false;
      const next = parts[idx + 1] || '';
      return isTime(next) || (isTerminal(next) && isTime(parts[idx + 2] || ''));
    };
    // 讀取機場（含可選航廈），回傳合併字串並推進 i
    const readAirport = (): string => {
      let name = parts[i++];
      if (isTerminal(parts[i] || '')) name += ' ' + parts[i++];
      return name;
    };
    const normalizeDate = (s: string) => {
      if (/^\d{4}\//.test(s)) return s;
      return `${new Date().getFullYear()}/${s}`;
    };

    if (!isDate(parts[i] || '')) return null;
    const departDate = normalizeDate(parts[i++]);

    let departAirport: string | undefined;
    if (isAirport(i)) departAirport = readAirport();

    if (!isTime(parts[i] || '')) return null;
    const departTime = parts[i++];

    if (i < parts.length && isArrow(parts[i])) i++;

    let arriveAirport: string | undefined;
    if (isAirport(i)) arriveAirport = readAirport();

    if (!isTime(parts[i] || '')) return null;
    const arriveTime = parts[i++];

    const flightNo = i < parts.length ? parts.slice(i).join(' ') : undefined;
    return { departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport };
  }

  // ─── 班機資訊：啟動 wizard ─────────────────────────────────────────────────
  async startFlightWizard(groupId: string, userId: string, flightType: 'outbound' | 'return', addedByName?: string): Promise<messagingApi.Message> {
    const typeLabel = flightType === 'outbound' ? '去程' : '回程';
    await this.crud.upsertSession(userId, groupId, 'AWAITING_FLIGHT_INPUT', JSON.stringify({ flightType, addedByName: addedByName || '' }));
    return {
      type: 'text',
      text:
        `請輸入${typeLabel}班機資訊（有轉機可一次貼多行，每行一段）：\n\n` +
        `格式：日期 [機場 航廈] 出發時間 - [機場 航廈] 抵達時間 [航班號]\n\n` +
        `範例（直飛）：\n` +
        `2026/5/10 桃園 T1 08:30 - 東京成田 13:45 CI-100\n\n` +
        `範例（轉機，一次貼兩行）：\n` +
        `2026/5/10 桃園 T1 08:30 - 香港 T1 10:30 CX456\n` +
        `2026/5/10 香港 T1 12:00 - 東京成田 17:00 CX102\n\n` +
        `（機場、航廈和航班號均為選填；日期可略去年份，系統自動補上）`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 班機資訊：解析輸入並儲存 ─────────────────────────────────────────────
  async handleFlightInput(groupId: string, text: string, flightType: 'outbound' | 'return', addedByName?: string): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const typeLabel = flightType === 'outbound' ? '去程' : '回程';

    const successes: string[] = [];
    const failures: string[] = [];

    for (const line of lines) {
      const parsed = this.parseFlightInput(line);
      if (!parsed) {
        failures.push(line);
        continue;
      }
      const { departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport } = parsed;
      await this.crud.addFlight(trip.id, flightType, departDate, departTime, arriveTime, flightNo, departAirport, arriveAirport, addedByName);
      const routeText = departAirport && arriveAirport ? ` ${departAirport}→${arriveAirport}` : '';
      successes.push(`${departDate} ${departTime}→${arriveTime}${routeText}${flightNo ? `（${flightNo}）` : ''}`);
    }

    if (successes.length === 0) {
      return {
        type: 'text',
        text: `格式不符，請重新輸入。\n\n每行一筆，例：\n5/10 桃園 T1 08:30 - 香港 T1 10:30 CX456\n5/10 香港 T1 12:00 - 東京成田 17:00 CX102`,
        quickReply: getCancelQuickReply()
      };
    }

    const failNote = failures.length > 0
      ? `\n\n⚠️ 以下 ${failures.length} 行格式不符已略過：\n${failures.map(l => `• ${l}`).join('\n')}`
      : '';
    const successMsg: messagingApi.Message = {
      type: 'text',
      text: `✅ 已新增 ${successes.length} 筆${typeLabel}班機：\n${successes.map(s => `• ${s}`).join('\n')}${failNote}`
    };
    const flexMsg = await this.showFlights(groupId);
    return [successMsg, flexMsg as messagingApi.Message];
  }

  // ─── 班機資訊：顯示 Flex（支援多筆、每筆有刪除鈕）─────────────────────────
  async showFlights(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const palette = {
      sky: '#9ccfe8',
      cream: '#fff8e8',
      paper: '#fffdf5',
      passport: '#234b68',
      ink: '#3f3328',
      muted: '#8f7a62',
      border: '#ead8b8'
    };

    const flights = await this.crud.getFlights(trip.id);
    const outbounds = flights.filter(f => f.type === 'outbound');
    const returns = flights.filter(f => f.type === 'return');

    // 尚無任何班機 → 顯示輸入說明
    if (outbounds.length === 0 && returns.length === 0) {
      return {
        type: 'text',
        text: '✈️ 目前尚未設定班機資訊。\n\n請選擇要新增的方向：',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '新增去程', data: 'cmd=班機 去程' } },
            { type: 'action', action: { type: 'postback', label: '新增回程', data: 'cmd=班機 回程' } },
            { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
          ]
        }
      };
    }

    const buildFlightRow = (f: FlightInfo): any => {
      // 頂列：航班號（左）＋刪除按鈕（右）
      const topRow: any = {
        type: 'box', layout: 'horizontal', contents: [
          {
            type: 'text',
            text: [f.flight_no, f.depart_date].filter(Boolean).join('  '),
            size: 'sm', weight: 'bold', color: palette.ink, flex: 1
          },
          { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除班機 #${f.id}` }, style: 'secondary', height: 'sm', flex: 0 }
        ]
      };

      // 路線列：出發（左）→ 到達（右）
      const departCol: any = {
        type: 'box', layout: 'vertical', flex: 1, contents: [
          { type: 'text', text: f.depart_airport || '─', size: 'sm', weight: 'bold', color: palette.passport },
          { type: 'text', text: f.depart_time, size: 'lg', weight: 'bold', color: palette.ink, margin: 'xs' },
        ]
      };
      const arrowCol: any = {
        type: 'text', text: '✈', size: 'md', color: palette.muted, align: 'center',
        gravity: 'center', flex: 0, margin: 'md'
      };
      const arriveCol: any = {
        type: 'box', layout: 'vertical', flex: 1, contents: [
          { type: 'text', text: f.arrive_airport || '─', size: 'sm', weight: 'bold', color: palette.passport, align: 'end' },
          { type: 'text', text: f.arrive_time, size: 'lg', weight: 'bold', color: palette.ink, margin: 'xs', align: 'end' },
        ]
      };
      const routeRow: any = {
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [departCol, arrowCol, arriveCol]
      };

      // 底列：新增者
      const bottomContents: any[] = [];
      if (f.added_by_name) {
        bottomContents.push({ type: 'text', text: `由 ${f.added_by_name} 新增`, size: 'xs', color: palette.muted, margin: 'xs' });
      }

      return {
        type: 'box', layout: 'vertical', margin: 'md', paddingAll: 'md', backgroundColor: palette.paper,
        cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px',
        contents: [topRow, routeRow, ...bottomContents]
      };
    };

    const buildSection = (label: string, list: FlightInfo[], emptyText: string): any[] => {
      const header = { type: 'text', text: label, size: 'sm', weight: 'bold', color: palette.passport, margin: 'lg' };
      if (list.length === 0) {
        return [header, { type: 'text', text: emptyText, size: 'sm', color: palette.muted, margin: 'sm' }];
      }
      const rows: any[] = [];
      list.forEach((f, idx) => {
        rows.push(buildFlightRow(f));
      });
      return [header, ...rows];
    };

    const bodyContents: any[] = [
      ...buildSection('✈️ 去程', outbounds, '尚未設定'),
      ...buildSection('🛬 回程', returns, '尚未設定'),
    ];

    return {
      type: 'flex', altText: '班機資訊',
      contents: {
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: palette.sky, paddingAll: 'md', spacing: 'xs',
          contents: [
            { type: 'text', text: 'FLIGHT INFO', weight: 'bold', color: palette.passport, size: 'xs' },
            { type: 'text', text: `✈️ ${trip.trip_name}`, weight: 'bold', color: palette.ink, size: 'md', wrap: true }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: bodyContents, backgroundColor: palette.cream, paddingAll: 'md' },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
          contents: [
            { type: 'button', action: { type: 'postback', label: '去程', data: 'cmd=班機 去程' }, style: 'secondary', height: 'sm', flex: 1 },
            { type: 'button', action: { type: 'postback', label: '回程', data: 'cmd=班機 回程' }, style: 'secondary', height: 'sm', flex: 1 },
          ]
        }
      }
    } as any;
  }

  async deleteFlightById(groupId: string, flightId: number): Promise<string | messagingApi.Message> {
    await this.crud.deleteFlightById(flightId);
    return this.showFlights(groupId);
  }

  // ─── 住宿資訊：顯示 ────────────────────────────────────────────────────────
  async showAccommodations(groupId: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    const palette = {
      cream: '#fff8e8',
      paper: '#fffdf5',
      wood: '#b98a55',
      woodDark: '#7a5632',
      passport: '#234b68',
      ink: '#3f3328',
      muted: '#8f7a62',
      border: '#ead8b8'
    };

    const list = await this.crud.getAccommodations(trip.id);

    if (list.length === 0) {
      return {
        type: 'text',
        text: `「${trip.trip_name}」還沒有住宿資訊！`,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '＋ 新增住宿', data: 'cmd=新增住宿' } },
            { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
          ]
        }
      } as messagingApi.Message;
    }

    const body: any[] = [];
    list.forEach((a, i) => {
      if (i > 0) body.push({ type: 'separator', margin: 'md' });

      const nights = a.day_to - a.day_from + 1;
      const dayLabel = a.day_from === a.day_to
        ? `D${a.day_from}（1晚）`
        : `D${a.day_from} - D${a.day_to}（${nights}晚）`;
      const whoLabel = a.who ? a.who : '全員';
      const timeLabel = (a.checkin_time || a.checkout_time)
        ? `入住 ${a.checkin_time || '--:--'}  ·  退房 ${a.checkout_time || '--:--'}`
        : null;

      const rowContents: any[] = [
        {
          type: 'box', layout: 'horizontal', margin: i === 0 ? 'none' : 'md',
          contents: [
            { type: 'text', text: a.name, size: 'sm', weight: 'bold', color: palette.ink, flex: 1, wrap: true },
            { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除住宿 #${a.id}` }, style: 'secondary', height: 'sm', flex: 0 }
          ]
        },
        { type: 'text', text: `${dayLabel}  ·  ${whoLabel}`, size: 'xs', color: palette.woodDark, margin: 'xs' },
      ];
      if (timeLabel) {
        rowContents.push({ type: 'text', text: timeLabel, size: 'xs', color: palette.passport, margin: 'none' });
      }
      if (a.added_by_name) {
        rowContents.push({ type: 'text', text: `由 ${a.added_by_name} 新增`, size: 'xs', color: palette.muted, margin: 'none' });
      }
      if (a.maps_url) {
        rowContents.push({
          type: 'button',
          action: { type: 'uri', label: '🗺️', uri: a.maps_url },
          style: 'secondary', height: 'sm', margin: 'xs'
        });
      }

      body.push({
        type: 'box', layout: 'vertical', contents: rowContents, margin: 'md', paddingAll: 'md',
        backgroundColor: palette.paper, cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px'
      });
    });

    return {
      type: 'flex', altText: '住宿資訊',
      contents: {
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: palette.wood, paddingAll: 'md', spacing: 'xs',
          contents: [
            { type: 'text', text: 'STAY INFO', weight: 'bold', color: '#fff6df', size: 'xs' },
            { type: 'text', text: `🏨 ${trip.trip_name}`, weight: 'bold', color: '#ffffff', size: 'md', wrap: true }
          ]
        },
        body: { type: 'box', layout: 'vertical', contents: body, backgroundColor: palette.cream, paddingAll: 'md' },
        footer: {
          type: 'box', layout: 'horizontal', backgroundColor: palette.cream, paddingAll: 'md',
          contents: [
            { type: 'button', action: { type: 'postback', label: '新增住宿', data: 'cmd=新增住宿' }, style: 'secondary', height: 'sm' }
          ]
        }
      }
    } as any;
  }

  // ─── 住宿資訊：啟動 wizard ─────────────────────────────────────────────────
  async startAccommodationWizard(groupId: string, userId: string, addedByName?: string): Promise<messagingApi.Message> {
    await this.crud.upsertSession(userId, groupId, 'AWAITING_ACCOMMODATION_INPUT', JSON.stringify({ addedByName: addedByName || '' }));
    return {
      type: 'text',
      text:
        `請輸入住宿資訊：\n\n` +
        `格式：D開始天[-結束天] 飯店名稱 [check-in-check-out] [/ Maps連結] [@誰]\n\n` +
        `範例：\n` +
        `D1-D3 台北凱撒大飯店 15:00-11:00 / https://maps.app.goo.gl/xxx\n` +
        `D4 大阪難波飯店 14:00-12:00 @Alice\n` +
        `D4-D5 京都旅館 @Bob @Carol\n\n` +
        `（時間、Maps連結和@誰均為選填）`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 住宿資訊：解析並儲存 ─────────────────────────────────────────────────
  async handleAccommodationInput(groupId: string, text: string, addedByName?: string): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';

    // 格式：D1[-D3] 名稱 [HH:MM-HH:MM] [/ maps] [@who...]
    const m = text.trim().match(/^[Dd](\d+)(?:-[Dd](\d+))?\s+([^/@\d:]+?)(?:\s+(\d{2}:\d{2})-(\d{2}:\d{2}))?(?:\s*\/\s*(https?:\/\/\S+))?(?:\s+((?:@\S+\s*)+))?$/);
    if (!m) {
      return {
        type: 'text',
        text: '格式不符，請重新輸入：\n格式：D開始天[-結束天] 飯店名稱 [check-in-check-out] [/ Maps連結] [@誰]\n例：D1-D3 台北凱撒大飯店 15:00-11:00 / https://maps.app.goo.gl/xxx',
        quickReply: getCancelQuickReply()
      };
    }
    const dayFrom = parseInt(m[1], 10);
    const dayTo = m[2] ? parseInt(m[2], 10) : dayFrom;
    const name = m[3].trim();
    const checkinTime = m[4]?.trim();
    const checkoutTime = m[5]?.trim();
    const mapsUrl = m[6]?.trim();
    const whoRaw = m[7]?.trim();
    const who = whoRaw ? whoRaw.split(/\s+/).map(w => w.replace(/^@/, '')).join('、') : undefined;

    await this.crud.addAccommodation(trip.id, dayFrom, dayTo, name, checkinTime, checkoutTime, mapsUrl, who, addedByName);
    const nights = dayTo - dayFrom + 1;
    const nightLabel = nights === 1 ? '1晚' : `${nights}晚`;
    const whoLabel = who ? `（${who}）` : '';
    const successMsg: messagingApi.Message = { type: 'text', text: `✅ 已新增住宿：${name}，D${dayFrom}${dayTo !== dayFrom ? `-D${dayTo}` : ''}（${nightLabel}）${whoLabel}` };
    const flex = await this.showAccommodations(groupId);
    return [successMsg, flex as messagingApi.Message];
  }

  // ─── 住宿資訊：刪除 ────────────────────────────────────────────────────────
  async deleteAccommodationById(groupId: string, id: number): Promise<string | messagingApi.Message> {
    await this.crud.deleteAccommodation(id);
    return this.showAccommodations(groupId);
  }

  // ─── 美食清單：顯示 ──────────────────────────────────────────────────────────
  async showSpotFoodList(groupId: string, spotId: number, displayName: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const spot = await this.crud.getSpotById(spotId);
    if (!spot) return '找不到該景點。';
    const isImageUrl = (url: string) => /\.(jpe?g|png|gif|webp|bmp)(\?.*)?$/i.test(url);
    const palette = {
      green: '#6aaa8c', cream: '#fff8e8', paper: '#fffdf5', ink: '#3f3328',
      muted: '#8f7a62', border: '#ead8b8'
    };
    const items = await this.crud.getFoodItemsBySpot(trip.id, spotId, displayName);

    if (items.length === 0) {
      return {
        type: 'text',
        text: `🍜 「${spot.name}」還沒有美食記錄！\n\n要新增想吃的店嗎？`,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '新增美食', data: `cmd=美食選景點 #${spotId}` } },
            { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
          ]
        }
      } as messagingApi.Message;
    }

    const rows = items.map(fi => {
      // 向後相容：parse URL from item text if maps_url is empty
      let itemName = fi.item;
      let itemUrl = fi.maps_url;
      if (!itemUrl && typeof fi.item === 'string') {
        const matches = [...fi.item.matchAll(/\/\s*(https?:\/\/[^\s]+)/gi)];
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          itemName = fi.item.slice(0, lastMatch.index).trim();
          itemUrl = lastMatch[1].trim();
        }
      }
      const hasUrl = itemUrl && typeof itemUrl === 'string' && itemUrl.startsWith('http');
      const isImg = hasUrl && isImageUrl(itemUrl);
      const titleRow: any = {
        type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [
          { type: 'text', text: `${fi.is_eaten ? '✅' : '🍜'} ${itemName}`, size: 'sm', weight: 'bold', color: fi.is_eaten ? palette.muted : palette.ink, wrap: true, flex: 1 },
          ...(hasUrl && !isImg ? [{ type: 'button', action: { type: 'uri', label: '🗺️', uri: itemUrl }, style: 'link', height: 'sm', flex: 0 }] : [])
        ]
      };
      const rowContents: any[] = [titleRow];
      if (isImg) {
        rowContents.push({
          type: 'image', url: itemUrl, size: 'full', aspectMode: 'cover', aspectRatio: '20:13',
          margin: 'sm', action: { type: 'uri', uri: itemUrl }
        });
      }
      if (!fi.is_eaten) {
        rowContents.push({
          type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs', contents: [
            { type: 'button', action: { type: 'postback', label: '吃了', data: `cmd=美食吃了 #${fi.id}` }, style: 'secondary', height: 'sm', flex: 1 },
            { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除美食 #${fi.id}` }, style: 'secondary', height: 'sm', flex: 1 }
          ]
        });
      }
      return {
        type: 'box', layout: 'vertical', margin: 'sm', paddingAll: 'sm',
        backgroundColor: palette.paper, cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px',
        contents: rowContents
      };
    });

    const bubble: any = {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: palette.green, paddingAll: 'md', spacing: 'xs',
        contents: [
          { type: 'text', text: `DAY ${spot.day}`, size: 'xs', weight: 'bold', color: palette.cream },
          { type: 'text', text: `🍜 ${spot.name}`, size: 'md', weight: 'bold', color: '#ffffff', wrap: true }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
        contents: rows
      },
      footer: {
        type: 'box', layout: 'horizontal', backgroundColor: palette.cream, paddingAll: 'md',
        contents: [
          { type: 'button', action: { type: 'postback', label: '新增', data: `cmd=美食選景點 #${spotId}` }, style: 'secondary', height: 'sm' }
        ]
      }
    };
    return { type: 'flex', altText: `${spot.name} 美食清單`, contents: bubble } as any;
  }

  async showFoodList(groupId: string, displayName: string): Promise<string | messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const isImageUrl = (url: string) => /\.(jpe?g|png|gif|webp|bmp)(\?.*)?$/i.test(url);
    const palette = {
      green: '#6aaa8c', cream: '#fff8e8', paper: '#fffdf5', ink: '#3f3328',
      muted: '#8f7a62', border: '#ead8b8'
    };

    const items = await this.crud.getFoodItems(trip.id, displayName);

    if (items.length === 0) {
      return {
        type: 'text',
        text: '🍜 還沒有美食清單！\n\n選擇景點並點「新增美食」就能記錄想吃的店。',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '新增美食', data: 'cmd=新增美食' } },
            { type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } },
          ]
        }
      } as messagingApi.Message;
    }

    const bySpot = new Map<string, FoodItem[]>();
    for (const item of items) {
      const key = `${item.day}|${item.spot_name}`;
      if (!bySpot.has(key)) bySpot.set(key, []);
      bySpot.get(key)!.push(item);
    }

    const buildSpotBubble = (spotKey: string, spotItems: FoodItem[]): any => {
      const pipeIdx = spotKey.indexOf('|');
      const day = parseInt(spotKey.slice(0, pipeIdx), 10);
      const spotName = spotKey.slice(pipeIdx + 1);
      const spotId = spotItems[0].spot_id;

      const rows = spotItems.map(fi => {
        // 向後相容：parse URL from item text if maps_url is empty
        let itemName = fi.item;
        let itemUrl = fi.maps_url;
        if (!itemUrl && typeof fi.item === 'string') {
          const matches = [...fi.item.matchAll(/\/\s*(https?:\/\/[^\s]+)/gi)];
          if (matches.length > 0) {
            const lastMatch = matches[matches.length - 1];
            itemName = fi.item.slice(0, lastMatch.index).trim();
            itemUrl = lastMatch[1].trim();
          }
        }
        const hasUrl = itemUrl && typeof itemUrl === 'string' && itemUrl.startsWith('http');
        const isImg = hasUrl && isImageUrl(itemUrl);
        const titleRow: any = {
          type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [
            { type: 'text', text: `${fi.is_eaten ? '✅' : '🍜'} ${itemName}`, size: 'sm', weight: 'bold', color: fi.is_eaten ? palette.muted : palette.ink, wrap: true, flex: 1 },
            ...(hasUrl && !isImg ? [{ type: 'button', action: { type: 'uri', label: '🗺️', uri: itemUrl }, style: 'link', height: 'sm', flex: 0 }] : [])
          ]
        };
        const rowContents: any[] = [titleRow];
        if (isImg) {
          rowContents.push({
            type: 'image', url: itemUrl, size: 'full', aspectMode: 'cover', aspectRatio: '20:13',
            margin: 'sm', action: { type: 'uri', uri: itemUrl }
          });
        }
        if (!fi.is_eaten) {
          rowContents.push({
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs', contents: [
              { type: 'button', action: { type: 'postback', label: '吃了', data: `cmd=美食吃了 #${fi.id}` }, style: 'secondary', height: 'sm', flex: 1 },
              { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除美食 #${fi.id}` }, style: 'secondary', height: 'sm', flex: 1 }
            ]
          });
        }
        return {
          type: 'box', layout: 'vertical', margin: 'sm', paddingAll: 'sm',
          backgroundColor: palette.paper, cornerRadius: 'md', borderColor: palette.border, borderWidth: '1px',
          contents: rowContents
        };
      });

      return {
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: palette.green, paddingAll: 'md', spacing: 'xs',
          contents: [
            { type: 'text', text: `DAY ${day}`, size: 'xs', weight: 'bold', color: palette.cream },
            { type: 'text', text: `🍜 ${spotName}`, size: 'md', weight: 'bold', color: '#ffffff', wrap: true }
          ]
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: palette.cream, paddingAll: 'md',
          contents: rows
        },
        footer: {
          type: 'box', layout: 'horizontal', backgroundColor: palette.cream, paddingAll: 'md',
          contents: [
            { type: 'button', action: { type: 'postback', label: '新增', data: `cmd=美食選景點 #${spotId ?? 0}` }, style: 'secondary', height: 'sm' }
          ]
        }
      };
    };

    const keys = [...bySpot.keys()].sort((a, b) => parseInt(a.split('|')[0], 10) - parseInt(b.split('|')[0], 10));
    const bubbles = keys.map(k => buildSpotBubble(k, bySpot.get(k)!));
    return {
      type: 'flex', altText: '美食清單',
      contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles.slice(0, 10) }
    } as any;
  }

  // ─── 美食清單：啟動 wizard（快捷選景點）──────────────────────────────────────
  async startFoodWizard(groupId: string): Promise<messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return { type: 'text', text: '目前沒有進行中的旅程 🗺️' };
    const spots = await this.crud.getAllSpots(trip.id);
    if (spots.length === 0) {
      return { type: 'text', text: '目前行程還沒有景點，請先新增景點後再來記錄想吃的店。', quickReply: getCancelQuickReply() };
    }
    const qrItems: messagingApi.QuickReplyItem[] = spots.slice(0, 12).map(s => {
      const raw = `D${s.day} ${s.name}`;
      const label = raw.length > 20 ? raw.slice(0, 19) + '…' : raw;
      return { type: 'action', action: { type: 'postback', label, data: `cmd=美食選景點 #${s.id}` } };
    });
    qrItems.push({ type: 'action', action: { type: 'postback', label: '取消', data: 'cmd=取消' } });
    return { type: 'text', text: '請選擇要新增美食的景點：', quickReply: { items: qrItems } };
  }

  // ─── 美食清單：選好景點 → 設定 session 等待輸入 ────────────────────────────
  async promptFoodForSpot(groupId: string, userId: string, spotId: number, displayName: string): Promise<messagingApi.Message> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return { type: 'text', text: '目前沒有進行中的旅程 🗺️' };
    const spot = await this.crud.getSpotById(spotId);
    if (!spot) return { type: 'text', text: '找不到該景點，請重新選擇。', quickReply: getCancelQuickReply() };
    await this.crud.upsertSession(userId, groupId, 'AWAITING_FOOD_INPUT', JSON.stringify({
      spotId: spot.id, spotName: spot.name, day: spot.day, assignee: displayName
    }));
    return {
      type: 'text',
      text: `請輸入在「${spot.name}」想吃的東西，可一次多行；附導航連結請在店名後加 / https://...：\n\n例：\n一蘭拉麵\n元祖牛舌 / https://maps.google.com/...`,
      quickReply: getCancelQuickReply()
    };
  }

  // ─── 美食清單：解析並儲存 ─────────────────────────────────────────────────────
  async handleFoodInput(groupId: string, text: string, spotId: number | null, spotName: string, day: number, assignee: string): Promise<string | messagingApi.Message | messagingApi.Message[]> {
    const trip = await this.crud.getCurrentTrip(groupId);
    if (!trip) return '目前沒有進行中的旅程 🗺️';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '請輸入要記錄的美食。';
    for (const line of lines) {
      let itemName = line;
      let mapsUrl: string | undefined;
      const slashIdx = line.lastIndexOf('/');
      if (slashIdx > 0) {
        const possibleUrl = line.slice(slashIdx + 1).trim();
        if (possibleUrl.startsWith('http')) {
          itemName = line.slice(0, slashIdx).trim();
          mapsUrl = possibleUrl;
        }
      }
      await this.crud.addFoodItem(trip.id, spotId, spotName, day, assignee, itemName, mapsUrl);
    }
    const msg: messagingApi.Message = { type: 'text', text: `✅ 已新增 ${lines.length} 個美食項目。` };
    const list = await this.showFoodList(groupId, assignee);
    return [msg, list as messagingApi.Message];
  }

  // ─── 美食清單：標記已吃 ───────────────────────────────────────────────────────
  async markFoodEaten(groupId: string, displayName: string, itemId: number): Promise<string | messagingApi.Message> {
    await this.crud.markFoodEaten(itemId);
    return await this.showFoodList(groupId, displayName);
  }

  // ─── 美食清單：刪除項目 ───────────────────────────────────────────────────────
  async deleteFoodItem(groupId: string, displayName: string, itemId: number): Promise<string | messagingApi.Message> {
    await this.crud.deleteFoodItem(itemId);
    return await this.showFoodList(groupId, displayName);
  }
}
