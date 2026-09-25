/**
 * Cloudflare Pages Functions - JANコード商品情報検索API (/api/jan)
 * 
 * Yahoo!ショッピング商品検索API (v3) を中継し、CORSを回避して
 * 日本国内のJANコードから商品名・メーカー・カテゴリ・高画質商品画像を取得します。
 * Yahoo Client ID未設定時や未ヒット時は Open Food Facts / Google Books へ自動フォールバックします。
 */

function cleanProductName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').trim();
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORSプリフライト
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, accept",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const corsHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, accept"
  };

  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || url.searchParams.get("jan") || "").replace(/[-\s]/g, "").trim();
  const clientAppId = url.searchParams.get("appid") || url.searchParams.get("appId") || "";
  const appId = clientAppId || (env && env.YAHOO_APP_ID) || "";

  if (!code) {
    return new Response(JSON.stringify({ found: false, error: "JAN/ISBNコードが指定されていません" }), {
      status: 400,
      headers: corsHeaders
    });
  }

  let yahooErrorMsg = null;
  if (appId) {
    try {
      // 5件取得して、最もシンプルなタイトルを選定
      const yUrl = `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=${encodeURIComponent(appId)}&jan_code=${encodeURIComponent(code)}&results=5`;
      const yRes = await fetch(yUrl, {
        headers: {
          "User-Agent": "itemDB-Cloudflare/1.0"
        }
      });

      if (yRes.ok) {
        const yData = await yRes.json();
        if (yData.hits && yData.hits.length > 0) {
          // 最短・最適タイトルの選定
          let bestHit = yData.hits[0];
          let bestCleaned = cleanProductName(bestHit.name || "");

          for (let i = 1; i < yData.hits.length; i++) {
            const h = yData.hits[i];
            const c = cleanProductName(h.name || "");
            if (c && c.length >= 8 && c.length < bestCleaned.length) {
              bestHit = h;
              bestCleaned = c;
            }
          }

          const rawTitle = bestHit.name || "";
          const brand = bestHit.brand?.name || bestHit.seller?.name || "";
          const category = bestHit.genreCategory?.name || "";
          let imageUrl = bestHit.image?.medium || bestHit.image?.small || null;
          if (imageUrl && imageUrl.startsWith("http://")) {
            imageUrl = imageUrl.replace("http://", "https://");
          }

          return new Response(JSON.stringify({
            found: true,
            source: "yahoo",
            code,
            title: bestCleaned,
            rawTitle,
            brand,
            category,
            price: bestHit.price || null,
            imageUrl
          }), {
            status: 200,
            headers: corsHeaders
          });
        } else {
          yahooErrorMsg = "Yahoo!商品検索で該当する商品が見つかりませんでした (ヒット数0件)";
        }
      } else {
        const errText = await yRes.text();
        console.warn(`[Yahoo API Error] status=${yRes.status} body=${errText}`);
        if (yRes.status === 401 || yRes.status === 403) {
          yahooErrorMsg = `Yahoo! APIエラー (HTTP ${yRes.status}): Client IDが無効か、未承認の可能性があります`;
        } else {
          yahooErrorMsg = `Yahoo! APIエラー (HTTP ${yRes.status})`;
        }
      }
    } catch (yErr) {
      console.warn(`[Yahoo API Exception] ${yErr.message}`);
      yahooErrorMsg = `Yahoo! 通信エラー: ${yErr.message}`;
    }
  }

  // 2. Open Food Facts API フォールバック
  try {
    const offUrl = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
    const offRes = await fetch(offUrl, {
      headers: { "User-Agent": "itemDB - Web - 1.0" }
    });
    if (offRes.ok) {
      const offData = await offRes.json();
      if (offData.status === 1 && offData.product) {
        const p = offData.product;
        const title = p.product_name_ja || p.product_name || p.product_name_en || "";
        const brand = p.brands || "";
        let imageUrl = p.image_url || p.image_front_url || null;
        if (imageUrl && imageUrl.startsWith("http://")) {
          imageUrl = imageUrl.replace("http://", "https://");
        }

        if (title) {
          return new Response(JSON.stringify({
            found: true,
            source: "openfoodfacts",
            code,
            title,
            brand,
            category: p.categories || "",
            imageUrl
          }), {
            status: 200,
            headers: corsHeaders
          });
        }
      }
    }
  } catch (offErr) {
    console.warn(`[OpenFoodFacts Exception] ${offErr.message}`);
  }

  // 3. Google Books API フォールバック (書籍・雑誌・ムック等のJAN)
  try {
    const gUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(code)}`;
    const gRes = await fetch(gUrl);
    if (gRes.ok) {
      const gData = await gRes.json();
      if (gData.items && gData.items.length > 0) {
        const vol = gData.items[0].volumeInfo || {};
        const title = vol.title || "";
        const author = Array.isArray(vol.authors) ? vol.authors.join(", ") : "";
        const publisher = vol.publisher || "";
        let imageUrl = vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail || null;
        if (imageUrl && imageUrl.startsWith("http://")) {
          imageUrl = imageUrl.replace("http://", "https://");
        }

        if (title) {
          return new Response(JSON.stringify({
            found: true,
            source: "googlebooks",
            code,
            title,
            brand: publisher,
            author,
            category: "書籍",
            imageUrl
          }), {
            status: 200,
            headers: corsHeaders
          });
        }
      }
    }
  } catch (gErr) {
    console.warn(`[GoogleBooks Exception] ${gErr.message}`);
  }

  // 4. 見つからなかった場合
  return new Response(JSON.stringify({
    found: false,
    code,
    title: "",
    hasAppId: Boolean(appId),
    message: yahooErrorMsg || (appId ? "商品情報が見つかりませんでした" : "商品情報が見つかりませんでした（Yahoo Client IDを設定すると高精度で取得できます）")
  }), {
    status: 200,
    headers: corsHeaders
  });
}
