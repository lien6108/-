import { Hono } from 'hono';
import { validateSignature } from '@line/bot-sdk';
import { Env } from './env';
import { LineEventHandler } from './lineHandler';
import { CRUD } from './db/crud';
import { AdminAgent } from './agents/adminAgent';

const app = new Hono<{ Bindings: Env }>();

const viewStyle = `
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:-apple-system,"Microsoft JhengHei",sans-serif;background:#f2f0ed;margin:0;padding:0;color:#333}
    .header{background:#6b7f8c;color:#fff;padding:18px 16px;font-size:18px;font-weight:bold;display:flex;align-items:center;gap:8px}
    .card{background:#fff;border-radius:12px;margin:12px;padding:14px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    .trip-badge{display:inline-block;background:#e4e9ed;color:#5a6e7a;border-radius:8px;padding:2px 10px;font-size:12px;margin-bottom:8px}
    .row{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f5f5f5}
    .row:last-child{border-bottom:none}
    .seq{color:#bbb;font-size:12px;min-width:28px}
    .desc{flex:1;font-weight:600;font-size:14px;padding:0 8px}
    .amount{color:#333;font-size:13px;text-align:right;white-space:nowrap}
    .payer{color:#888;font-size:11px;text-align:right}
    .total-row{display:flex;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:2px solid #eee;font-weight:bold}
    .empty{color:#bbb;font-size:14px;padding:12px 0;text-align:center}
    .trip-item{padding:10px 0;border-bottom:1px solid #f5f5f5;display:flex;justify-content:space-between;align-items:center}
    .trip-item:last-child{border-bottom:none}
    .trip-name{font-size:15px;font-weight:600}
    .trip-meta{font-size:12px;color:#aaa;margin-top:2px}
    .status-active{color:#8fa8b8;font-size:12px}
    .status-closed{color:#bbb;font-size:12px}
    .loading{text-align:center;padding:40px;color:#aaa;font-size:14px}
    #content{display:none}
  </style>`;

// JSON API: current unsettled expenses for a user
app.get('/api/current', async (c) => {
  const uid = c.req.query('uid');
  if (!uid) return c.json({ error: 'missing uid' }, 400);
  const crud = new CRUD(c.env);
  const groupIds = await crud.getGroupsByUserId(uid);
  const result = [];
  for (const gid of groupIds) {
    const trip = await crud.getCurrentTrip(gid);
    const expenses = await crud.getUnsettledExpenses(gid);
    result.push({ tripName: trip?.trip_name || '（未命名旅程）', expenses });
  }
  return c.json(result);
});

// JSON API: trip history for a user
app.get('/api/history', async (c) => {
  const uid = c.req.query('uid');
  if (!uid) return c.json({ error: 'missing uid' }, 400);
  const crud = new CRUD(c.env);
  const groupIds = await crud.getGroupsByUserId(uid);
  const result = [];
  for (const gid of groupIds) {
    const trips = await crud.getTripHistory(gid);
    result.push(...trips);
  }
  return c.json(result);
});

app.get('/view/current', (c) => {
  const liffId = c.env.LIFF_ID_CURRENT || '';
  const html = `<!DOCTYPE html>
<html><head><title>目前分帳清單</title>${viewStyle}
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head><body>
<div class="header">📋 目前分帳清單</div>
<div id="loading" class="loading">載入中…</div>
<div id="content"></div>
<script>
(async () => {
  try {
    await liff.init({ liffId: '${liffId}' });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    const profile = await liff.getProfile();
    const uid = profile.userId;
    const res = await fetch('/api/current?uid=' + uid);
    const data = await res.json();
    document.getElementById('loading').style.display = 'none';
    const el = document.getElementById('content');
    el.style.display = 'block';
    if (!data.length) { el.innerHTML = '<div class="card"><div class="empty">你目前未加入任何分帳群組。</div></div>'; return; }
    el.innerHTML = data.map(g => {
      const rows = g.expenses.length === 0 ? '<div class="empty">目前無記帳資料</div>' :
        g.expenses.map(exp => {
          const amt = exp.currency && exp.currency !== 'TWD' && exp.original_amount
            ? exp.currency + ' ' + exp.original_amount : 'TWD ' + exp.amount;
          return '<div class="row"><span class="seq">#' + exp.group_seq + '</span><span class="desc">' + exp.description + '</span><div><div class="amount">' + amt + '</div><div class="payer">' + exp.payer_name + '</div></div></div>';
        }).join('');
      const total = g.expenses.reduce((s, e) => s + e.amount, 0);
      const totalRow = g.expenses.length > 0 ? '<div class="total-row"><span>總計 (TWD)</span><span>' + Math.round(total * 100) / 100 + '</span></div>' : '';
      return '<div class="card"><div class="trip-badge">✈️ ' + g.tripName + '</div>' + rows + totalRow + '</div>';
    }).join('');
  } catch(e) {
    document.getElementById('loading').textContent = '載入失敗：' + e.message;
  }
})();
</script>
</body></html>`;
  return c.html(html);
});

