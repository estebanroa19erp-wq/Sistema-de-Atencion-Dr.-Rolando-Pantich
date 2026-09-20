// Cloudflare Worker — Proxy para Bot Dr. Pantich
// Deploy: https://workers.cloudflare.com (pegar este código, añadir KV binding "KV")
// KV namespace: crear una llamada "KV", bindear con variable "KV"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Bot-Secret'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // Bot registra su URL al iniciar: PUT /register {botUrl, secret}
    if (url.pathname === '/register' && request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      if (!body.botUrl) return new Response('missing botUrl', { status: 400, headers: CORS });
      if (env.BOT_SECRET && body.secret !== env.BOT_SECRET)
        return new Response('unauthorized', { status: 401, headers: CORS });
      await env.KV.put('bot_url', body.botUrl, { expirationTtl: 86400 * 7 });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // Proxy al bot
    const botUrl = await env.KV.get('bot_url');
    if (!botUrl) {
      return new Response(JSON.stringify({ error: 'Bot offline', ok: false }), {
        status: 503,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    try {
      const target = botUrl.replace(/\/$/, '') + url.pathname + url.search;
      const proxied = await fetch(target, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: ['POST','PUT','PATCH'].includes(request.method) ? request.body : undefined
      });
      const data = await proxied.text();
      return new Response(data, {
        status: proxied.status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Bot unreachable', ok: false }), {
        status: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }
  }
};
