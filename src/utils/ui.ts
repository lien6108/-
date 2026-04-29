import { messagingApi } from '@line/bot-sdk';

// ─── 記帳成功確認 Flex ────────────────────────────────────────────────────────

export function createExpenseSuccessFlex(
  exp: { group_seq: number; description: string; amount: number; payer_name: string; currency?: string; original_amount?: number },
  splits: { debtor_name: string; share_amount: number }[]
): messagingApi.FlexMessage {
  const amountText = exp.currency && exp.currency !== 'TWD' && exp.original_amount
    ? `${exp.currency} ${exp.original_amount}（≈ TWD ${exp.amount}）`
    : `TWD ${exp.amount}`;

  const sharerText = splits.length > 0
    ? `${splits.map(s => s.debtor_name).join('、')}（各 ${splits[0].share_amount}）`
    : '（無分攤人）';

  const rows: any[] = [
    { label: '📋 項目', value: exp.description },
    { label: '💰 金額', value: amountText },
    { label: '🙋 付款人', value: exp.payer_name },
    { label: '👥 分攤人', value: sharerText },
  ].map(item => ({
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: [
      { type: 'text', text: item.label, size: 'sm', color: '#888888', flex: 3 },
      { type: 'text', text: item.value, size: 'sm', color: '#333333', flex: 5, wrap: true, weight: 'bold' }
    ]
  }));

  return {
    type: 'flex',
    altText: `✅ 已記帳 #${exp.group_seq} ${exp.description} ${exp.amount}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: '#2ecc71',
        contents: [
          { type: 'text', text: '✅ 記帳成功', weight: 'bold', color: '#ffffff', size: 'md', flex: 1 },
          { type: 'text', text: `#${exp.group_seq}`, color: '#d5f5e3', size: 'sm', align: 'end', flex: 0 }
        ]
      },
      body: { type: 'box', layout: 'vertical', contents: rows },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'message', label: '🗑 刪除', text: `刪除 #${exp.group_seq}` }, style: 'secondary', height: 'sm', flex: 1 },
          { type: 'button', action: { type: 'message', label: '📋 清單', text: '清單' }, style: 'secondary', height: 'sm', flex: 1 },
          { type: 'button', action: { type: 'message', label: '➕ 記帳', text: '開始記帳' }, style: 'primary', height: 'sm', color: '#2ecc71', flex: 1 }
        ]
      }
    }
  } as any;
}

// ─── 開始記帳說明卡片 ──────────────────────────────────────────────────────────

export function createTemplateGuideMessage(members: { display_name: string }[]): messagingApi.Message[] {
  const memberList = members.map(m => m.display_name).join('、') || '（尚無成員）';

  const msg1: messagingApi.Message = {
    type: 'text',
    text:
      '💡 記帳方式說明\n\n' +
      '【簡易記帳】\n' +
      '若此筆金額使用台幣，且由您為所有人付款，可直接輸入：\n' +
      '  記帳 晚餐 500\n' +
      '（注意：「記帳」後要空格，名稱與金額之間也要空格）\n\n' +
      '【完整格式】\n' +
      '若有指定幣別、付款人或分攤人，請複製下一則訊息填寫。\n' +
      '範例：\n' +
      '名稱：拉麵\n' +
      '金額：800\n' +
      '幣別：JPY\n' +
      '支付者：Alice\n' +
      '分攤人：@Bob 或 所有人\n\n' +
      `目前成員：${memberList}`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '🍴 餐費 500', text: '記帳 餐費 500' } },
        { type: 'action', action: { type: 'message', label: '🚗 交通 100', text: '記帳 交通 100' } },
        { type: 'action', action: { type: 'message', label: '🛍️ 購物 300', text: '記帳 購物 300' } },
        { type: 'action', action: { type: 'message', label: '🏠 住宿 1000', text: '記帳 住宿 1000' } },
        { type: 'action', action: { type: 'message', label: '🍹 飲料 150', text: '記帳 飲料 150' } },
        { type: 'action', action: { type: 'message', label: '🎁 雜支 200', text: '記帳 雜支 200' } },
      ]
    }
  };

  const msg2: messagingApi.Message = {
    type: 'text',
    text: '名稱：\n金額：\n幣別：\n支付者：\n分攤人：'
  };

  return [msg1, msg2];
}

export interface QuickReplyOptions {
  groupSeq?: number;
  showSettlePreview?: boolean;
  showSettleConfirm?: boolean;
  showList?: boolean;
  showModify?: boolean;
  showDelete?: boolean;
  showAddExpense?: boolean;
}

const CANCEL = '取消';

