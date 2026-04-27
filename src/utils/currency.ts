import { Env } from '../env';

const CURRENCY_ALIASES: Record<string, string> = {
  // ISO codes
  twd: 'TWD', jpy: 'JPY', usd: 'USD', krw: 'KRW', eur: 'EUR', gbp: 'GBP',
  aud: 'AUD', cad: 'CAD', sgd: 'SGD', chf: 'CHF', hkd: 'HKD', cny: 'CNY',
  thb: 'THB', vnd: 'VND', idr: 'IDR', myr: 'MYR', php: 'PHP', nzd: 'NZD',
  sek: 'SEK', zar: 'ZAR',

  // Traditional Chinese aliases
  台幣: 'TWD', 台币: 'TWD', 新台幣: 'TWD', 新台币: 'TWD', 台灣: 'TWD', 台湾: 'TWD',
  日幣: 'JPY', 日币: 'JPY', 日本: 'JPY', 美金: 'USD', 美元: 'USD', 美國: 'USD', 美国: 'USD',
  韓元: 'KRW', 韩元: 'KRW', 韓國: 'KRW', 韩国: 'KRW', 歐元: 'EUR', 欧元: 'EUR',
  英鎊: 'GBP', 英镑: 'GBP', 英國: 'GBP', 英国: 'GBP', 港幣: 'HKD', 港币: 'HKD', 香港: 'HKD',
  人民幣: 'CNY', 人民币: 'CNY', 中國: 'CNY', 中国: 'CNY', 泰銖: 'THB', 泰國: 'THB', 泰国: 'THB',
  越南盾: 'VND', 越南: 'VND', 印尼盾: 'IDR', 印尼: 'IDR', 馬幣: 'MYR', 马币: 'MYR', 馬來西亞: 'MYR', 马来西亚: 'MYR',
  新幣: 'SGD', 新币: 'SGD', 新加坡: 'SGD', 菲律賓披索: 'PHP', 菲律賓比索: 'PHP', 菲律賓: 'PHP', 菲律宾: 'PHP',
  纽币: 'NZD', 紐幣: 'NZD', 紐西蘭: 'NZD', 新西兰: 'NZD', 澳幣: 'AUD', 澳洲: 'AUD', 加幣: 'CAD', 加拿大: 'CAD',
  瑞郎: 'CHF', 瑞士: 'CHF',
};

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

export function resolveCurrency(input: string): string | null {
  const cleaned = input.trim();
  if (!cleaned) return null;

  const iso = cleaned.toUpperCase();
  if (/^[A-Z]{3}$/.test(iso)) {
    return iso;
  }

  return CURRENCY_ALIASES[normalizeKey(cleaned)] || null;
}

export function isExpenseFormat(text: string): boolean {
  const t = text.trim();

  // Tightened trigger to avoid false positives from random list text.
  // Users can still use wizard quick replies or explicit prefixes.
  if (/^記帳\s+/i.test(t)) return true;
  if (/^代墊\s+/i.test(t)) return true;
  if (/^幫記\s+/i.test(t)) return true;

  return false;
}

export async function fetchExchangeRates(env: Env): Promise<void> {
  console.log('Fetching all exchange rates from Bank of Taiwan...');
  try {
    const res = await fetch('https://rate.bot.com.tw/xrt/flcsv/0/day');
    if (!res.ok) {
      console.error('Failed to fetch rates, status:', res.status);
      return;
    }

    const csv = await res.text();
    const lines = csv.split('\n');
    const rates: Record<string, number> = {};

    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 14) continue;

      const currency = parts[0].trim();
      if (currency === '幣別' || !currency) continue;

      // Extract numeric ISO code if present (e.g. "USD (美元)")
      const match = currency.match(/([A-Z]{3})/);
      const isoCode = match ? match[1] : currency;

      const cashRateStr = parts[12]?.trim();
      const spotRateStr = parts[13]?.trim();

      let rate = parseFloat(cashRateStr);
      if (isNaN(rate) || rate === 0) {
        rate = parseFloat(spotRateStr);
      }

      if (!isNaN(rate) && rate > 0) {
        rates[isoCode] = rate;
      }
    }

    const statements = Object.entries(rates).map(([currency, rate]) =>
      env.DB.prepare(
        `INSERT INTO exchange_rates (currency_code, rate) VALUES (?, ?)
         ON CONFLICT(currency_code) DO UPDATE SET rate = excluded.rate, updated_at = CURRENT_TIMESTAMP`
      ).bind(currency, rate)
    );

    if (statements.length > 0) {
      await env.DB.batch(statements);
      console.log(`Saved ${statements.length} exchange rates to DB: ${Object.keys(rates).join(', ')}`);
    }
  } catch (e) {
    console.error('Error fetching exchange rates:', e);
  }
}