app.get('/view/history', (c) => {
  const liffId = c.env.LIFF_ID_HISTORY || '';
  const html = `<!DOCTYPE html>
<html><head><title>歷史分帳</title>${viewStyle}
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head><body>
<div class="header">🗂 歷史分帳</div>
<div id="loading" class="loading">載入中…</div>
<div id="content"></div>
<script>
(async () => {
  try {
    await liff.init({ liffId: '${liffId}' });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    const profile = await liff.getProfile();
    const uid = profile.userId;
    const res = await fetch('/api/history?uid=' + uid);
    const trips = await res.json();
    document.getElementById('loading').style.display = 'none';
    const el = document.getElementById('content');
    el.style.display = 'block';
    if (!trips.length) { el.innerHTML = '<div class="card"><div class="empty">目前無歷史分帳紀錄。</div></div>'; return; }
    el.innerHTML = '<div class="card">' + trips.map(t => {
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString('zh-TW') : '';
      const tag = t.status === 'active' ? '<span class="status-active">● 進行中</span>' : '<span class="status-closed">● 已結算</span>';
      return '<div class="trip-item"><div><div class="trip-name">✈️ ' + t.trip_name + '</div><div class="trip-meta">' + date + '</div></div>' + tag + '</div>';
    }).join('') + '</div>';
  } catch(e) {
    document.getElementById('loading').textContent = '載入失敗：' + e.message;
  }
})();
</script>
</body></html>`;
  return c.html(html);
});

app.get('/', (c) => {
  return c.json({ status: 'ok', service: '分帳神器 LINE Bot (Cloudflare Workers)' });
});

