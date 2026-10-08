"""
Notionの場所（物理アドレス）データを詳細確認するスクリプト
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
LOC_DS_ID = '3e05e314-fd47-80e2-a08a-000b4bc0c86a'

url = "https://api.notion.com/v1/search"
req = urllib.request.Request(
    url,
    data=json.dumps({"filter": {"value": "page", "property": "object"}, "page_size": 100}).encode('utf-8'),
    headers={"Authorization": f"Bearer {TOKEN}", "Notion-Version": "2022-06-28", "Content-Type": "application/json"},
    method="POST"
)

with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode('utf-8'))

print(f"全ページ数: {len(data['results'])}")
for p in data['results']:
    props = p.get('properties', {})
    title = ""
    if '名前' in props and props['名前'].get('title'):
        title = props['名前']['title'][0].get('plain_text', '')
    
    id_num = None
    if 'ID' in props:
        id_prop = props['ID']
        if id_prop.get('type') == 'formula':
            id_num = id_prop.get('formula', {}).get('number')
        elif id_prop.get('type') == 'number':
            id_num = id_prop.get('number')
            
    # 親データベース・データソースの確認
    parent = p.get('parent', {})
    
    # 奇数ID または 本棚・ベッドなど場所らしきもの
    if (id_num is not None and id_num % 2 == 1) or title in ['本棚', 'ベッド']:
        print(f"\n[場所候補] ID: {id_num} | 名前: '{title}' | PageID: {p['id']}")
        print(f"  Parent: {parent}")
        print(f"  Properties: {list(props.keys())}")
        if 'ID' in props:
            print(f"  ID property details: {props['ID']}")
        if 'URL' in props:
            print(f"  URL: {props['URL']}")
        if '行番号' in props:
            print(f"  行番号: {props['行番号']}")
