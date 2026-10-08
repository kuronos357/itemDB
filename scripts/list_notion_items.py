"""
Notionから全登録ページを取得し、名前・ID・URLを一覧表示するスクリプト
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


def fetch_all():
    url = "https://api.notion.com/v1/search"
    body = {
        "filter": {"value": "page", "property": "object"},
        "page_size": 100
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode('utf-8'),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        results = data.get("results", [])
        print(f"取得件数: {len(results)} 件\n")
        items = []
        for p in results:
            props = p.get("properties", {})
            title = "(無題)"
            if "名前" in props and props["名前"].get("title"):
                title = props["名前"]["title"][0].get("plain_text", "(無題)")

            id_num = None
            if "ID" in props:
                id_prop = props["ID"]
                if id_prop.get("type") == "formula":
                    id_num = id_prop.get("formula", {}).get("number")
                elif id_prop.get("type") == "number":
                    id_num = id_prop.get("number")

            line_num = None
            if "行番号" in props:
                line_prop = props["行番号"]
                if line_prop.get("type") == "unique_id":
                    line_num = line_prop.get("unique_id", {}).get("number")

            url_str = ""
            if "URL" in props:
                url_prop = props["URL"]
                if url_prop.get("type") == "formula":
                    url_str = url_prop.get("formula", {}).get("string", "")

            items.append({
                "title": title,
                "id": id_num,
                "line": line_num,
                "url": url_str,
                "page_id": p.get("id")
            })

        # ID順にソートして表示
        sorted_items = sorted(items, key=lambda x: (x["id"] is None, x["id"] or 0))
        for it in sorted_items:
            print(f"  ID: {str(it['id']):>4} (行: {str(it['line']):>2}) | {it['title']} | {it['url']}")


if __name__ == "__main__":
    fetch_all()
