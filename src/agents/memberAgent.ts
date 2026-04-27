import { messagingApi } from '@line/bot-sdk';
import { CRUD } from '../db/crud';
import { getStandardQuickReply } from '../utils/ui';

export class MemberAgent {
  private crud: CRUD;

  constructor(crud: CRUD) {
    this.crud = crud;
  }

  async ensureMember(groupId: string, userId: string, displayName: string) {
    await this.crud.upsertMember(groupId, userId, displayName);
  }

  async handleJoinGroup(groupId: string, userId: string, displayName: string): Promise<string | messagingApi.Message> {
    await this.ensureMember(groupId, userId, displayName);
    await this.crud.setParticipation(groupId, userId, true);

    const members = await this.crud.getParticipatingMembers(groupId);
    const names = members.map(m => `- ${m.display_name}`).join('\n');
    return {
      type: 'text',
      text: `${displayName} 已加入分帳。\n目前成員 (${members.length})\n${names || '- 無'}`,
      quickReply: getStandardQuickReply({ showDelete: false, showModify: false })
    };
  }

  async requestLeave(groupId: string, userId: string, displayName: string): Promise<string | messagingApi.Message> {
    return {
      type: 'text',
      text: `${displayName}，確認要退出分帳嗎？`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '確認退出', text: '確認退出' } },
          { type: 'action', action: { type: 'message', label: '取消', text: '取消' } }
        ]
      }
    };
  }

  async confirmLeave(groupId: string, userId: string, displayName: string): Promise<string | messagingApi.Message> {
    const member = await this.crud.getMember(groupId, userId);
    if (!member || member.is_participating !== 1) return `${displayName} 目前不在分帳名單中。`;

    const hasExpenses = await this.crud.userHasUnsettledExpenses(groupId, userId);
    if (hasExpenses) return `${displayName} 仍有未結算帳務，請先完成結算後再退出。`;

    await this.crud.setParticipation(groupId, userId, false);
    const members = await this.crud.getParticipatingMembers(groupId);
    const names = members.map(m => `- ${m.display_name}`).join('\n');

    return {
      type: 'text',
      text: `${displayName} 已退出分帳。\n目前成員 (${members.length})\n${names || '- 無'}`,
      quickReply: getStandardQuickReply({ showDelete: false, showModify: false })
    };
  }

  async getMemberList(groupId: string): Promise<string | messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    if (members.length === 0) {
      return {
        type: 'text',
        text: '目前沒有分帳成員，輸入「加入」即可參與。',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '加入', text: '加入' } },
            { type: 'action', action: { type: 'message', label: '說明', text: '說明' } }
          ]
        }
      };
    }

    const names = members.map(m => `- ${m.display_name}`).join('\n');
    return {
      type: 'text',
      text: `目前分帳成員 (${members.length})\n${names}`,
      quickReply: getStandardQuickReply({ showDelete: false, showModify: false })
    };
  }
}
