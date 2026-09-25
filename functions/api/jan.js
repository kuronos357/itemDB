/**
 * Cloudflare Pages Functions - JANコード商品情報検索API (/api/jan)
 * 
 * Yahoo!ショッピング商品検索API (v3) を中継し、CORSを回避して
 * 日本国内のJANコードから商品名・メーカー・カテゴリ・高画質商品画像を取得します。
 * 高速応答のため、結果件数の最小化(2件)とタイムアウト制御、インメモリキャッシュを適用しています。
 */

function cleanProductName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').trim();
}

// インメモリキャッシュ (同じコードの検索を即時・確実に返す)
const JAN_CACHE = new Map();
const CACHE_TTL_MS = 3600 * 1000; // 1時間

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

  // 1. キャッシュヒットの確認 (即座に0ms返却)
  const cached = JAN_CACHE.get(code);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return new Response(JSON.stringify(cached.data), {
      status: 200,
      headers: corsHeaders
    });
  }

  let yahooErrorMsg = null;
  if (appId) {
    try {
      // 1. jan_code パラメータで厳密検索 (results=2 で最速化)
      const yUrl = `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=${encodeURIComponent(appId)}&jan_code=${encodeURIComponent(code)}&results=2`;
      const yRes = await fetch(yUrl, {
        headers: {
          "User-Agent": "itemDB-Cloudflare/1.0"
        },
        signal: AbortSignal.timeout(2500)
      });

      let yData = null;
      if (yRes.ok) {
        yData = await yRes.json();
      } else {
        const errText = await yRes.text();
        console.warn(`[Yahoo API Error] status=${yRes.status} body=${errText}`);
        let detail = "";
        try {
          const errObj = JSON.parse(errText);
          detail = errObj?.Error?.Message || errObj?.message || "";
        } catch (_) {}
        if (detail) {
          yahooErrorMsg = `Yahoo! APIエラー (HTTP ${yRes.status}): ${detail}`;
        } else if (yRes.status === 401 || yRes.status === 403) {
          yahooErrorMsg = `Yahoo! APIエラー (HTTP ${yRes.status}): Client IDが無効か、未承認の可能性があります`;
        } else {
          yahooErrorMsg = `Yahoo! APIエラー (HTTP ${yRes.status})`;
        }
      }

      // 2. jan_codeで0件の場合のみ、query=JANコードで高速フォールバック
      if (yData && (!yData.hits || yData.hits.length === 0) && !yahooErrorMsg) {
        const queryUrl = `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=${encodeURIComponent(appId)}&query=${encodeURIComponent(code)}&results=2`;
        const qRes = await fetch(queryUrl, {
          headers: {
            "User-Agent": "itemDB-Cloudflare/1.0"
          },
          signal: AbortSignal.timeout(2000)
        });
        if (qRes.ok) {
          const qData = await qRes.json();
          if (qData.hits && qData.hits.length > 0) {
            yData = qData;
          }
        }
      }

      // ヒットした場合の最適タイトル抽出
      if (yData && yData.hits && yData.hits.length > 0) {
        const validHits = yData.hits.filter(h => h && h.name && cleanProductName(h.name).length > 0);
        if (validHits.length > 0) {
          let bestHit = validHits[0];
          let bestCleaned = cleanProductName(bestHit.name);

          for (let i = 1; i < validHits.length; i++) {
            const h = validHits[i];
            const c = cleanProductName(h.name);
            if (c.length < bestCleaned.length) {
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

          const resultPayload = {
            found: true,
            source: "yahoo",
            code,
            title: bestCleaned,
            rawTitle,
            brand,
            category,
            price: bestHit.price || null,
            imageUrl,
            url: bestHit.url || null
          };

          // キャッシュに保存
          JAN_CACHE.set(code, { timestamp: Date.now(), data: resultPayload });

          return new Response(JSON.stringify(resultPayload), {
            status: 200,
            headers: corsHeaders
          });
        }
      } else if (!yahooErrorMsg) {
        yahooErrorMsg = "Yahoo!商品検索で該当する商品が見つかりませんでした (ヒット数0件)";
      }
    } catch (yErr) {
      console.warn(`[Yahoo API Exception] ${yErr.message}`);
      yahooErrorMsg = `Yahoo! 通信エラー: ${yErr.message}`;
    }
  }

  // 3. Open Food Facts API フォールバック (タイムアウト1.2秒で高速化)
  try {
    const offUrl = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
    const offRes = await fetch(offUrl, {
      headers: { "User-Agent": "itemDB - Web - 1.0" },
      signal: AbortSignal.timeout(1200)
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
          const offPayload = {
            found: true,
            source: "openfoodfacts",
            code,
            title,
            brand,
            category: p.categories || "",
            imageUrl,
            url: `https://jp.openfoodfacts.org/product/${encodeURIComponent(code)}`
          };
          JAN_CACHE.set(code, { timestamp: Date.now(), data: offPayload });

          return new Response(JSON.stringify(offPayload), {
            status: 200,
            headers: corsHeaders
          });
        }
      }
    }
  } catch (offErr) {
    // タイムアウトまたは失敗時は次へ
  }

  // 4. 書籍コード (ISBN: 978/979) の場合の専門APIフォールバック (openBD & NDL)
  if (code.startsWith("978") || code.startsWith("979")) {
    // 4-1. openBD API (国内書籍・書影あり)
    try {
      const obdRes = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(code)}`, {
        signal: AbortSignal.timeout(1500)
      });
      if (obdRes.ok) {
        const obdData = await obdRes.json();
        if (Array.isArray(obdData) && obdData[0]?.summary) {
          const s = obdData[0].summary;
          const title = s.title || "";
          const author = s.author || "";
          const publisher = s.publisher || "";
          let imageUrl = s.cover || null;
          if (imageUrl && imageUrl.startsWith("http://")) {
            imageUrl = imageUrl.replace("http://", "https://");
          }

          if (title) {
            const obdPayload = {
              found: true,
              source: "openbd",
              code,
              title,
              brand: publisher,
              author,
              category: "書籍",
              imageUrl
            };
            JAN_CACHE.set(code, { timestamp: Date.now(), data: obdPayload });
            return new Response(JSON.stringify(obdPayload), {
              status: 200,
              headers: corsHeaders
            });
          }
        }
      }
    } catch (_) {}

    // 4-2. 国立国会図書館サーチ (NDL Search API: 国内出版物網羅)
    try {
      const ndlUrl = `https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${encodeURIComponent(code)}`;
      const ndlRes = await fetch(ndlUrl, { signal: AbortSignal.timeout(2000) });
      if (ndlRes.ok) {
        const xml = await ndlRes.text();
        const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/);
        if (itemMatch) {
          const item = itemMatch[1];
          const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
          const rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';

          const creatorMatch = item.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) || item.match(/<author>([\s\S]*?)<\/author>/);
          const author = creatorMatch ? creatorMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';

          const pubMatch = item.match(/<dc:publisher>([\s\S]*?)<\/dc:publisher>/);
          const publisher = pubMatch ? pubMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';

          if (rawTitle) {
            const ndlPayload = {
              found: true,
              source: "ndl",
              code,
              title: rawTitle,
              brand: publisher,
              author,
              category: "書籍",
              imageUrl: null
            };
            JAN_CACHE.set(code, { timestamp: Date.now(), data: ndlPayload });
            return new Response(JSON.stringify(ndlPayload), {
              status: 200,
              headers: corsHeaders
            });
          }
        }
      }
    } catch (_) {}
  }

  // 5. Google Books API フォールバック (洋書対応・タイムアウト1.2秒)
  try {
    const gUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(code)}`;
    const gRes = await fetch(gUrl, {
      signal: AbortSignal.timeout(1200)
    });
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
          const gPayload = {
            found: true,
            source: "googlebooks",
            code,
            title,
            brand: publisher,
            author,
            category: "書籍",
            imageUrl,
            url: vol.infoLink || null
          };
          JAN_CACHE.set(code, { timestamp: Date.now(), data: gPayload });

          return new Response(JSON.stringify(gPayload), {
            status: 200,
            headers: corsHeaders
          });
        }
      }
    }
  } catch (gErr) {
    // タイムアウトまたは失敗
  }

  // 5. 見つからなかった場合
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
