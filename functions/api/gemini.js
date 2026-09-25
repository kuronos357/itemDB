/**
 * Cloudflare Pages Functions - Gemini API Proxy (/api/gemini)
 * 
 * Google AI Studio (Gemini 2.5 Flash) との通信を中継し、
 * CORS制限の回避および安全なプロキシ通信を提供します。
 */

export async function onRequest(context) {
  const { request, env } = context;

  // CORSプリフライト
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, accept, x-goog-api-key",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const corsHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, accept, x-goog-api-key"
  };

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: corsHeaders
    });
  }

  // APIキーの抽出 (ヘッダー x-goog-api-key または Bearer、または クエリパラメータ key)
  const url = new URL(request.url);
  let apiKey = request.headers.get("x-goog-api-key") || url.searchParams.get("key");
  if (!apiKey) {
    const authHeader = request.headers.get("Authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      apiKey = authHeader.slice(7).trim();
    }
  }
  if (!apiKey && env && env.GEMINI_API_KEY) {
    apiKey = env.GEMINI_API_KEY;
  }

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Gemini API key is required" }), {
      status: 401,
      headers: corsHeaders
    });
  }

  const model = url.searchParams.get("model") || "gemini-3.1-flash-lite";
  const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const body = await request.arrayBuffer();
    const gRes = await fetch(geminiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body
    });

    const data = await gRes.text();
    return new Response(data, {
      status: gRes.status,
      statusText: gRes.statusText,
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Gemini proxy error: ${err.message}` }), {
      status: 502,
      headers: corsHeaders
    });
  }
}
