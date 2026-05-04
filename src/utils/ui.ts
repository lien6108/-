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
    { label: '📝 項目', value: exp.description },
    { label: '💰 金額', value: amountText },
    { label: '💳 付款人', value: exp.payer_name },
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
        type: 'box', layout: 'horizontal', backgroundColor: '#7b93b9',
        contents: [
          { type: 'text', text: '✅ 記帳成功', weight: 'bold', color: '#ffffff', size: 'md', flex: 1 },
          { type: 'text', text: `#${exp.group_seq}`, color: '#ccd4db', size: 'sm', align: 'end', flex: 0 }
        ]
      },
      body: { type: 'box', layout: 'vertical', contents: rows },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: '修改', data: `cmd=修改 #${exp.group_seq}` }, style: 'secondary', height: 'sm', flex: 1 },
          { type: 'button', action: { type: 'postback', label: '刪除', data: `cmd=刪除 #${exp.group_seq}` }, style: 'secondary', height: 'sm', flex: 1 },
          { type: 'button', action: { type: 'postback', label: '清單', data: 'cmd=清單' }, style: 'primary', height: 'sm', color: '#7a9aaa', flex: 1 }
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
      '📝 記帳方式說明\n\n' +
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
        { type: 'action', action: { type: 'postback', label: '🍴 餐費 500', data: 'cmd=記帳 餐費 500' } },
        { type: 'action', action: { type: 'postback', label: '🚗 交通 100', data: 'cmd=記帳 交通 100' } },
        { type: 'action', action: { type: 'postback', label: '🛍️ 購物 300', data: 'cmd=記帳 購物 300' } },
        { type: 'action', action: { type: 'postback', label: '🏠 住宿 1000', data: 'cmd=記帳 住宿 1000' } },
        { type: 'action', action: { type: 'postback', label: '🍹 飲料 150', data: 'cmd=記帳 飲料 150' } },
        { type: 'action', action: { type: 'postback', label: '🎁 雜支 200', data: 'cmd=記帳 雜支 200' } },
      ]
    }
  };

  const templateText = '名稱：\n金額：\n幣別：\n支付者：\n分攤人：';
  const msg2: messagingApi.Message = {
    type: 'text',
    text: templateText,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'clipboard', label: '📋 複製模板', clipboardText: templateText }
        }
      ]
    }
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
  return { type: 'action', action: { type: 'postback', label, data: 'cmd=' + text } };
}

export function getStandardQuickReply(options: QuickReplyOptions = {}): messagingApi.QuickReply {
  const items: messagingApi.QuickReplyItem[] = [];

  if (options.groupSeq) {
    items.push(qr(`刪除 #${options.groupSeq}`, `刪除 #${options.groupSeq}`));
    items.push(qr(`修改金額 #${options.groupSeq}`, `修改金額 #${options.groupSeq}`));
    items.push(qr(`修改幣別 #${options.groupSeq}`, `修改幣別 #${options.groupSeq}`));
    items.push(qr(`修改分攤人 #${options.groupSeq}`, `修改分攤人 #${options.groupSeq}`));
  }

  items.push(qr('開始記帳', '開始記帳'));
  items.push(qr('修改帳單', '修改帳單'));
  items.push(qr('刪除帳單', '刪除帳單'));
  items.push(qr('完整清單', '清單'));
  items.push(qr('查看成員', '成員'));
  items.push(qr('完整說明', '說明'));
  if (options.showSettlePreview) items.push(qr('結算', '結算'));
  if (options.showSettleConfirm) items.push(qr('確認結算', '確認結算'));
  items.push(qr('修改旅程名稱', '修改旅程名稱'));
  items.push(qr(CANCEL, CANCEL));

  return { items: items.slice(0, 13) };
}

// 主選單快捷（@機器人 第一層）
export function getMainMenuQuickReply(): messagingApi.QuickReply {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '💰 記帳功能', data: 'action=menu_accounting' } },
      { type: 'action', action: { type: 'postback', label: '🗺️ 行程功能', data: 'action=menu_itinerary' } },
      qr('修改旅程名稱', '修改旅程名稱'),
      qr('查看成員', '成員'),
      qr('完整說明', '說明'),
      qr(CANCEL, CANCEL),
    ]
  };
}

