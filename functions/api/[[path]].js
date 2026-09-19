/**
 * Cloudflare Pages Functions - Notion API CORS Proxy
 * 
 * Cloudflare Pagesにデプロイされた場合、フロントエンドからの
 * /api/databases/... や /api/pages/... といったリクエストを受け取り、
 * 本家 https://api.notion.com/v1/... へサーバー側で中継してCORSヘッダーを付与します。
 */

export async function onRequest(context) {
  const { request, params } = context;

  // CORSプリフライト (OPTIONS) の処理
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Notion-Version, Content-Type, accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // [[path]] で受け取ったパス配列を結合 (例: ["databases", "3dc5..."])
  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
  const url = new URL(request.url);
  const targetUrl = new URL(`https://api.notion.com/v1/${path}${url.search}`);

  // リクエストヘッダーを複製
  const newHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower !== "host" && lower !== "origin" && lower !== "referer") {
      newHeaders.set(key, value);
    }
  }

  // Notion API バージョンが未指定ならデフォルト設定 (2025-09-03: マルチデータソースDB対応)
  if (!newHeaders.has("notion-version")) {
    newHeaders.set("notion-version", "2025-09-03");
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "follow",
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Authorization, Notion-Version, Content-Type, accept");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
