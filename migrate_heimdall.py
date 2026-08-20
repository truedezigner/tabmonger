#!/usr/bin/env python3
"""Read a live Heimdall instance and import its complete active/trash inventory."""
from __future__ import annotations
import argparse, base64, json, mimetypes, urllib.request, http.cookiejar
from urllib.parse import urljoin
from bs4 import BeautifulSoup

def fetch(opener, url): return opener.open(url, timeout=20).read().decode('utf-8', 'replace')
def main():
    p=argparse.ArgumentParser();p.add_argument('heimdall',help='URL of the Heimdall instance, for example http://192.168.1.20:8080');p.add_argument('--target',default='http://127.0.0.1:8787');a=p.parse_args()
    base=a.heimdall.rstrip('/');cj=http.cookiejar.CookieJar();op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    home=BeautifulSoup(fetch(op,base),'html.parser');items_page=BeautifulSoup(fetch(op,base+'/items'),'html.parser')
    def image_data(src):
        if not src:return ''
        try:
            response=op.open(urljoin(base+'/',src),timeout=20);raw=response.read()
            mime=response.headers.get_content_type() or mimetypes.guess_type(src)[0] or 'image/png'
            return f'data:{mime};base64,'+base64.b64encode(raw).decode()
        except Exception as exc:
            print(f'Warning: could not copy image {src}: {exc}')
            return src
    order=[];pinned={}
    for link in home.select('#pinlist a[data-id]'):
        iid=link.get('data-id');order.append(iid);pinned[iid]='active' in (link.get('class') or [])
    ids=[]
    for link in items_page.select('a[href*="/items/"][href$="/edit"]'):
        iid=link['href'].split('/')[-2]
        if iid not in ids:ids.append(iid)
    imported=[]
    for iid in ids:
        s=BeautifulSoup(fetch(op,f'{base}/items/{iid}/edit'),'html.parser')
        def val(name,default=''):
            e=s.select_one(f'[name="{name}"]');return e.get('value',e.text) if e else default
        selected=[x.get_text(' ',strip=True) for x in s.select('select[name="tags[]"] option[selected]') if x.get('value')!='0']
        icon=s.select_one('#appimage img');src=icon.get('src','') if icon else ''
        imported.append({'id':'heimdall-'+iid,'title':val('title'), 'url':val('url') or val('website'),'description':val('appdescription'),'color':val('colour','#17211f'),'icon':image_data(src),'pinned':pinned.get(iid,False),'tags':selected,'_order':order.index(iid) if iid in order else len(order)+ids.index(iid)})
    trash=BeautifulSoup(fetch(op,base+'/items?trash=1'),'html.parser')
    for link in trash.select('a[href*="/items/restore/"]'):
        row=link.find_parent('tr');title=row.select_one('td').get_text(' ',strip=True);iid=link['href'].rstrip('/').split('/')[-1]
        imported.append({'id':'heimdall-trash-'+iid,'title':title,'url':'http://invalid.local/unknown-from-heimdall-trash','description':'Imported from Heimdall trash; Heimdall does not expose the deleted URL.','color':'#17211f','pinned':False,'deleted_at':'imported'})
    imported.sort(key=lambda x:x.pop('_order',99999))
    settings={}
    app=home.select_one('#app')
    if app and 'background-image' in app.get('style',''):
        raw=app.get('style','').split('url(',1)[1].split(')',1)[0].strip('"\' ')
        settings['background_image']=image_data(raw)
    payload=json.dumps({'data':{'format':'tabmonger-v1','items':imported,'settings':settings}}).encode()
    req=urllib.request.Request(a.target.rstrip('/')+'/api/import',data=payload,headers={'Content-Type':'application/json'})
    result=json.loads(urllib.request.urlopen(req,timeout=60).read())
    print(json.dumps({'active':len(ids),'trash':len(imported)-len(ids),**result},indent=2))
if __name__=='__main__':main()
