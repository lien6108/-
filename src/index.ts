import { Hono } from 'hono';
import { validateSignature } from '@line/bot-sdk';
import { Env } from './env';
import { LineEventHandler } from './lineHandler';

const app = new Hono<{ Bindings: Env }>();

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
        :root { --primary: #46494c; --bg: #f4f7f6; --text: #333; }
        body { font-family: -apple-system, "Microsoft JhengHei", sans-serif; background: var(--bg); margin: 0; padding: 15px; color: var(--text); }
        .card { background: white; border-radius: 20px; padding: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); margin-bottom: 15px; }
        .label { font-size: 13px; color: #888; margin-bottom: 8px; font-weight: bold; }
        .display { font-size: 42px; font-weight: bold; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 20px; min-height: 50px; text-align: right; color: var(--primary); }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .btn { background: #fff; border: 1px solid #eee; padding: 15px; border-radius: 12px; text-align: center; font-size: 20px; font-weight: 600; cursor: pointer; transition: all 0.1s; -webkit-tap-highlight-color: transparent; }
        .btn:active { background: #f0f0f0; transform: scale(0.95); }
        .btn.primary { background: var(--primary); color: white; grid-column: span 2; border: none; }
        .btn.danger { color: #ff4d4f; }
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
  const signature = c.req.header('x-line-signature');
  if (!signature) {
    return c.text('Missing Signature', 400);
  }

  const body = await c.req.text();
  
  // Validate signature
  const isValid = validateSignature(body, c.env.LINE_CHANNEL_SECRET, signature);
  if (!isValid) {
    return c.text('Invalid Signature', 403);
  }

  let events;
  try {
    const data = JSON.parse(body);
    events = data.events;
  } catch (e) {
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
    ctx.waitUntil(fetchExchangeRates(env));
  }
};