function qr(label: string, text: string): messagingApi.QuickReplyItem {
  return { type: 'action', action: { type: 'message', label, text } };
}

export function getStandardQuickReply(options: QuickReplyOptions = {}): messagingApi.QuickReply {
  const items: messagingApi.QuickReplyItem[] = [];

  if (options.groupSeq) {
    items.push(qr(`刪除 #${options.groupSeq}`, `刪除 #${options.groupSeq}`));
    items.push(qr(`修改金額 #${options.groupSeq}`, `修改金額 #${options.groupSeq}`));
    items.push(qr(`修改幣別 #${options.groupSeq}`, `修改幣別 #${options.groupSeq}`));
    items.push(qr(`修改分攤人 #${options.groupSeq}`, `修改分攤人 #${options.groupSeq}`));
  } else {
    if (options.showDelete !== false) items.push(qr('刪除', '刪除'));
    if (options.showModify !== false) items.push(qr('修改', '修改'));
  }

  if (options.showAddExpense !== false) items.push(qr('開始記帳', '開始記帳'));
  if (options.showList !== false) items.push(qr('清單', '清單'));
  if (options.showSettlePreview) items.push(qr('結算', '結算'));
  if (options.showSettleConfirm) items.push(qr('確認結算', '確認結算'));
  items.push(qr(CANCEL, CANCEL));

  return { items: items.slice(0, 13) };
}

export function createExpenseListFlex(expenses: any[], totalTwd: number): messagingApi.FlexMessage {
  const rows = expenses.map(exp => {
    const amountText = exp.currency && exp.currency !== 'TWD' && exp.original_amount
      ? `${exp.currency} ${exp.original_amount}`
      : `TWD ${exp.amount}`;

    return {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: `#${exp.group_seq}`, size: 'xs', color: '#888888', flex: 1 },
            { type: 'text', text: exp.description, size: 'sm', flex: 3, weight: 'bold', wrap: true },
            { type: 'text', text: amountText, size: 'sm', flex: 3, align: 'end' },
            { type: 'text', text: exp.payer_name, size: 'xs', flex: 2, align: 'end', color: '#555555' }
          ]
        },
        { type: 'separator', margin: 'md', color: '#eeeeee' }
      ],
      margin: 'md'
    };
  });

  const bodyContents: any[] = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '編號', size: 'xs', color: '#aaaaaa', flex: 1 },
        { type: 'text', text: '項目', size: 'xs', color: '#aaaaaa', flex: 3 },
        { type: 'text', text: '金額', size: 'xs', color: '#aaaaaa', flex: 3, align: 'end' },
        { type: 'text', text: '付款人', size: 'xs', color: '#aaaaaa', flex: 2, align: 'end' }
      ]
    },
    { type: 'separator', margin: 'sm' },
    ...rows,
    {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'separator', margin: 'lg' },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '總計 (TWD)', weight: 'bold', size: 'md', flex: 1 },
            { type: 'text', text: `${Math.round(totalTwd * 100) / 100}`, weight: 'bold', size: 'md', align: 'end' }
          ],
          margin: 'md'
        }
      ]
    }
  ];

  return {
    type: 'flex',
    altText: '未結算清單',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📝 未結算記帳清單', weight: 'bold', size: 'lg', color: '#ffffff' }
        ],
        backgroundColor: '#46494c'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'button', action: { type: 'message', label: '❌ 取消', text: '取消' }, style: 'link', height: 'sm', color: '#ff4d4f' }
        ]
      }
    }
  } as any;
}

export function createDraftFlex(draft: any, isPrivate = false, ownerId: string): messagingApi.FlexMessage {
  const summary = [
    { label: '幣別', value: draft.currency || 'TWD' },
    { label: '金額', value: draft.amount ? `${draft.amount}` : '尚未設定' },
    { label: '項目', value: draft.description || '尚未設定' },
    { label: '付款人', value: draft.payerName || '尚未設定' },
    { label: '分攤', value: draft.sharerNames?.join('、') || '全部分攤' }
  ];

  const ownerSuffix = `&owner=${ownerId}`;

  const rows = summary.map(item => ({
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: item.label, size: 'sm', color: '#aaaaaa', flex: 2 },
      { type: 'text', text: item.value, size: 'sm', color: '#333333', flex: 4, weight: 'bold', wrap: true }
    ],
    margin: 'md'
  }));

  return {
    type: 'flex',
    altText: '記帳草稿',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📝 記帳草稿', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: `👤 編輯者：${draft.editorName || '本人'}`, size: 'xs', color: '#cccccc' }
        ],
        backgroundColor: '#46494c'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: rows
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: '✅ 確認送出', data: `action=submit_draft${ownerSuffix}` }, style: 'primary', height: 'sm', color: '#46494c' },
          { type: 'button', action: { type: 'postback', label: '➕ 繼續修改', data: `action=back_to_carousel${ownerSuffix}` }, style: 'secondary', height: 'sm' },
          { type: 'button', action: { type: 'message', label: '❌ 取消', text: '取消' }, style: 'link', height: 'sm', color: '#ff4d4f' }
        ]
      }
    }
  } as any;
}

