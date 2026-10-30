"""Fetch a verified one-time exchange catalogue; never downloads price history.

Only public SSE/SZSE/BSE listing endpoints are used, one request at a time.
Successful source pages are checkpointed. Restrictions stop the run immediately.
"""
import argparse
from datetime import date,datetime,timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from zipfile import ZipFile
import xml.etree.ElementTree as ET

SSE='https://query.sse.com.cn/sseQuery/commonQuery.do'
SZSE='https://www.szse.cn/api/report/ShowReport'
BSE='https://www.bse.cn/nqxxController/nqxxCnzq.do'
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def listing(code,name,listed,exchange):
    code=str(code).strip();listed=str(listed).strip()
    if re.fullmatch(r'\d{8}',listed):listed=f'{listed[:4]}-{listed[4:6]}-{listed[6:]}'
    if not re.fullmatch({'sh':r'6\d{5}','sz':r'[03]\d{5}','bj':r'(?:[48]\d{5}|92\d{4})'}[exchange],code):
        raise ValueError('Invalid exchange stock identity')
    if not isinstance(name,str) or not name.strip() or date.fromisoformat(listed)<date(1990,1,1):
        raise ValueError('Missing listing name/date')
    return {'symbol':exchange+code,'name':name.strip(),'listed':listed,'start':max('2021-01-01',listed),'exchange':exchange}

def parse_sse(body):
    data=json.loads(body);rows=data.get('result');total=data.get('pageHelp',{}).get('total')
    if not isinstance(rows,list) or len(rows)!=total or not rows:raise ValueError('Incomplete SSE catalogue')
    return [listing(r['A_STOCK_CODE'],r['SEC_NAME_CN'],r['LIST_DATE'],'sh') for r in rows if not r['A_STOCK_CODE'].startswith('689')]

