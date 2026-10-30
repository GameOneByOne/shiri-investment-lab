"""Scheduled market ingestion. Python 3.10+ and curl; no web/user code.

Every symbol is refreshed over its configured full history so corporate actions
uses raw closing prices from 2021. Cloud collection uses the paced Edge queue.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import argparse
import json
import math
import os
import re
import subprocess
import time

TZ = timezone(timedelta(hours=8))
UPSTREAM = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
POOL = Path(__file__).with_name('stock-pool.json')


def load_pool(path=POOL):
    pool = json.loads(Path(path).read_text(encoding='utf-8'))
    if not pool or len(pool) > 100:
        raise ValueError('股票池必须包含 1 至 100 个标的。')
    symbols = set()
    for item in pool:
        symbol = item['symbol']
        if not re.fullmatch(r'(sh|sz|bj)\d{6}', symbol) or symbol in symbols:
            raise ValueError('股票池代码无效或重复。')
        symbols.add(symbol)
        if item['kind'] not in ('股票', 'ETF', '指数') or not item['name'].strip():
            raise ValueError('股票池名称或类型无效。')
        # Only this benchmark currently has a verified raw-index adapter.
        if item['kind'] == '指数' and symbol != 'sh000001':
            raise ValueError('当前指数适配仅支持上证指数。')
        if not date(1990, 1, 1) <= date.fromisoformat(item['start']) <= datetime.now(TZ).date():
            raise ValueError('股票池历史起始日期无效。')
    if 'sh000001' not in symbols:
        raise ValueError('股票池必须包含上证指数，供日期边界及基准对比使用。')
    return pool


def normalize(payload, symbol, year, end, adjust=None):
    if payload.get('code', 0) != 0:
        raise ValueError('行情源返回错误。')
    obj = payload.get('data', {}).get(symbol)
    if not isinstance(obj, dict):
        raise ValueError('行情源缺少证券数据。')
    if adjust not in (None, 'none'):
        raise ValueError('仅支持不复权价格。')
    values = obj.get('day')
    if not isinstance(values, list):
        raise ValueError('行情源缺少 day 数据。')
    rows = []
    for row in values:
        if not isinstance(row, list) or len(row) < 3:
            raise ValueError('日线格式无效。')
        trade_date = date.fromisoformat(row[0])
        if trade_date.year != year or trade_date.isoformat() > end or trade_date < date(2021, 1, 1):
            continue
        close = float(row[2])
        if not math.isfinite(close) or not 0 < close < 1e9:
            raise ValueError('收盘价校验失败。')
        rows.append(dict(date=row[0], close=close))
    rows.sort(key=lambda x: x['date'])
    if len({r['date'] for r in rows}) != len(rows):
        raise ValueError('行情日期重复。')
    return rows


def download_year(symbol, year, end):
    adjust = ''
    query = urlencode({'param': f'{symbol},day,{year}-01-01,{year}-12-31,640,{adjust}'})
    for attempt in range(3):
        try:
            result = subprocess.run(
                ['curl', '-f', '-sS', '--connect-timeout', '5', '--max-time', '25',
                 '-A', 'Mozilla/5.0', UPSTREAM + '?' + query], capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError('行情源连接失败。')
            return normalize(json.loads(result.stdout), symbol, year, end)
        except (ValueError, RuntimeError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def collect_security(security, end, downloader=download_year):
    start = max(date(2021, 1, 1), date.fromisoformat(security['start']))
    rows = []
    for year in range(start.year, date.fromisoformat(end).year + 1):
        rows.extend(downloader(security['symbol'], year, end))
        time.sleep(6)
    rows = [r for r in rows if security['start'] <= r['date'] <= end]
    if not rows:
        raise ValueError('股票池标的无可发布历史数据。')
    if len({r['date'] for r in rows}) != len(rows):
        raise ValueError('跨年份行情重复。')
    return rows


class Supabase:
    def __init__(self, url, secret):
        if not url.startswith('https://') or not secret:
            raise ValueError('请设置 SUPABASE_URL 和 SUPABASE_SECRET_KEY。')
        self.url, self.secret = url.rstrip('/'), secret

    def rpc(self, name, params=None):
        headers = {'apikey': self.secret, 'Content-Type': 'application/json'}
        if self.secret.startswith('eyJ'):
            headers['Authorization'] = 'Bearer ' + self.secret
        req = Request(self.url + '/rest/v1/rpc/' + name,
                      data=json.dumps(params or {}).encode(), headers=headers, method='POST')
        for attempt in range(3):
            try:
                with urlopen(req, timeout=90) as response:
                    body = response.read()
                    return json.loads(body) if body else None
            except HTTPError as error:
                # Do not log request headers or credentials. Validation errors
                # are not retryable; a timed-out publish is safe to repeat.
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise RuntimeError(f'Supabase {name} HTTP {error.code}') from None
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError(f'Supabase {name} 连接失败') from None
            time.sleep(2 ** attempt)


def run(pool, client, end, downloader=download_year):
    run_id = client.rpc('market_run_start')
    errors, succeeded = [], 0
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            futures = {executor.submit(collect_security, item, end, downloader): item for item in pool}
            for future in as_completed(futures):
                security = futures[future]
                try:
                    bars = future.result()
                    client.rpc('market_publish', {'p_security': security, 'p_bars': bars})
                    succeeded += 1
                    print(f"Published {security['symbol']}: {len(bars)} bars through {bars[-1]['date']}", flush=True)
                except Exception as error:
                    # Keep the previous complete dataset if any year failed.
                    errors.append({'symbol': security['symbol'], 'error': str(error)[:300]})
                    print(f"Failed {security['symbol']}: {error}", flush=True)
    finally:
        client.rpc('market_run_finish', {'p_id': run_id, 'p_succeeded': succeeded, 'p_errors': errors})
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool', type=Path, default=POOL)
    parser.add_argument('--export', type=Path, help='Fetch and validate into a JSON file without publishing.')
    args = parser.parse_args()
    parser.error('请使用 Supabase Cron / collect-market 共享限速队列；旧本地下载入口已停用。')
    pool = load_pool(args.pool)
    now = datetime.now(TZ)
    end = (now.date() if now.hour >= 16 else now.date() - timedelta(days=1)).isoformat()
    if args.export:
        with ThreadPoolExecutor(max_workers=1) as executor:
            snapshots = list(executor.map(lambda item: {'security': item, 'bars': collect_security(item, end)}, pool))
        args.export.parent.mkdir(parents=True, exist_ok=True)
        args.export.write_text(json.dumps(snapshots, ensure_ascii=False), encoding='utf-8')
        return
    client = Supabase(os.environ.get('SUPABASE_URL', ''), os.environ.get('SUPABASE_SECRET_KEY', ''))
    errors = run(pool, client, end)
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()