app.get('/liff', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>快速記帳 - 分帳神器</title>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <style>
        :root { --primary: #6b7f8c; --bg: #f2f0ed; --text: #333; }
        body { font-family: -apple-system, "Microsoft JhengHei", sans-serif; background: var(--bg); margin: 0; padding: 15px; color: var(--text); }
        .card { background: white; border-radius: 20px; padding: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); margin-bottom: 15px; }
        .label { font-size: 13px; color: #888; margin-bottom: 8px; font-weight: bold; }
        .display { font-size: 42px; font-weight: bold; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 20px; min-height: 50px; text-align: right; color: var(--primary); }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .btn { background: #fff; border: 1px solid #eee; padding: 15px; border-radius: 12px; text-align: center; font-size: 20px; font-weight: 600; cursor: pointer; transition: all 0.1s; -webkit-tap-highlight-color: transparent; }
        .btn:active { background: #f0f0f0; transform: scale(0.95); }
        .btn.primary { background: var(--primary); color: white; grid-column: span 2; border: none; }
        .btn.danger { color: #c07878; }
        .categories { display: flex; overflow-x: auto; gap: 8px; padding-bottom: 10px; margin-bottom: 5px; scrollbar-width: none; }
        .categories::-webkit-scrollbar { display: none; }
        .cat-btn { padding: 8px 16px; border-radius: 30px; background: white; border: 1px solid #eee; white-space: nowrap; font-size: 14px; font-weight: 500; color: #666; }
        .cat-btn.active { background: var(--primary); color: white; border-color: var(--primary); box-shadow: 0 4px 10px rgba(70,73,76,0.2); }
        .submit-btn { background: var(--primary); color: white; width: 100%; padding: 18px; border-radius: 15px; border: none; font-size: 18px; font-weight: bold; margin-top: 20px; box-shadow: 0 4px 15px rgba(70,73,76,0.3); }
    </style>
</head>
<body>
    <div class="card">
        <div class="label">1. 選擇項目</div>
        <div class="categories" id="catList">
            <div class="cat-btn active" onclick="setCat('餐費')">🍴 餐費</div>
            <div class="cat-btn" onclick="setCat('交通')">🚗 交通</div>
            <div class="cat-btn" onclick="setCat('購物')">🛍️ 購物</div>
            <div class="cat-btn" onclick="setCat('飲料')">🍹 飲料</div>
            <div class="cat-btn" onclick="setCat('住宿')">🏠 住宿</div>
            <div class="cat-btn" onclick="setCat('門票')">🎟️ 門票</div>
            <div class="cat-btn" onclick="setCat('雜支')">🎁 雜支</div>
        </div>
        <div class="label">2. 輸入金額</div>
        <div id="numDisplay" class="display">0</div>
        <div class="grid">
            <div class="btn" onclick="press('1')">1</div><div class="btn" onclick="press('2')">2</div><div class="btn" onclick="press('3')">3</div><div class="btn danger" onclick="del()">⌫</div>
            <div class="btn" onclick="press('4')">4</div><div class="btn" onclick="press('5')">5</div><div class="btn" onclick="press('6')">6</div><div class="btn danger" onclick="clearNum()">C</div>
            <div class="btn" onclick="press('7')">7</div><div class="btn" onclick="press('8')">8</div><div class="btn" onclick="press('9')">9</div><div class="btn" onclick="press('.')">.</div>
            <div class="btn" onclick="press('0')" style="grid-column: span 2">0</div>
            <div id="submitBtn" class="btn primary" onclick="submit()">確認送出</div>
        </div>
    </div>

    <script>
        let amount = "";
        let category = "餐費";

        function setCat(c) {
            category = c;
            document.querySelectorAll('.cat-btn').forEach(b => {
                b.classList.remove('active');
                if(b.innerText.includes(c)) b.classList.add('active');
            });
        }

        function press(n) {
            if(amount === "0" && n !== ".") amount = "";
            if(n === "." && amount.includes(".")) return;
            amount += n;
            document.getElementById('numDisplay').innerText = amount;
        }

        function del() {
            amount = amount.slice(0, -1);
            document.getElementById('numDisplay').innerText = amount || "0";
        }

        function clearNum() {
            amount = "";
            document.getElementById('numDisplay').innerText = "0";
        }

        async function submit() {
            if(!amount || parseFloat(amount) <= 0) {
                alert('請輸入有效金額');
                return;
            }
            const btn = document.getElementById('submitBtn');
            btn.style.opacity = "0.5";
            btn.innerText = "傳送中...";
            
            const msg = \`[快速記帳] \${category} \${amount}\`;
            
            try {
                await liff.sendMessages([{ type: 'text', text: msg }]);
                liff.closeWindow();
            } catch (err) {
                alert('傳送失敗: ' + err.message);
                btn.style.opacity = "1";
                btn.innerText = "確認送出";
            }
        }

        liff.init({ liffId: "LIFF_ID_PLACEHOLDER" }).then(() => {
            if (!liff.isLoggedIn()) {
                liff.login();
            }
        });
    </script>
</body>
</html>
  `);
});

app.post('/webhook', async (c) => {
  console.log('[Webhook] 收到請求');
  const signature = c.req.header('x-line-signature');
  if (!signature) {
    console.log('[Webhook] 缺少簽章');
    return c.text('Missing Signature', 400);
  }

  const body = await c.req.text();
  console.log('[Webhook] body 長度:', body.length);
  
  // Validate signature
  const isValid = validateSignature(body, c.env.LINE_CHANNEL_SECRET, signature);
  if (!isValid) {
    console.log('[Webhook] 簽章驗證失敗');
    return c.text('Invalid Signature', 403);
  }
  console.log('[Webhook] 簽章驗證成功');

  let events;
  try {
    const data = JSON.parse(body);
    events = data.events;
    console.log('[Webhook] 解析到', events?.length || 0, '個事件');
  } catch (e) {
    console.log('[Webhook] JSON 解析失敗');
    return c.text('Invalid JSON', 400);
  }

  if (!events || events.length === 0) {
    return c.json({ status: 'ok' });
  }

  const handler = new LineEventHandler(c.env);
  
  // Cloudflare Workers execution timeout is short, so we use ctx.waitUntil to handle events asynchronously if possible
  // However, Hono's execution context allows awaiting. For simplicity and robustness on edge, we await the handler.
  try {
    await handler.handleEvents(events);
  } catch (e) {
    console.error("Webhook processing error:", e);
    // Still return 200 OK to LINE so they don't retry endlessly
  }

  return c.json({ status: 'ok' });
});

import { fetchExchangeRates } from './utils/currency';

export default {
  fetch: app.fetch,
  scheduled: async (event: any, env: Env, ctx: any) => {
    const crud = new CRUD(env);
    const adminAgent = new AdminAgent(env, crud);
    ctx.waitUntil(Promise.all([
      fetchExchangeRates(env),
      adminAgent.checkDbCapacity(0.8),
    ]));
  }
};
