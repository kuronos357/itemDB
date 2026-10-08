"""
Notion目録DBの登録アイテム一覧と最新IDの確認
"""
import sys
import json
import urllib.request

if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os

TOKEN = os.environ.get('NOTION_TOKEN', '')
ITEM_DB_ID = '3dc5e314fd47809088a5000b035baac0'
LOC_DB_ID = '3e05e314fd4780e2a08a000b4bc0c86a'


def query_db(db_id, label):
    url = f"https://api.notion.com/v1/databases/{db_id}/query"
    req = urllib.request.Request(
        url,
        data=json.dumps({"page_size": 100}).encode('utf-8'),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            results = data.get("results", [])
            print(f"\n=== {label} (計 {len(results)} 件) ===")
            for page in results:
                props = page.get("properties", {})
                title = "(無題)"
                for k, v in props.items():
                    if v.get("type") == "title":
                        t_list = v.get("title", [])
                        if t_list:
                            title = t_list[0].get("plain_text", "")
                        break
                
                # IDプロパティの探索
                id_val = None
                for k in ["ID", "id", "番号"]:
                    if k in props:
                        p = props[k]
                        ptype = p.get("type")
                        if ptype == "unique_id":
                            id_val = p.get("unique_id", {}).get("number")
                        elif ptype == "number":
                            id_val = p.get("number")
                        elif ptype == "formula":
                            f = p.get("formula", {})
                            id_val = f.get("number") or f.get("string")
                        elif ptype == "rich_text":
                            rt = p.get("rich_text", [])
                            if rt: id_val = rt[0].get("plain_text")
                print(f"  - ID: {id_val} | 名前: {title} | PageID: {page.get('id')}")
            return results
    except urllib.error.HTTPError as e:
        print(f"[!] エラー ({label}): HTTP {e.code} - {e.read().decode('utf-8')}")
        return []


if __name__ == "__main__":
    query_db(ITEM_DB_ID, "物品DB (目録)")
    query_db(LOC_DB_ID, "場所DB (物理アドレス)")
