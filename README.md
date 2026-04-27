# 分帳神器 LINE Bot (Cloudflare Workers 版)

> AI Agent 驅動的 LINE 群組分帳系統，已從原本的 Python/FastAPI 全面重構成 **TypeScript + Hono**，並部署於 **Cloudflare Workers** 邊緣運算平台。資料庫改用 **Cloudflare D1**，並持續串接 **Cloudflare Workers AI** (Llama-3 模型) 進行語意解析，達到真正的 Serverless 零成本維護與極速響應。

---

## 🏗️ 系統架構

```text
LINE 群組訊息
     │
     ▼
Cloudflare Workers (Hono Webhook)
     │
     ▼
┌─────────────────────────────┐
│        Main Agent           │  ← 主協調者 (Orchestrator)
│   意圖分類 + 工作分派       │
└──┬──────┬────────┬──────────┘
   │      │        │
   ▼      ▼        ▼
 NLP    Member  Expense  Settlement
Agent   Agent   Agent    Agent
   │               │
   ▼               ▼
 CF AI             CF D1
 (LLM)          (Database)
```

---

## ✨ 核心功能與指令

| 功能類別 | 功能說明 | 觸發指令範例 |
|----------|----------|--------------|
| **成員管理** | 參與或退出群組分帳 | `加入`、`退出`、`成員` |
| **記錄費用** | 記錄單筆或多筆費用 | `$500 晚餐`、`$200 午餐 $300 晚餐` |
| **指定分攤** | 記錄費用並指定由特定人分攤 | `$500 晚餐 @Alice @Bob` |
| **代付記帳** | 幫別人記帳（A付錢，所有人或B分攤）| `代付 @Alice $500 晚餐` 或 `代付 @Alice $500 晚餐 @Bob` |
| **修改費用** | 更新現有費用的金額 | `更新 #3 $600` |
| **修改分帳** | 互動式增減已記錄費用的分帳對象 | `修改 #3 分帳`、`+ #3 @David`、`- #3 @Bob` |
| **刪除費用** | 刪除單筆紀錄 | `刪除 #3` |
| **查看紀錄** | 檢視尚未結算的費用清單 | `清單` 或 `明細` |
| **結算還款** | 預覽結算金額並執行清帳 | `結算` → `確認結算` |
| **系統設定** | 暫停/恢復機器人在此群組的回應 | `關閉分帳`、`開啟分帳` |

> ⚠️ **注意事項**：
>
> 1. 除記帳與代付指令外，其餘指令需「完全符合」文字才會觸發。
> 2. 必須先輸入「加入」才能記錄或被標記 (@) 參與費用分攤。
> 3. @標記的名字必須完全符合使用者的 LINE 顯示名稱。

---

## 🚀 部署教學 (Cloudflare Workers)

### 1. 安裝相依套件

確保已安裝 Node.js，然後執行：

```bash
npm install
```

### 2. 申請 LINE Messaging API

前往 [LINE Developers](https://developers.line.biz/) 建立 Messaging API，取得：

- `Channel Access Token`
- `Channel Secret`

### 3. 設定 Cloudflare D1 資料庫

使用 Wrangler 建立 D1 資料庫：

```bash
npx wrangler d1 create splitbill
```

將終端機輸出的 `database_name` 與 `database_id` 填入 `wrangler.toml` 中對應的位置。

接著，將資料庫結構套用到 D1：

```bash
# 本地端測試資料庫
npx wrangler d1 execute splitbill --local --file=./schema.sql

# 遠端正式資料庫
npx wrangler d1 execute splitbill --remote --file=./schema.sql
```

### 4. 設定安全憑證 (Secrets)

將 LINE 的憑證安全地存入 Cloudflare Workers：

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
```

### 5. 部署至 Cloudflare Workers

```bash
npx wrangler deploy
```

部署完成後，Wrangler 會回傳一個網址 (例如 `https://splitbill-worker.xxxx.workers.dev`)。
將此網址加上 `/webhook` 路徑後，填入 LINE Developers Console 的 **Webhook URL** 中，並開啟 Use webhook。

---

## 💻 本地開發與測試

你可以使用 Wrangler 在本地模擬 Workers 環境與 D1 資料庫：

```bash
# 複製環境變數範例
cp .env.example .env

# 在 .env 中填寫本地測試用的 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_CHANNEL_SECRET
```

啟動本地伺服器：

```bash
npm run dev
```

若要將本地的 Webhook 暴露給 LINE 伺服器，可使用內建的 Cloudflared：

```bash
./cloudflared.exe tunnel --url http://localhost:8787
```

---

## 🤖 Agent 分工說明

| Agent | 角色 | 職責 |
|-------|------|------|
| **MainAgent** | 主協調者 | 接收 LINE 事件、嚴格比對意圖、分派工作給子 Agent、控制群組系統開關。 |
| **NLPAgent** | 語意解析 | 負責解析記帳訊息。優先使用 Regex 提取金額與對象，若格式複雜則呼叫 Cloudflare Workers AI (Llama-3) 進行解析。 |
| **MemberAgent** | 成員管理 | 處理使用者的加入、退出邏輯，維護 D1 `members` 表的參與狀態。 |
| **ExpenseAgent** | 費用管理 | 處理一般記帳、代付記帳、增刪改費用、以及後續動態增減分攤對象的邏輯。 |
| **SettlementAgent** | 結算專員 | 讀取所有未結算費用，使用「貪心最簡化交易演算法」計算最小還款路徑，並在確認後清空紀錄。 |

---

## 🧮 分帳演算法 (Greedy Debt Simplification)

使用**貪心最簡化交易演算法**來減少群組間的轉帳筆數：

1. 計算每個人的淨額（代墊總額 − 應分擔總額）。
2. 將淨額大於 0 的人歸類為「應收款者」，小於 0 的人歸類為「應付款者」。
3. 依據金額大小排序後，使用雙指針互相抵銷，計算出最直接、筆數最少的轉帳建議。

---

## 📂 專案結構

```text
分帳神器/
├── src/
│   ├── index.ts                 # Hono 主程式與 API 路由設定
│   ├── lineHandler.ts           # LINE 事件處理 (轉發給 MainAgent)
│   ├── env.ts                   # Cloudflare Bindings 型別定義
│   ├── db/
│   │   └── crud.ts              # D1 資料庫操作與 SQL 語句
│   └── agents/
│       ├── mainAgent.ts         # 指令路由與中樞控制
│       ├── nlpAgent.ts          # AI/Regex 語意解析
│       ├── memberAgent.ts       # 群組成員管理
│       ├── expenseAgent.ts      # 費用操作與分攤對象管理
│       └── settlementAgent.ts   # 結算演算法
├── schema.sql                   # D1 資料庫 Schema
├── wrangler.toml                # Cloudflare Workers 設定檔
├── package.json                 # Node.js 專案設定檔
└── tsconfig.json                # TypeScript 設定檔
```