def parse_szse(body):
    with ZipFile(BytesIO(body)) as archive:
        # Guard malformed/unexpected downloads before XML expansion.
        if sum(f.file_size for f in archive.infolist())>40_000_000:raise ValueError('Oversized XLSX')
        strings=[]
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings=[''.join(s.itertext()) for s in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        root=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    rows=[]
    for row in root.findall('.//m:sheetData/m:row',NS):
        cells={}
        for c in row.findall('m:c',NS):
            col=re.sub(r'\d','',c.attrib['r']);kind=c.attrib.get('t')
            value=''.join(c.find('m:is',NS).itertext()) if kind=='inlineStr' else c.findtext('m:v','',NS)
            if kind=='s':value=strings[int(value)]
            cells[col]=value
        rows.append(cells)
    if not rows:raise ValueError('Empty SZSE catalogue')
    header=rows.pop(0);columns={v.replace(' ',''):k for k,v in header.items()}
    keys=[columns[k] for k in ['A股代码','A股简称','A股上市日期']]
    result=[]
    for row in rows:
        code=row.get(keys[0],'')
        if not code:continue  # B-only companies may be included in the workbook.
        result.append(listing(code,row[keys[1]],row[keys[2]],'sz'))
    if len(result)<2000:raise ValueError('Incomplete SZSE catalogue')
    return result

def parse_bse(body,page):
    text=body.decode('utf-8');match=re.fullmatch(r'\s*(?:null|[A-Za-z_$][\w$]*)\((\[.*\])\);?\s*',text,re.S)
    if not match:raise ValueError('Unexpected BSE response')
    data=json.loads(match[1])[0];total=data['totalElements'];size=data['size'];pages=data['totalPages'];rows=data['content']
    if not all(isinstance(n,int) for n in [total,size,pages]) or not 100<=total<=2000 or not 1<=size<=100 or pages!=(total+size-1)//size:
        raise ValueError('Invalid BSE pagination')
    if data['number']!=page or len(rows)!=min(size,total-page*size) or len(rows)!=data['numberOfElements']:
        raise ValueError('Incomplete BSE page')
    return [listing(r['xxzqdm'],r['xxzqjc'],r['fxssrq'],'bj') for r in rows],total,pages

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--cutoff',default='2026-10-28')
    parser.add_argument('--cached-bse-only',action='store_true',help='Export verified mainland lists and cached BSE pages without retrying a failed BSE page')
    args=parser.parse_args();date.fromisoformat(args.cutoff)
    args.cache.mkdir(parents=True,exist_ok=True)
    manifest=[];last_request=0
    def fetch(key,url,params=None,post=False,referer=None):
        nonlocal last_request
        path=args.cache/(key+'.bin')
        if path.exists():body=path.read_bytes()
        else:
            delay=7-(time.monotonic()-last_request)
            if delay>0:time.sleep(delay)
            query=urlencode(params or {});full=url if post else url+'?'+query
            headers={'User-Agent':'Mozilla/5.0'}
            if referer:headers['Referer']=referer
            req=Request(full,data=query.encode() if post else None,headers=headers)
            last_request=time.monotonic()
            try:
                with urlopen(req,timeout=25) as response:body=response.read(8_000_001)
            except HTTPError as e:
                if e.code in (403,429):raise RuntimeError('Source restricted: stop, wait at least 24 hours; do not bypass') from None
                raise
            if len(body)>8_000_000:raise ValueError('Oversized source response')
            path.write_bytes(body)
        manifest.append({'key':key,'url':url,'sha256':sha256(body).hexdigest(),'bytes':len(body),'fetchedAt':datetime.fromtimestamp(path.stat().st_mtime,timezone.utc).isoformat()})
        return body
    stocks=[]
    for board,key in [('1','sse-main'),('8','sse-star')]:
        body=fetch(key,SSE,{'STOCK_TYPE':board,'REG_PROVINCE':'','CSRC_CODE':'','STOCK_CODE':'','sqlId':'COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L','COMPANY_STATUS':'2,4,5,7,8','type':'inParams','isPagination':'true','pageHelp.cacheSize':'1','pageHelp.beginPage':'1','pageHelp.pageSize':'10000','pageHelp.pageNo':'1','pageHelp.endPage':'1'},referer='https://www.sse.com.cn/assortment/stock/list/share/')
        rows=parse_sse(body);stocks.extend(rows);print(json.dumps({'checkpoint':key,'stocks':len(rows)}),flush=True)
    stocks.extend(parse_szse(fetch('szse',SZSE,{'SHOWTYPE':'xlsx','CATALOGID':'1110','TABKEY':'tab1'})))
    page=0;pages=1;expected=None;bse=[]
    while page<pages:
        if args.cached_bse_only and not (args.cache/('bse-'+str(page)+'.bin')).exists():break
        rows,total,pages=parse_bse(fetch('bse-'+str(page),BSE,{'page':str(page),'typejb':'T','xxfcbj[]':'2','xxzqdm':'','sortfield':'xxzqdm','sorttype':'asc'},post=True),page)
        if expected is not None and expected!=total:raise ValueError('BSE universe changed during pagination')
        expected=total;bse.extend(rows);page+=1
        print(json.dumps({'checkpoint':'bse','page':page,'pages':pages,'stocks':len(bse)}),flush=True)
    complete=len(bse)==expected
    if not complete and not args.cached_bse_only:raise ValueError('Incomplete BSE catalogue')
    stocks.extend(bse)
    if len({s['symbol'] for s in stocks})!=len(stocks):raise ValueError('Duplicate stock across source pages')
    if not 4500<=len(stocks)<=12000:raise ValueError('Incomplete all-market catalogue')
    excluded=[s for s in stocks if s['listed']>args.cutoff]
    stocks=sorted([s for s in stocks if s['listed']<=args.cutoff],key=lambda s:s['symbol'])
    counts={e:sum(s['exchange']==e for s in stocks) for e in ['sh','sz','bj']}
    payload={'stocks':stocks,'manifest':{'source':'official_exchanges','snapshotAt':datetime.now(timezone.utc).isoformat(),'cutoff':args.cutoff,'total':len(stocks),'expectedTotal':counts['sh']+counts['sz']+expected,'counts':counts,'bse':{'reportedTotal':expected,'totalPages':pages,'nextPage':page,'complete':complete,'excludedAfterCutoff':sum(s['exchange']=='bj' for s in excluded)},'excludedAfterCutoff':excluded,'files':manifest}}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'validated':True,'total':len(stocks),'counts':counts,'excludedAfterCutoff':len(excluded),'output':str(args.output)}),flush=True)

if __name__=='__main__':main()