// 記帳功能快捷（第二層）
export function getAccountingQuickReply(options: QuickReplyOptions = {}): messagingApi.QuickReply {
  const items: messagingApi.QuickReplyItem[] = [];
  if (options.groupSeq) {
    items.push(qr(`刪除 #${options.groupSeq}`, `刪除 #${options.groupSeq}`));
    items.push(qr(`修改金額 #${options.groupSeq}`, `修改金額 #${options.groupSeq}`));
    items.push(qr(`修改幣別 #${options.groupSeq}`, `修改幣別 #${options.groupSeq}`));
    items.push(qr(`修改分攤人 #${options.groupSeq}`, `修改分攤人 #${options.groupSeq}`));
  }
  items.push(qr('開始記帳', '開始記帳'));
  items.push(qr('修改帳單', '修改帳單'));
  items.push(qr('刪除帳單', '刪除帳單'));
  items.push(qr('完整清單', '清單'));
  if (options.showSettlePreview) items.push(qr('結算', '結算'));
  if (options.showSettleConfirm) items.push(qr('確認結算', '確認結算'));
  items.push({ type: 'action', action: { type: 'postback', label: '⬅️ 返回主選單', data: 'action=menu_main' } });
  items.push(qr(CANCEL, CANCEL));
  return { items: items.slice(0, 13) };
}

// 行程功能快捷（第二層）
export function getItineraryQuickReply(): messagingApi.QuickReply {
  return {
    items: [
      qr('✈️ 班機資訊', '班機資訊'),
      qr('🗺️ 行程', '行程'),
      qr('新增旅遊行程', '新增旅遊行程'),
      qr('歷史記錄', '歷史'),
      { type: 'action', action: { type: 'postback', label: '⬅️ 返回主選單', data: 'action=menu_main' } },
      qr(CANCEL, CANCEL),
    ]
  };
}

// 單一取消按鈕（等待輸入流程中使用）
export function getCancelQuickReply(): messagingApi.QuickReply {
  return { items: [qr(CANCEL, CANCEL)] };
}

// 修改/刪除特定帳單的快捷（expenseAgent / wizardAgent 共用）
export function getExpenseEditQuickReply(groupSeq: number): messagingApi.QuickReply {
  return {
    items: [
      qr(`修改金額 #${groupSeq}`, `修改金額 #${groupSeq}`),
      qr(`修改幣別 #${groupSeq}`, `修改幣別 #${groupSeq}`),
      qr(`修改支付人 #${groupSeq}`, `修改支付人 #${groupSeq}`),
      qr(`修改分攤人 #${groupSeq}`, `修改分攤人 #${groupSeq}`),
      qr(CANCEL, CANCEL),
    ]
  };
}

// 加入群組事件快捷
export function getJoinQuickReply(): messagingApi.QuickReply {
  return {
    items: [
      qr('加入', '加入'),
      qr('查看說明', '說明'),
    ]
  };
}

// 追蹤（Follow）事件快捷
export function getFollowQuickReply(): messagingApi.QuickReply {
  return {
    items: [
      qr('查看說明', '說明'),
      qr('歷史紀錄', '歷史'),
    ]
  };
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
        backgroundColor: '#6b7a8d'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: '只看我的帳', data: 'cmd=只看我的帳' }, style: 'secondary', height: 'sm', flex: 2 },
          { type: 'button', action: { type: 'postback', label: '結算', data: 'cmd=結算' }, style: 'primary', height: 'sm', color: '#7a9aaa', flex: 1 }
        ]
      }
    }
  } as any;
}

