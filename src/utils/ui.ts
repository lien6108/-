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
    items.push(qr(`修改分攤 #${options.groupSeq}`, `修改分攤 #${options.groupSeq}`));
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
