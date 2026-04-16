"""
NLP Agent — 呼叫本地 Ollama 模型進行語意解析
用途：從自然語言中擷取費用描述與金額
"""

import re
import httpx
import json
from config import OLLAMA_BASE_URL, OLLAMA_MODEL


class NLPAgent:
    """
    角色：語意解析專員
    負責透過地端 LLM (Ollama) 解析使用者訊息，擷取費用相關資訊。
    """

    def __init__(self):
        self.base_url = OLLAMA_BASE_URL
        self.model = OLLAMA_MODEL

    async def parse_expense_message(self, text: str) -> dict | None:
        """
        解析含有 $ 的訊息，回傳 {"description": ..., "amount": ...} 或 None。
        優先使用 regex 快速解析；若格式複雜則呼叫 Ollama LLM。
        """
        # ── 快速 Regex 解析 ──────────────────────────────────────
        # 支援格式：$200 晚餐、晚餐 $200、$200、$1,200.50
        pattern = r'\$\s*([\d,]+(?:\.\d+)?)'
        match = re.search(pattern, text)
        if match:
            amount_str = match.group(1).replace(',', '')
            try:
                amount = float(amount_str)
                # 取出描述：移除金額部分後剩餘文字
                description = re.sub(r'\$\s*[\d,]+(?:\.\d+)?', '', text).strip()
                if not description:
                    description = "費用"
                return {"description": description, "amount": amount}
            except ValueError:
                pass

        # ── Ollama LLM 解析（複雜格式 fallback）──────────────────
        return await self._llm_parse(text)

    async def _llm_parse(self, text: str) -> dict | None:
        """呼叫 Ollama 本地模型解析"""
        prompt = f"""你是一個費用解析助手。請從以下訊息中擷取費用項目名稱和金額。
只回傳 JSON 格式，例如：{{"description": "晚餐", "amount": 350.0}}
若無法判斷金額則回傳：{{"error": "無法解析"}}

訊息：{text}

JSON:"""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{self.base_url}/api/generate",
                    json={"model": self.model, "prompt": prompt, "stream": False}
                )
                resp.raise_for_status()
                data = resp.json()
                raw = data.get("response", "").strip()
                # 擷取 JSON 區塊
                json_match = re.search(r'\{.*?\}', raw, re.DOTALL)
                if json_match:
                    parsed = json.loads(json_match.group())
                    if "error" not in parsed and "amount" in parsed:
                        return parsed
        except Exception as e:
            print(f"[NLPAgent] LLM 解析失敗: {e}")
        return None

    async def classify_intent(self, text: str) -> str:
        """
        分類使用者意圖：
        - "expense"    : 記錄費用
        - "settle"     : 結算
        - "join"       : 加入分帳
        - "leave"      : 離開分帳
        - "list"       : 查看清單
        - "help"       : 說明
        - "unknown"    : 不明
        """
        text_lower = text.lower().strip()

        # 關鍵字快速判斷
        if '$' in text:
            return "expense"
        if any(k in text_lower for k in ["結算", "settle", "算帳", "結帳"]):
            return "settle"
        if any(k in text_lower for k in ["加入", "join", "我要參加", "算我"]):
            return "join"
        if any(k in text_lower for k in ["退出", "leave", "不算我", "我不參加"]):
            return "leave"
        if any(k in text_lower for k in ["清單", "list", "查看", "明細", "費用"]):
            return "list"
        if any(k in text_lower for k in ["help", "說明", "指令", "怎麼用", "幫助"]):
            return "help"

        # 不明意圖交給 LLM
        return await self._llm_classify(text)

    async def _llm_classify(self, text: str) -> str:
        prompt = f"""將以下訊息分類為其中一個意圖，只回傳意圖名稱：
expense, settle, join, leave, list, help, unknown

訊息：{text}

意圖："""
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{self.base_url}/api/generate",
                    json={"model": self.model, "prompt": prompt, "stream": False}
                )
                resp.raise_for_status()
                raw = resp.json().get("response", "unknown").strip().lower()
                for intent in ["expense", "settle", "join", "leave", "list", "help"]:
                    if intent in raw:
                        return intent
        except Exception as e:
            print(f"[NLPAgent] 意圖分類失敗: {e}")
        return "unknown"

    async def check_ollama_health(self) -> bool:
        """檢查 Ollama 是否在線"""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.base_url}/api/tags")
                return resp.status_code == 200
        except Exception:
            return False