export function createMyAccountFlex(
  userName: string,
  payments: { to_name: string; amount: number }[],
  paidItems: { seq: number; description: string; amount: number; currency?: string; original_amount?: number; others: { debtor_name: string; share_amount: number }[] }[],
  splitItems: { seq: number; description: string; payer_name: string; myShare: number }[]
): messagingApi.FlexMessage {
  const section = (title: string): any => ({
    type: 'text', text: title, weight: 'bold', size: 'sm', color: '#555555', margin: 'lg'
  });

  const separator: any = { type: 'separator', margin: 'md', color: '#eeeeee' };

  // 需要轉帳
  const paymentRows: any[] = payments.length === 0
    ? [{ type: 'text', text: '✅ 不需要轉帳給任何人', size: 'sm', color: '#7a9aaa', margin: 'sm' }]
    : payments.map(p => ({
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          { type: 'text', text: `付給 ${p.to_name}`, size: 'sm', color: '#333333', flex: 3 },
          { type: 'text', text: `TWD ${Math.round(p.amount * 100) / 100}`, size: 'sm', color: '#b07878', align: 'end', flex: 2, weight: 'bold' }
        ]
      }));

  // 代墊明細
  const paidRows: any[] = paidItems.length === 0
    ? [{ type: 'text', text: '（無）', size: 'sm', color: '#aaaaaa', margin: 'sm' }]
    : paidItems.map(item => {
        const amtText = item.currency && item.currency !== 'TWD' && item.original_amount
          ? `${item.currency} ${item.original_amount}`
          : `TWD ${item.amount}`;
        const othersText = item.others.map(o => o.debtor_name).join('、');
        return {
          type: 'box', layout: 'vertical', margin: 'sm',
          contents: [
            {
              type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: `#${item.seq} ${item.description}`, size: 'sm', flex: 4, weight: 'bold', wrap: true },
                { type: 'text', text: amtText, size: 'sm', flex: 2, align: 'end', color: '#555555' }
              ]
            },
            { type: 'text', text: `分攤：${othersText}（各 ${item.others[0]?.share_amount ?? '-'}）`, size: 'xs', color: '#888888', wrap: true }
          ]
        };
      });

  // 分攤明細
  const splitRows: any[] = splitItems.length === 0
    ? [{ type: 'text', text: '（無）', size: 'sm', color: '#aaaaaa', margin: 'sm' }]
    : splitItems.map(item => ({
        type: 'box', layout: 'vertical', margin: 'sm',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: `#${item.seq} ${item.description}`, size: 'sm', flex: 4, weight: 'bold', wrap: true },
              { type: 'text', text: `我付 ${item.myShare}`, size: 'sm', flex: 2, align: 'end', color: '#b07878', weight: 'bold' }
            ]
          },
          { type: 'text', text: `付款人：${item.payer_name}`, size: 'xs', color: '#888888', wrap: true }
        ]
      }));

  const bodyContents: any[] = [
    section('💸 需要轉帳'),
    ...paymentRows,
    separator,
    section('💰 我代墊的帳'),
    ...paidRows,
    separator,
    section('💸 我需要分攤的帳'),
    ...splitRows
  ];

  return {
    type: 'flex',
    altText: `${userName} 的帳目`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#8a7f9e',
        contents: [
          { type: 'text', text: `👤 ${userName} 的帳目`, weight: 'bold', size: 'lg', color: '#ffffff' }
        ]
      },
      body: { type: 'box', layout: 'vertical', contents: bodyContents },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', action: { type: 'postback', label: '完整清單', data: 'cmd=清單' }, style: 'secondary', height: 'sm', flex: 1 }
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
        backgroundColor: '#7c8a78'
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
          { type: 'button', action: { type: 'postback', label: '✅ 確認送出', data: `action=submit_draft${ownerSuffix}` }, style: 'primary', height: 'sm', color: '#7c8a78' },
          { type: 'button', action: { type: 'postback', label: '➕ 繼續修改', data: `action=back_to_carousel${ownerSuffix}` }, style: 'secondary', height: 'sm' },
          { type: 'button', action: { type: 'postback', label: '❌ 取消', data: 'cmd=取消' }, style: 'link', height: 'sm', color: '#c07878' }
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
        backgroundColor: '#8a8878'
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
      { type: 'button', action: { type: 'uri', label: '⚡ 快速記帳 (LIFF)', uri: 'https://liff.line.me/LIFF_ID_PLACEHOLDER' }, style: 'secondary', height: 'sm', color: '#7c8a78' },
      { type: 'button', action: { type: 'postback', label: '🔍 預覽草稿', data: `action=show_draft${os}` }, style: 'primary', height: 'sm', color: '#7a8898' },
      { type: 'button', action: { type: 'postback', label: '❌ 取消', data: 'cmd=取消' }, style: 'link', height: 'sm' }
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
          header: { type: 'box', layout: 'vertical', backgroundColor: '#7a8898', contents: [{ type: 'text', text: '1️⃣ 輸入金額', weight: 'bold', color: '#ffffff' }] },
          body: { type: 'box', layout: 'vertical', contents: [...calcGrid, commonFooter] }
        },
        {
          type: 'bubble', size: 'mega',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#7c8a78', contents: [{ type: 'text', text: '2️⃣ 選擇項目', weight: 'bold', color: '#ffffff' }] },
          body: { type: 'box', layout: 'vertical', contents: [...catButtons, commonFooter] }
        },
        {
          type: 'bubble', size: 'mega',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#8a8878', contents: [{ type: 'text', text: '3️⃣ 幣別與付款', weight: 'bold', color: '#ffffff' }] },
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
