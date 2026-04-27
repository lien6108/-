import { Env } from '../env';
import { resolveCurrency } from '../utils/currency';

export interface ParsedExpense {
  description: string;
  amount: number;
  participants?: string[];
  currency?: string;
  originalAmount?: number;
}

function stripPrefix(text: string): string {
  return text.replace(/^(記帳|幫記)\s+/i, '').trim();
}

function looksLikeBullet(text: string): boolean {
  return /^\s*([\-*•]|\d+\.)\s+/.test(text);
}

export class NLPAgent {
  private ai: any;
  private env: Env;

  constructor(env: Env) {
    this.ai = env.AI;
    this.env = env;
  }

  async parseExpenseMessage(text: string): Promise<ParsedExpense | null> {
    const cleanInput = stripPrefix(text);
    if (!cleanInput || looksLikeBullet(cleanInput)) return null;

    const participants = [...cleanInput.matchAll(/@(\S+)/g)].map(m => m[1]);

    // [currency] [amount] [desc]
    const amountPattern = /^(?:([A-Za-z\u4e00-\u9fa5]{2,20})\s+)?\$?\s*([\d,]+(?:\.\d+)?)(?![a-zA-Z\d])\s*(.*)$/;
    const match = cleanInput.match(amountPattern);
    if (match) {
      const prefix = (match[1] || '').trim();
      const amount = parseFloat(match[2].replace(/,/g, ''));
      if (isNaN(amount) || amount <= 0) return null;

      const descRaw = (match[3] || '').replace(/@\S+/g, '').trim();
      const description = descRaw || '記帳';

      let currency = 'TWD';
      let converted = amount;
      let originalAmount: number | undefined;

      if (prefix) {
        const resolved = resolveCurrency(prefix);
        if (!resolved) return null;
        currency = resolved;
      }

      if (currency !== 'TWD') {
        originalAmount = amount;
        const res = await this.env.DB.prepare(`SELECT rate FROM exchange_rates WHERE currency_code = ?`).bind(currency).first<{ rate: number }>();
        if (res?.rate) {
          converted = Math.round(originalAmount * res.rate * 100) / 100;
        }
      }

      return {
        description,
        amount: converted,
        participants: participants.length > 0 ? participants : undefined,
        currency,
        originalAmount
      };
    }

    return this.llmParse(cleanInput);
  }

  async parseMultipleExpenseMessages(text: string): Promise<ParsedExpense[]> {
    const raw = stripPrefix(text);
    const lines = raw.split('\n').map(v => v.trim()).filter(Boolean);
    const results: ParsedExpense[] = [];

    for (const line of lines) {
      if (looksLikeBullet(line)) continue;

      // Support one-line multi records like "$100 午餐 $200 飲料"
      const segments = line.includes('$')
        ? line.split(/(?=\$)/).map(v => v.trim()).filter(Boolean)
        : [line];

      for (const seg of segments) {
        const parsed = await this.parseExpenseMessage(`記帳 ${seg}`);
        if (parsed) results.push(parsed);
      }
    }

    return results;
  }

  private async llmParse(text: string): Promise<ParsedExpense | null> {
    const systemPrompt = 'Extract a single expense from user text. Return JSON with keys: description, amount. If not sure, return {"error":"invalid"}.';

    try {
      const response = await this.ai.run('@cf/meta/llama-3-8b-instruct', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      });
      const raw = String(response?.response || '').trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.error) return null;

      const amount = Number(parsed?.amount);
      if (!amount || amount <= 0) return null;

      return { description: String(parsed?.description || '記帳').trim(), amount };
    } catch (e: any) {
      console.error('[NLPAgent] CF LLM parse failed:', e);
      throw new Error('AI_QUOTA_EXCEEDED');
    }
  }
}
