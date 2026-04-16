# 分帳神器 LINE Bot

> AI Agent 驅動的 LINE 群組分帳系統，串接 **Cloudflare Workers AI** (Llama-3 模型)，不須吃重本機算力，且能以最少的成本進行輕量化部署。

---

## 架構圖

```text
LINE 群組訊息
     │
     ▼
FastAPI Webhook
     │
     ▼
┌─────────────────────────────┐
│        Main Agent           │  ← 主協調者 (Orchestrator)
│   意圖分類 + 工作分派       │
└──┬──────┬────────┬──────────┘
   │      │        │
   ▼      ▼        ▼
NLP     Member  Expense  Settlement
Agent   Agent   Agent    Agent
   │
   ▼
Cloudflare Workers AI
(REST API)
```

---

## 功能

| 功能 | 觸發方式 |
|------|---------|
| 加入分帳 | 輸入「加入」 |
| 退出分帳 | 輸入「退出」 |
| 記錄費用 | `$500 晚餐` |
| 更新費用 | `更新 #3 $600` |
| 查看清單 | 輸入「清單」 |
| 查看成員 | 輸入「成員」 |
| 預覽結算 | 輸入「結算」 |
| 確認結算 | 輸入「確認結算」 |

---

## 快速開始

### 1. 安裝 Python 套件

確保使用 Python 3.10+ 版本，然後執行：

```bash
pip install -r requirements.txt
```

### 2. 申請 LINE 與 Cloudflare API

1. **LINE**: 前往 [LINE Developers](https://developers.line.biz/) 建立 Messaging API，複製 `Channel Secret` 與 `Channel Access Token`。
2. **Cloudflare**: 登入 Cloudflare Dashboard，在 Workers & Pages 設定中取得 `Account ID`，並建立一組具備 **Workers AI** 讀寫權限的 `API Token`。

### 3. 設定環境變數 .env

```bash
cp .env.example .env
```
編輯 `.env` 並填入你的憑證：
```env
LINE_CHANNEL_ACCESS_TOKEN=your_token_here
LINE_CHANNEL_SECRET=your_secret_here
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_TOKEN=your_cloudflare_api_token
CF_MODEL=@cf/meta/llama-3-8b-instruct
```

### 4. 啟動伺服器

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 5. 設定 Webhook（開發用 Cloudflared Tunnel）

專案內已附帶 `cloudflared.exe`，不需依賴 ngrok 即可將本地 Server 暴露到外網：

```bash
./cloudflared.exe tunnel --url http://localhost:8000
```

將產生的 HTTPS URL 加上 `/webhook` 填入 LINE Developers Console 的 Webhook URL：
```text
https://xxxxxx.trycloudflare.com/webhook
```

---

## 環境變數表

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot Token | — |
| `LINE_CHANNEL_SECRET` | LINE Channel Secret | — |
| `CF_ACCOUNT_ID` | Cloudflare Account ID | — |
| `CF_API_TOKEN` | Cloudflare API Token | — |
| `CF_MODEL` | 使用的模型名稱 | `@cf/meta/llama-3-8b-instruct` |
| `DATABASE_URL` | SQLite 資料庫路徑 | `sqlite:///./splitbill.db` |
| `PORT` | 服務埠號 | `8000` |

---

## Agent 分工說明

| Agent | 角色 | 職責 |
|-------|------|------|
| **MainAgent** | 主協調者 | 接收事件、意圖分類、分派工作 |
| **NLPAgent** | 語意解析專員 | 透過 Cloudflare AI + Regex 雙軌解析意圖和費用 |
| **MemberAgent** | 成員管理專員 | 加入/退出/查詢成員 |
| **ExpenseAgent** | 費用記錄專員 | 記錄/更新/查詢費用 |
| **SettlementAgent** | 結算專員 | 計算最簡化還款路徑 |

---

## 分帳演算法 (Greedy Debt Simplification)

使用**貪心最簡化交易演算法**：
1. 計算每人淨額（代墊總額 − 應分擔總額）
2. 正數 = 應收款，負數 = 應付款
3. 排序後用雙指針匹配，最小化轉帳筆數。

---

## 專案結構

```text
分帳神器/
├── main.py                  # FastAPI 主程式 + Webhook
├── config.py                # 環境設定
├── requirements.txt         # 相依套件
├── .env.example             # 環境變數範例
├── cloudflared.exe          # Cloudflare 內網穿透工具
├── database/
│   ├── models.py            # SQLAlchemy ORM 模型
│   └── crud.py              # 資料庫操作
├── agents/
│   ├── main_agent.py        # 主協調者
│   ├── nlp_agent.py         # Cloudflare AI 語意解析
│   ├── member_agent.py      # 成員管理
│   ├── expense_agent.py     # 費用記錄
│   └── settlement_agent.py  # 結算演算法
└── line_handler/
    └── handler.py           # LINE 事件處理與回覆
```
