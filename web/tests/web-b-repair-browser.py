"""WEB-B F1/F2 regressions. Synthetic intercepted Chromium only; never uses port 3000.
Run: uv run --offline --no-project --with playwright python web/tests/web-b-repair-browser.py
"""
import asyncio
import base64
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen
from playwright.async_api import async_playwright

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('web_b', Path(__file__).with_name('web-b-browser.py'))
assert spec and spec.loader
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
ROOT, ORIGIN = h.ROOT, h.ORIGIN
OUT = ROOT / '.local-tools/web-b-repair-evidence'
REPORT: dict = {'checks': [], 'requests': [], 'page_errors': []}
KEY = 'synthetic_repair_bootstrap_only'


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    REPORT['checks'].append(name)


async def models(page):
    await page.get_by_role('button', name='选择模型', exact=True).click()
    dialog = page.get_by_role('dialog').filter(has=page.get_by_role('button', name='拉取模型列表', exact=True))
    await dialog.get_by_role('button', name='拉取模型列表', exact=True).click()
    await page.wait_for_timeout(350)
    await dialog.get_by_role('button', name=re.compile(r'^取\s*消$')).click()


async def binding(page):
    for original, destination in [
        ('https://bound.invalid/v1', 'https://changed.invalid/v1'),
        ('https://bound.invalid/v1', 'https://bound.invalid/other/v1'),
        ('https://bound.invalid/v1', 'https://bound.invalid'),
        ('https://bound.invalid', 'https://bound.invalid/v1'),
        ('https://bound.invalid/v1', 'https://bound.invalid/v1/'),
    ]:
        await page.goto(ORIGIN + '/?' + urlencode({'baseUrl': original, 'apiKey': KEY}), wait_until='networkidle')
        await page.evaluate("async () => {window.q={c:await import('/src/stores/use-config-store.ts')}}")
        await page.get_by_role('button', name='编辑', exact=True).last.click()
        before = len(REPORT['requests'])
        await models(page)
        sent = [r for r in REPORT['requests'][before:] if urlsplit(r['url']).hostname == 'bound.invalid' and r['method'] != 'OPTIONS']
        check('unchanged endpoint sends the bound key: ' + original + ' -> ' + destination, len(sent) == 1 and sent[0]['headers'].get('authorization') == 'Bearer ' + KEY)
        await page.locator('input[placeholder="https://api.example.com"]').fill(destination)
        before = len(REPORT['requests'])
        await models(page)
        sent = [r for r in REPORT['requests'][before:] if r['external']]
        check('unsaved endpoint edit has zero transport: ' + original + ' -> ' + destination, not sent)
        check('draft did not change stored recipient', await page.evaluate('q.c.useConfigStore.getState().config.channels.at(-1).baseUrl') == original)
        await page.get_by_role('button', name=re.compile(r'^保\s*存$')).last.click()
        check('save clears the old bound key', await page.evaluate('q.c.useConfigStore.getState().config.channels.at(-1).apiKey') == '')
        await page.get_by_role('button', name='编辑', exact=True).last.click()
        before = len(REPORT['requests'])
        await models(page)
        check('saved endpoint edit has zero transport: ' + destination, not [r for r in REPORT['requests'][before:] if r['external']])
        check('synthetic key never persists and URL is scrubbed', KEY not in await page.evaluate('JSON.stringify(localStorage)') and KEY not in page.url)


