"""
分帳神器 — LINE Bot 主程式
FastAPI + LINE Messaging API v3 + Cloudflare Workers AI + SQLite

啟動方式：
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Header, HTTPException, Depends
from sqlalchemy.orm import Session
from database.models import init_db, get_db
from line_handler.handler import LineEventHandler
from agents.nlp_agent import NLPAgent
from config import LINE_CHANNEL_SECRET, PORT
import uvicorn

line_handler = LineEventHandler()
nlp_agent = NLPAgent()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 啟動時初始化資料庫
    init_db()
    print("✅ 資料庫初始化完成")

    # 檢查 Cloudflare Workers AI 是否設定正確
    cf_ok = await nlp_agent.check_cf_ai_health()
    if cf_ok:
        print("✅ Cloudflare Workers AI 已連線")
    else:
        print("⚠️  Cloudflare 認證無效或未連線，NLP 解析將使用 Regex fallback")

    yield
    print("🛑 服務停止")


app = FastAPI(
    title="分帳神器 LINE Bot",
    description="AI Agent 驅動的 LINE 群組分帳系統",
    version="1.0.0",
    lifespan=lifespan
)


@app.get("/")
async def root():
    return {"status": "ok", "service": "分帳神器 LINE Bot"}


@app.get("/health")
async def health(db: Session = Depends(get_db)):
    cf_ok = await nlp_agent.check_cf_ai_health()
    return {
        "status": "ok",
        "cf_ai": "online" if cf_ok else "offline (regex fallback)",
        "database": "ok"
    }


@app.post("/webhook")
async def webhook(
    request: Request,
    x_line_signature: str = Header(alias="X-Line-Signature"),
    db: Session = Depends(get_db)
):
    """LINE Webhook 接收端點"""
    body = await request.body()
    body_str = body.decode("utf-8")

    try:
        await line_handler.handle_events(
            body=body_str,
            signature=x_line_signature,
            db=db
        )
    except Exception as e:
        print(f"[Webhook] 處理錯誤: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
