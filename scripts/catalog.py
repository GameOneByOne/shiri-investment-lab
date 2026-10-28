"""Fetch one A-share catalogue snapshot, sequentially with checkpoints.

No price downloads or credentials. Stop on an upstream error; rerunning resumes
the same snapshot. Delete/rename the checkpoint explicitly for a fresh snapshot.
"""
import json
import math
import random
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'work' / 'a-share-catalog.json'
ENDPOINT = 'https://82.push2.eastmoney.com/api/qt/clist/get'
FILTER = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'


def normalize(row):
    code = row['f12']
    if len(code) != 6 or not code.isdigit():
        raise ValueError('Invalid stock code')
    exchange = 'sh' if code.startswith('6') else 'sz' if code.startswith(('0', '3')) else 'bj' if code.startswith(('4', '8', '92')) else None
    if not exchange or (exchange == 'sh') != (row['f13'] == 1):
        raise ValueError('Unexpected exchange or share class')
    name = row['f14']
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Missing stock name')
    listed = datetime.strptime(str(row['f26']), '%Y%m%d').date().isoformat()
    return {'symbol': exchange + code, 'name': name, 'listed': listed,
            'start': max('2020-01-01', listed), 'kind': '股票', 'exchange': exchange}


def main():
    OUTPUT.parent.mkdir(exist_ok=True)
    snapshot = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {
        'source': ENDPOINT, 'filter': FILTER, 'startedAt': datetime.now(timezone.utc).isoformat(), 'pages': []}
    if snapshot.get('complete'):
        print('Already complete:', len(snapshot['stocks']), flush=True)
        return
    page = len(snapshot['pages']) + 1
    while True:
        params = dict(pn=page, pz=100, po=1, np=1, fltt=2, invt=2, fid='f12', fs=FILTER, fields='f12,f13,f14,f26')
        request = urllib.request.Request(ENDPOINT + '?' + urllib.parse.urlencode(params), headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(request, timeout=25) as response:
            body = json.load(response)
        data = body['data']
        if body['rc'] != 0 or not data or not isinstance(data['diff'], list) or not data['diff']:
            raise ValueError('Invalid or empty catalogue page')
        total = data['total']
        if not 4000 <= total <= 12000 or ('total' in snapshot and total != snapshot['total']):
            raise ValueError('Catalogue count changed; restart with a new checkpoint')
        snapshot['total'] = total
        snapshot['pages'].append(data['diff'])
        stocks = [normalize(row) for chunk in snapshot['pages'] for row in chunk]
        if len({s['symbol'] for s in stocks}) != len(stocks):
            raise ValueError('Duplicate stocks across pages; refusing incomplete universe')
        pages = math.ceil(total / 100)
        if page == pages:
            if len(stocks) != total:
                raise ValueError('Catalogue count mismatch')
            snapshot.update(complete=True, stocks=stocks, finishedAt=datetime.now(timezone.utc).isoformat())
        OUTPUT.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'Catalogue page {page}/{pages}; stocks {len(stocks)}/{total}', flush=True)
        if snapshot.get('complete'):
            return
        page += 1
        time.sleep(random.uniform(5, 8))


if __name__ == '__main__':
    main()
