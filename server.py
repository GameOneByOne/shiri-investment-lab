#!/usr/bin/env python3
"""Local historical-investing playground. Python 3 + curl, no Python dependencies."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone, date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
import argparse
import json
import re
import sqlite3
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
DB = ROOT / 'work' / 'market.sqlite3'
TZ = timezone(timedelta(hours=8))
LOCKS = {}
LOCK_GUARD = threading.Lock()
NETWORK = threading.BoundedSemaphore(3)
UPSTREAM = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
POPULAR = [
    {'symbol':'sh600519','name':'贵州茅台','kind':'股票'},
    {'symbol':'sz000001','name':'平安银行','kind':'股票'},
    {'symbol':'sh600036','name':'招商银行','kind':'股票'},
    {'symbol':'sz300750','name':'宁德时代','kind':'股票'},
    {'symbol':'sh510300','name':'沪深300ETF','kind':'ETF'},
    {'symbol':'sh510500','name':'中证500ETF','kind':'ETF'},
    {'symbol':'sh510050','name':'上证50ETF','kind':'ETF'},
    {'symbol':'sh000001','name':'上证指数','kind':'指数'},
]


def last_complete_date():
    now = datetime.now(TZ)
    # Give the source an hour after close to finalize its daily bar.
    return (now.date() if now.hour >= 16 else now.date()-timedelta(days=1)).isoformat()


def connect():
    db = sqlite3.connect(DB, timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    return db


def init_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS history (symbol TEXT, year INTEGER, adjust TEXT, fetched REAL, data TEXT, PRIMARY KEY(symbol, year, adjust))')


def download(url):
    with NETWORK:
        p = subprocess.run(['curl','-f','-sS','--connect-timeout','5','--max-time','18','-A','Mozilla/5.0',url],capture_output=True)
    if p.returncode:
        raise RuntimeError('行情源暂时无法连接，请稍后重试。')
    return p.stdout


def load_year(symbol, year, adjust):
    key = (symbol,year,adjust)
    with LOCK_GUARD:
        lock = LOCKS.setdefault(key,threading.Lock())
    with lock:
        with connect() as db:
            cached = db.execute('SELECT fetched,data FROM history WHERE symbol=? AND year=? AND adjust=?',key).fetchone()
        # Adjusted historical values can change after corporate actions. Refresh ALL
        # cached years daily, not only the current year. Raw index bars refresh weekly.
        ttl = 86400 if adjust else 604800
        if year == datetime.now(TZ).year:
            ttl = 3600
        if cached and time.time()-cached[0] < ttl:
            return json.loads(cached[1]), True
        query = {'param':f'{symbol},day,{year}-01-01,{year}-12-31,640,{adjust}'}
        error = None
        for attempt in range(2):
            try:
                payload = json.loads(download(UPSTREAM+'?'+urlencode(query)))
                obj = payload.get('data',{}).get(symbol,{})
                # Tencent sometimes returns raw `day` when a symbol has no factor.
                values = obj.get('qfqday' if adjust else 'day')
                if values is None:
                    values = obj.get('day')
                if values is None:
                    raise ValueError('数据源没有返回该证券的日线。请检查代码或更换标的。')
                rows = []
                for r in values:
                    if not f'{year}-01-01' <= r[0] <= f'{year}-12-31':
                        continue
                    date.fromisoformat(r[0])
                    prices = [float(x) for x in r[1:5]]
                    if not all(0 < x < 1e9 for x in prices):
                        raise ValueError('行情价格校验失败。')
                    o,c,h,l = prices
                    if not l <= min(o,c) <= max(o,c) <= h:
                        raise ValueError('行情高低价校验失败。')
                    rows.append({'date':r[0],'open':o,'close':c,'high':h,'low':l})
                rows.sort(key=lambda r:r['date'])
                if len({r['date'] for r in rows}) != len(rows):
                    raise ValueError('行情出现重复日期。')
                with connect() as db:
                    db.execute('INSERT OR REPLACE INTO history VALUES (?,?,?,?,?)',(*key,time.time(),json.dumps(rows)))
                return rows,False
            except (ValueError,RuntimeError,KeyError,TypeError) as e:
                error=e
                if attempt==0:
                    time.sleep(.6)
        # Do not silently mix stale and newly adjusted years: that creates jumps.
        raise RuntimeError(str(error))


def get_history(symbol,start,end):
    if not re.fullmatch(r'(sh|sz|bj)\d{6}',symbol):
        raise ValueError('证券代码格式不正确。')
    start_date,end_date = date.fromisoformat(start),date.fromisoformat(end)
    if start_date < date(1990,1,1) or start_date > end_date:
        raise ValueError('请输入 1990 年起的有效日期范围。')
    if end > last_complete_date():
        raise ValueError('结束日期不能晚于已收盘的数据日期。')
    adjust = '' if symbol == 'sh000001' else 'qfq'
    years = range(start_date.year,end_date.year+1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        chunks=list(pool.map(lambda y:load_year(symbol,y,adjust),years))
    rows=[r for chunk,_ in chunks for r in chunk if start <= r['date'] <= end]
    if not rows:
        raise ValueError('该标的在所选区间没有可用日线，可能尚未上市或已停止交易。')
    return dict(symbol=symbol,source='腾讯财经',adjust='qfq' if adjust else 'none',bars=rows,
                cached=all(hit for _,hit in chunks),firstDate=rows[0]['date'],lastDate=rows[-1]['date'])


def search(query):
    if not query:
        return POPULAR
    matches=[x for x in POPULAR if query.lower() in (x['name']+x['symbol']).lower()]
    try:
        raw=download('https://smartbox.gtimg.cn/s3/?'+urlencode({'q':query[:40],'t':'all'})).decode('gb18030')
        text=re.sub(r'\\u([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),raw)
        body=re.search(r'v_hint="(.*?)"',text,re.S)
        for item in (body[1].split('^') if body else []):
            fields=item.split('~')
            if len(fields)<3 or fields[0] not in ['sh','sz','bj'] or not re.fullmatch(r'\d{6}',fields[1]):
                continue
            symbol=fields[0]+fields[1]
            if symbol not in {x['symbol'] for x in matches}:
                matches.append(dict(symbol=symbol,name=fields[2],kind='ETF' if 'ETF' in fields[2].upper() else '证券'))
    except Exception:
        # Known stocks remain selectable if remote search is down.
        pass
    return matches[:12]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT/'web'),**kwargs)

    def send_json(self,payload,status=200):
        content=json.dumps(payload,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(content)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path=urlparse(self.path)
        params=parse_qs(path.query)
        get=lambda k,default='':params.get(k,[default])[0]
        try:
            if path.path=='/api/config':
                return self.send_json(dict(lastCompleteDate=last_complete_date(),popular=POPULAR))
            if path.path=='/api/search':
                return self.send_json(dict(results=search(get('q'))))
            if path.path=='/api/history':
                return self.send_json(get_history(get('symbol'),get('start'),get('end')))
            if path.path.startswith('/api/'):
                return self.send_json(dict(error='接口不存在。'),404)
            super().do_GET()
        except ValueError as e:
            self.send_json(dict(error=str(e)),400)
        except Exception as e:
            print('API error:',repr(e),flush=True)
            self.send_json(dict(error=str(e) if isinstance(e,RuntimeError) else '数据处理失败，请稍后重试。'),502)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    init_db()
    httpd=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'\n  拾日 · 历史定投实验室\n  http://127.0.0.1:{args.port}\n',flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()