export function createSelectionFlex(title: string, subtitle: string, items: { label: string, data: string, style?: string }[]): messagingApi.FlexMessage {
  const buttons = items.map(item => ({
    type: 'button',
    action: { type: 'postback', label: item.label, data: item.data },
    style: item.style || 'secondary',
    height: 'sm',
    margin: 'sm'
  }));

  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: subtitle, size: 'xs', color: '#cccccc' }
        ],
        backgroundColor: '#46494c'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons
      }
    }
  } as any;
}

export function createUnifiedDraftCarousel(ownerId: string, members: any[]): messagingApi.FlexMessage {
  const os = `&owner=${ownerId}`;
  
  // Page 1: Calculator
  const calcRows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['0', 'DEL', 'CLR']];
  const calcGrid = calcRows.map(row => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', contents: row.map(key => ({
      type: 'button', action: { type: 'postback', label: key, data: `action=${key==='DEL'?'num_back':key==='CLR'?'num_clear':'num_press'}${key!=='DEL'&&key!=='CLR'?'&val='+key:''}${os}` },
      style: 'secondary', height: 'sm'
    })), margin: 'sm'
  }));

  // Page 2: Categories
  const cats = ['🍴餐費', '🚗交通', '🛍️購物', '🏠住宿', '🍹飲料', '🎁雜支'];
  const catButtons = cats.map(c => ({
    type: 'button', action: { type: 'postback', label: c, data: `action=set_category_silent&val=${encodeURIComponent(c)}${os}` },
    style: 'secondary', height: 'sm', margin: 'xs'
  }));

  // Page 3: Currency & Payer
  const currs = ['TWD', 'USD', 'JPY', 'KRW'];
  const currButtons = currs.map(c => ({
    type: 'button', action: { type: 'postback', label: c, data: `action=set_currency_silent&val=${c}${os}` },
    style: 'secondary', height: 'sm', margin: 'xs', flex: 1
  }));
  const payerButtons = [
    { label: '本人', val: 'me' },
    ...members.slice(0, 3).map(m => ({ label: m.display_name, val: m.display_name }))
  ].map(p => ({
    type: 'button', action: { type: 'postback', label: p.label, data: `action=set_payer_silent&val=${encodeURIComponent(p.val)}${os}` },
    style: 'secondary', height: 'sm', margin: 'xs'
  }));

  const commonFooter = {
    type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: [
      { type: 'button', action: { type: 'uri', label: '⚡ 快速記帳 (LIFF)', uri: 'https://liff.line.me/LIFF_ID_PLACEHOLDER' }, style: 'secondary', height: 'sm', color: '#00b900' },
      { type: 'button', action: { type: 'postback', label: '🔍 預覽草稿', data: `action=show_draft${os}` }, style: 'primary', height: 'sm', color: '#46494c' },
      { type: 'button', action: { type: 'message', label: '❌ 取消', text: '取消' }, style: 'link', height: 'sm' }
    ]
  };

  return {
    type: 'flex',
    altText: '開始記帳',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble', size: 'mega',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#46494c', contents: [{ type: 'text', text: '1️⃣ 輸入金額', weight: 'bold', color: '#ffffff' }] },
          body: { type: 'box', layout: 'vertical', contents: [...calcGrid, commonFooter] }
        },
        {
          type: 'bubble', size: 'mega',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#46494c', contents: [{ type: 'text', text: '2️⃣ 選擇項目', weight: 'bold', color: '#ffffff' }] },
          body: { type: 'box', layout: 'vertical', contents: [...catButtons, commonFooter] }
        },
        {
          type: 'bubble', size: 'mega',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#46494c', contents: [{ type: 'text', text: '3️⃣ 幣別與付款', weight: 'bold', color: '#ffffff' }] },
          body: { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '幣別', size: 'xs', color: '#aaaaaa', margin: 'md' },
            { type: 'box', layout: 'horizontal', contents: currButtons },
            { type: 'text', text: '付款人', size: 'xs', color: '#aaaaaa', margin: 'md' },
            ...payerButtons,
            commonFooter
          ] }
        }
      ]
    }
  } as any;
}
