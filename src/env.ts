export interface Env {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  DB: D1Database;
  AI: any;
  ADMIN_LINE_USER_ID?: string;
  LIFF_ID_CURRENT?: string;
  LIFF_ID_HISTORY?: string;
}