async def picker(page):
    cover = 'https://images.invalid/picker-synthetic.png'
    local = 'data:image/png;base64,' + base64.b64encode(h.PNG).decode()
    await page.goto(ORIGIN + '/image', wait_until='networkidle')
    await page.evaluate(h.MODULES)
    await page.evaluate('''([cover,local]) => {
        q.p.usePromptSourceStore.setState({sources:[]});
        const add=q.assets.useAssetStore.getState().addAsset;
        add({kind:'text',title:'Synthetic saved prompt',coverUrl:cover,tags:[],data:{content:'Synthetic prompt'},metadata:{source:'prompt-library'}});
        add({kind:'image',title:'Synthetic local image',coverUrl:'',tags:[],data:{dataUrl:local,width:1,height:1,bytes:0,mimeType:'image/png'}});
    }''', [cover, local])
    await page.wait_for_timeout(400)
    await page.reload(wait_until='networkidle')
    await page.evaluate(h.MODULES)
    await page.wait_for_function('q.assets.useAssetStore.getState().assets.length >= 2')
    await page.evaluate('q.p.usePromptSourceStore.setState({sources:q.p.usePromptSourceStore.getState().sources.map(s=>({...s,enabled:false}))})')
    before = len(REPORT['requests'])
    await page.get_by_role('button', name='查看我的资产', exact=True).click()
    dialog = page.get_by_role('dialog', name='选择资产', exact=True)
    await dialog.wait_for()
    await page.wait_for_timeout(400)
    check('picker default-off after reload has zero external requests', not [r for r in REPORT['requests'][before:] if r['external']])
    check('ordinary local image still renders', await dialog.get_by_role('img', name='Synthetic local image', exact=True).evaluate('(img)=>img.complete && img.naturalWidth > 0'))
    check('prompt cover absent without consent', await dialog.get_by_role('img', name='Synthetic saved prompt', exact=True).count() == 0)
    await page.evaluate("q.b.useBackgroundStore.getState().setConsent('promptFeed',true)")
    await page.wait_for_timeout(400)
    check('picker reacts to explicit image opt-in and requests only mocked cover', [r['url'] for r in REPORT['requests'][before:] if r['external']] == [cover])
    check('consented prompt image renders', await dialog.get_by_role('img', name='Synthetic saved prompt', exact=True).evaluate('(img)=>img.complete && img.naturalWidth > 0'))
    await page.evaluate("q.b.useBackgroundStore.getState().setConsent('promptFeed',false)")
    await page.wait_for_timeout(200)
    check('picker immediately removes prompt image on opt-out', await dialog.get_by_role('img', name='Synthetic saved prompt', exact=True).count() == 0)
    before = len(REPORT['requests'])
    await page.evaluate("const a=q.assets.useAssetStore.getState();a.updateAsset(a.assets.find(a=>a.metadata?.source==='prompt-library').id,{coverUrl:'https://images.invalid/picker-after-optout.png'})")
    await page.wait_for_timeout(300)
    check('cover change after opt-out cannot request another remote image', not [r for r in REPORT['requests'][before:] if r['external']])
    check('local preview survives opt-out', await dialog.get_by_role('img', name='Synthetic local image', exact=True).is_visible())


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
        try:
            ctx = await browser.new_context(service_workers='block', viewport={'width': 1440, 'height': 1000}, locale='zh-CN')
            async def route(r):
                req = r.request
                u = urlsplit(req.url)
                external = not req.url.startswith(ORIGIN + '/')
                REPORT['requests'].append({'url': req.url, 'method': req.method, 'headers': await req.all_headers(), 'external': external})
                if req.url == ORIGIN + '/config.js':
                    return await r.fulfill(content_type='application/javascript', body='window.__RUNTIME_CONFIG__={}')
                if not external:
                    return await r.continue_()
                cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS'}
                if u.hostname == 'images.invalid':
                    return await r.fulfill(headers=cors, content_type='image/png', body=h.PNG)
                if u.hostname in ['bound.invalid', 'changed.invalid']:
                    if req.method == 'OPTIONS':
                        return await r.fulfill(status=204, headers=cors)
                    return await r.fulfill(headers=cors, content_type='application/json', body='{"data":[{"id":"synthetic-model"}]}')
                return await r.abort('blockedbyclient')
            await ctx.route('**/*', route)
            await ctx.route_web_socket('**/*', lambda ws: ws.close())
            page = await ctx.new_page()
            page.on('pageerror', lambda error: REPORT['page_errors'].append(str(error)))
            await binding(page)
            await picker(page)
            check('no uncaught application errors', not REPORT['page_errors'])
            await ctx.close()
        finally:
            await browser.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', 43193)) == 0:
            raise RuntimeError('QA port occupied; refusing to use/stop it')
    env = {**os.environ, 'PATH': str(ROOT / '.local-tools/node-v22.23.4-darwin-arm64/bin') + os.pathsep + os.environ['PATH']}
    with (OUT / 'vite.log').open('w') as log:
        server = subprocess.Popen([str(ROOT / '.local-tools/bun-darwin-aarch64/bun'), str(ROOT / 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '43193', '--strictPort'], cwd=ROOT / 'web', env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError('Task-owned Vite exited')
                try:
                    with urlopen(ORIGIN, timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Vite not ready')
            asyncio.run(main())
        except Exception as error:
            REPORT['failure'] = str(error)
            raise
        finally:
            server.terminate()
            server.wait(timeout=15)
            (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
            print(json.dumps({'checks': len(REPORT['checks']), 'failure': REPORT.get('failure')}, ensure_ascii=False))
