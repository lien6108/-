import { messagingApi } from '@line/bot-sdk';

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
    altText: '未結算記帳清單',
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
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#2f6fed',
                height: 'sm',
                action: { type: 'postback', label: '新增', data: 'action=start_add', displayText: '新增' }
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: { type: 'postback', label: '修改', data: 'action=start_edit', displayText: '修改' }
              }
            ]
          },
          { type: 'text', text: '可用快捷進行後續操作', size: 'xs', color: '#aaaaaa', align: 'center' }
        ]
      }
    }
  } as any;
}
