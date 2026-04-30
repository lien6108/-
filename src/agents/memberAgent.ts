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
      text: `🐾 ${displayName} 已加入分帳！\n目前成員 (${members.length})\n${names || '- 無'}`,
      quickReply: getStandardQuickReply({ showDelete: false, showModify: false })
    };
  }

  async requestLeave(groupId: string, userId: string, displayName: string): Promise<string | messagingApi.Message> {
    return {
      type: 'text',
      text: `${displayName}，確定要退出分帳嗎？`,
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
    if (!member || member.is_participating !== 1) return `${displayName} 目前不在分帳名單中喔！`;

    const hasExpenses = await this.crud.userHasUnsettledExpenses(groupId, userId);
    if (hasExpenses) return `${displayName} 還有未結算帳務，請先完成結算後再退出喔！`;

    await this.crud.setParticipation(groupId, userId, false);
    const members = await this.crud.getParticipatingMembers(groupId);
    const names = members.map(m => `- ${m.display_name}`).join('\n');

    return {
      type: 'text',
      text: `${displayName} 已退出分帳，掰掰！🐾\n目前成員 (${members.length})\n${names || '- 無'}`,
      quickReply: getStandardQuickReply({ showDelete: false, showModify: false })
    };
  }

  async getMemberList(groupId: string): Promise<string | messagingApi.Message> {
    const members = await this.crud.getParticipatingMembers(groupId);
    if (members.length === 0) {
      return {
        type: 'text',
        text: '目前還沒有夥伴加入耶～輸入「加入」一起分帳吧！',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '加入', text: '加入' } },
            { type: 'action', action: { type: 'message', label: '說明', text: '說明' } }
          ]
        }
      };
    }

    const memberRows = members.map((m, i) => ({
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: `${i + 1}`, size: 'sm', color: '#aaaaaa', flex: 1, align: 'center' },
        { type: 'text', text: m.display_name, size: 'sm', color: '#333333', flex: 5, weight: 'bold' }
      ],
      margin: 'md'
    }));

    return {
      type: 'flex',
      altText: `🐶 分帳成員 (${members.length})`,
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'horizontal',
          backgroundColor: '#46494c',
          contents: [
            { type: 'text', text: '� 分帳小夥伴', weight: 'bold', color: '#ffffff', size: 'md', flex: 1 },
            { type: 'text', text: `${members.length} 人`, color: '#cccccc', size: 'sm', align: 'end', flex: 0 }
          ]
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: memberRows
        },
        footer: {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'button', action: { type: 'message', label: '加入', text: '加入' }, style: 'primary', height: 'sm', color: '#2ecc71', flex: 1 },
            { type: 'button', action: { type: 'message', label: '退出', text: '退出' }, style: 'secondary', height: 'sm', flex: 1 }
          ]
        }
      }
    } as any;
  }
}
