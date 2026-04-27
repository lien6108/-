import { Hono } from 'hono';
import { validateSignature } from '@line/bot-sdk';
import { Env } from './env';
import { LineEventHandler } from './lineHandler';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => {
  return c.json({ status: 'ok', service: '分帳神器 LINE Bot (Cloudflare Workers)' });
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
