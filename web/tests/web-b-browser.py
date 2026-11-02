"""WEB-B synthetic acceptance: uv run --no-project --with playwright python web/tests/web-b-browser.py.
Separate disposable Chrome, pinned task-local Vite, every external request mocked/aborted.
No live analytics/provider/companion account, user profile, or port-3000 process is used.
"""
import asyncio
import base64
import json
import os
import re
import socket
import subprocess
import time
from typing import Any
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-tools/web-b-evidence'
ORIGIN = 'http://127.0.0.1:43193'
CANARIES = ['synthetic_query_canary', 'synthetic_fragment_canary', 'synthetic_agent_canary', 'synthetic_title_canary']
REPORT: dict[str, Any] = {'checks': [], 'requests': [], 'console': [], 'page_errors': []}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII=')
SOURCE = {'id': 'synthetic-feed', 'name': 'Synthetic feed', 'url': 'https://feed.invalid/prompts.json', 'homepage': 'https://feed.invalid', 'enabled': True, 'builtIn': False}
PLUGIN = "window.__qaPluginRuns=(window.__qaPluginRuns||0)+1;export default {id:'synthetic-plugin',name:'Synthetic plugin',version:'0.0.0',nodes:[{type:'synthetic-plugin:node',title:'Synthetic node',defaultSize:{width:100,height:100},Component:()=>null}]}"
MOCK_PROVIDER = """(() => {
 let parentReadable = false; try { void parent.location.href; parentReadable = true; } catch {}
 const emit = () => fetch('https://collector.invalid/analytics', {method:'POST',body:JSON.stringify({href:location.href,referrer:document.referrer,title:document.title,parentReadable,dataLayer:window.dataLayer||[],hmt:window._hmt||[]})});
 emit(); setInterval(emit, 500);
})()"""
INIT = """(() => {
 const intervals = new Map(), originalSet = window.setInterval, originalClear = window.clearInterval;
 window.setInterval = (fn, ms, ...args) => {const id=originalSet(fn, ms, ...args); if(ms===60000) intervals.set(id,()=>fn(...args)); return id;};
 window.clearInterval = id => {intervals.delete(id);originalClear(id)};
 window.__tick = () => {for(const fn of [...intervals.values()]) fn()};
 window.__intervalCount = () => intervals.size;
 let offset=0;const now=Date.now;Date.now=()=>now()+offset;window.__advance=()=>offset+=7200000;
 window.__scrubs=[];const replace=history.replaceState;history.replaceState=function(state,title,url){window.__scrubs.push(String(url));return replace.call(this,state,title,url)};
})()"""
MODULES = """async () => {
 window.q = {b:await import('/src/stores/use-background-store.ts'),c:await import('/src/stores/use-config-store.ts'),p:await import('/src/stores/use-prompt-source-store.ts'),f:await import('/src/services/config-file.ts'),a:await import('/src/lib/analytics.ts'),r:await import('/src/router.tsx'),assets:await import('/src/stores/use-asset-store.ts'),canvas:await import('/src/stores/canvas/use-canvas-store.ts')};
 q.c.useConfigStore.getState().setConfigDialogOpen(false);
}"""


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    REPORT['checks'].append(name)


def nonessential(start=0):
    return [r for r in REPORT['requests'][start:] if r['kind'] != 'resource']


async def exercise(browser, force_off=False):
    ctx = await browser.new_context(service_workers='block', viewport={'width': 1440, 'height': 1000})
    await ctx.add_init_script(INIT)
    async def route(r):
        req = r.request
        u = urlsplit(req.url)
        headers = await req.all_headers()
        kind = 'resource'
        if u.hostname == 'feed.invalid': kind = 'feed'
        elif u.hostname == 'images.invalid': kind = 'image'
        elif u.hostname in ['www.googletagmanager.com', 'hm.baidu.com']: kind = 'provider'
        elif u.hostname == 'collector.invalid': kind = 'collector'
        elif u.hostname == 'raw.githubusercontent.com' and u.path.endswith(('/VERSION', '/CHANGELOG.md')): kind = 'version'
        elif u.hostname == 'navigation.invalid': kind = 'navigation'
        elif u.hostname == 'plugins.invalid' or (req.url.startswith(ORIGIN + '/') and u.path.startswith('/plugins/')): kind = 'plugin-manager'
        elif not req.url.startswith(ORIGIN + '/') or u.path.startswith('/plugins/'): kind = 'unexpected'
        record = {'url': req.url, 'headers': headers, 'body': req.post_data, 'kind': kind, 'force_off': force_off}
        REPORT['requests'].append(record)
        if req.url == ORIGIN + '/config.js':
            config = {'ANALYTICS_GA4_ID': 'G-SYNTHETIC', 'ANALYTICS_BAIDU_ID': '0123456789abcdef0123456789abcdef', 'DISABLE_ANALYTICS': str(force_off).lower(), 'DISABLE_VERSION_CHECK': str(force_off).lower(), 'DISABLE_PROMPT_FEED': str(force_off).lower(), 'ENABLE_ANALYTICS': 'true'}
            return await r.fulfill(content_type='application/javascript', body='window.__earlyConfigLocation=location.href;window.__RUNTIME_CONFIG__=' + json.dumps(config))
        if kind == 'resource': return await r.continue_()
        cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS'}
        if req.method == 'OPTIONS': return await r.fulfill(status=204, headers=cors)
        if kind == 'feed': return await r.fulfill(headers=cors, content_type='application/json', body=json.dumps([{'id': 'synthetic', 'title': 'Synthetic prompt', 'prompt': 'Synthetic generated text', 'coverUrl': 'https://images.invalid/cover.png', 'tags': []}]))
        if kind == 'image': return await r.fulfill(headers=cors, content_type='image/png', body=PNG)
        if kind == 'provider': return await r.fulfill(headers=cors, content_type='application/javascript', body=MOCK_PROVIDER)
        if kind == 'collector': return await r.fulfill(headers=cors, content_type='text/plain', body='ok')
        if kind == 'version': return await r.fulfill(headers=cors, content_type='text/plain', body='99.0.0' if u.path.endswith('/VERSION') else '# CHANGELOG\n\n## v99.0.0\n\n+ [修复] Synthetic mock release\n')
        if kind == 'navigation': return await r.fulfill(content_type='text/html', body='<title>Local mocked navigation</title>')
        if kind == 'plugin-manager':
            if u.path == '/catalog.json': return await r.fulfill(headers=cors, content_type='application/json', body='{"plugins":[{"id":"synthetic-official","name":"Synthetic official","version":"0.0.0","entry":"https://plugins.invalid/official.js"}]}')
            if u.path == '/plugins/index.json': return await r.fulfill(content_type='application/json', body='["/plugins/synthetic.js"]')
            return await r.fulfill(headers=cors, content_type='application/javascript', body=PLUGIN)
        return await r.abort('blockedbyclient')
    await ctx.route('**/*', route)
    await ctx.route_web_socket('**/*', lambda ws: ws.close())
    page = await ctx.new_page()
    page.on('console', lambda m: REPORT['console'].append({'type': m.type, 'text': m.text}))
    page.on('pageerror', lambda e: REPORT['page_errors'].append(str(e)))
    start = len(REPORT['requests'])
    with urlopen(ORIGIN + '/', timeout=2) as response:
        html = response.read().decode()
    bootstrap_end = html.index('<!-- url-bootstrap:end -->')
    check('served bootstrap precedes every injected resource/script', all(match.start() > bootstrap_end for match in re.finditer(r'<(?:link\b|script\b[^>]*\bsrc=|script\b[^>]*\btype="module")', html)))
    path = '/config' if force_off else '/?keep=functional&apiKey=' + CANARIES[0] + '&baseUrl=https%3A%2F%2Fprovider.invalid%2Fv1#agentToken=' + CANARIES[2] + '&tab=retained'
    await page.goto(ORIGIN + path, wait_until='networkidle')
    await page.evaluate(MODULES)
    await page.wait_for_timeout(400)
    check(('force-off' if force_off else 'default') + ' startup performs zero nonessential requests', not nonessential(start))
    if not force_off:
        state = await page.evaluate('({url:location.href,early:window.__earlyConfigLocation,scrubs:window.__scrubs,bootstrap:!!window.__IC_BOOTSTRAP__,storage:JSON.stringify(localStorage)})')
        check('synchronous scrub precedes runtime config and preserves unrelated state', state['early'] == ORIGIN + '/?keep=functional#tab=retained' and state['url'] == state['early'] and bool(state['scrubs']))
        check('bootstrap memory consumed and synthetic key absent from browser persistence', not state['bootstrap'] and CANARIES[0] not in state['storage'])
        # Separate fragment-key initial navigation, without merging query/fragment recipient choices.
        await page.goto(ORIGIN + '/?keep=functional#baseUrl=https%3A%2F%2Fprovider.invalid%2Fv1&apiKey=' + CANARIES[1] + '&tab=retained', wait_until='networkidle')
        await page.evaluate(MODULES)
        check('fragment credentials scrub before runtime config and never persist', await page.evaluate('window.__earlyConfigLocation') == ORIGIN + '/?keep=functional#tab=retained' and CANARIES[1] not in await page.evaluate('JSON.stringify(localStorage)'))
    # Real file import of legacy settings/flags must not grant consent.
    await page.evaluate('''async source => {
      const current=q.c.useConfigStore.getState();const data={app:'infinite-canvas',version:1,exportedAt:new Date().toISOString(),config:{...current.config,analyticsEnabled:true,versionCheckEnabled:true},webdav:current.webdav,promptSources:{sources:[...q.p.usePromptSourceStore.getState().sources.filter(s=>s.builtIn).map(s=>({...s,enabled:false})),source],schedule:{intervalMinutes:30,lastFetchedAt:''},consent:{analytics:true,version:true,promptFeed:true}}};
      await q.f.importAppConfig(new File([JSON.stringify(data)],'synthetic-legacy.json',{type:'application/json'}),async()=>true);
    }''', SOURCE)
    await page.evaluate('window.__tick();window.__advance();window.__tick()')
    await page.wait_for_timeout(400)
    check(('force-off' if force_off else 'default') + ' legacy import and immediate/later ticks have zero nonessential traffic', not nonessential(start))
    await page.evaluate("q.r.router.navigate('/config')")
    await page.get_by_role('tab', name=re.compile('偏好|Preferences', re.I)).click()
    labels = ['匿名页面统计', '自动检查版本', '自动刷新提示词源并加载图片']
    if force_off:
        for label in labels: check(label + ' disabled by deployment', await page.get_by_role('switch', name=label, exact=True).is_disabled())
        await page.evaluate("for(const k of ['analytics','version','promptFeed']) q.b.useBackgroundStore.getState().setConsent(k,true);window.__tick()")
        check('force-off rejects attempted explicit opt-in', await page.evaluate("Object.values(q.b.useBackgroundStore.getState().consent).every(v=>!v)"))
        await page.wait_for_timeout(700)
        check('force-off never schedules provider/version/feed traffic', not nonessential(start))
        await ctx.close()
        return
    # Exercise actual route-mounted code, including plugin host, with default-off state.
    for path in ['/', '/prompts', '/assets', '/image', '/video']:
        await page.evaluate('path=>q.r.router.navigate(path)', path)
        await page.wait_for_timeout(150)
    await page.evaluate("q.id=q.canvas.useCanvasStore.getState().createProject('synthetic_title_canary');q.r.router.navigate('/canvas/'+q.id)")
    await page.wait_for_timeout(700)
    check('default route mounts including canvas plugin host produce zero nonessential traffic', not nonessential(start))
    await page.reload(wait_until='networkidle')
    await page.evaluate(MODULES)
    await page.evaluate('window.__advance();window.__tick()')
    await page.wait_for_timeout(300)
    check('reload of legacy state cannot restore background consent', not nonessential(start) and await page.evaluate("Object.values(q.b.useBackgroundStore.getState().consent).every(v=>!v)"))
    # Manual prompt control shows destination; importing flags never authorizes its images.
    await page.evaluate("q.r.router.navigate('/config')")
    await page.get_by_role('tab', name=re.compile('提示词来源|Prompt sources', re.I)).click()
    check('manual feed destination is visible', await page.get_by_text('手动刷新目标：https://feed.invalid/prompts.json', exact=True).is_visible())
    await page.get_by_role('button', name=re.compile('全部立即拉取|Fetch all now', re.I)).click()
    await page.wait_for_timeout(600)
    check('manual feed fetch works without automatic consent and without images', [r['kind'] for r in nonessential(start)] == ['feed'])
    await page.evaluate("q.assets.useAssetStore.getState().addAsset({kind:'text',title:'Synthetic prompt',coverUrl:'https://images.invalid/copied.png',tags:[],data:{content:'Synthetic'},metadata:{source:'prompt-library'}});q.r.router.navigate('/assets')")
    await page.wait_for_timeout(500)
    check('copied prompt asset cover remains blocked without feed consent', not [r for r in nonessential(start) if r['kind'] == 'image'])
    # Manual version dialog is local-only until its labelled control is clicked.
    before = len(REPORT['requests'])
    await page.get_by_title(re.compile('查看版本更新|View updates', re.I)).first.click()
    await page.wait_for_timeout(300)
    check('opening release history is local-only', not nonessential(before))
    check('manual version destination is visible', await page.get_by_text(re.compile('默认仅显示本地更新记录')).is_visible())
    await page.get_by_role('button', name=re.compile('检查更新|Check.*updates', re.I)).click()
    await page.wait_for_timeout(500)
    check('manual version control requests only VERSION and CHANGELOG', len([r for r in nonessential(before) if r['kind'] == 'version']) == 2)
    await page.get_by_role('button', name='Close', exact=True).last.click()
    await page.evaluate("q.r.router.navigate('/config')")
    await page.get_by_role('tab', name=re.compile('偏好|Preferences', re.I)).click()
    before = len(REPORT['requests'])
    await page.get_by_role('switch', name=labels[0], exact=True).click()
    await page.wait_for_timeout(1000)
    check('analytics opt-in loads only provider mocks/collector', bool(nonessential(before)) and all(r['kind'] in ['provider', 'collector'] for r in nonessential(before)))
    frames = [f for f in page.frames if f.url.endswith('/analytics-frame.html')]
    check('analytics uses exactly one disposable isolated frame', len(frames) == 1)
    await page.evaluate("document.title='synthetic_title_canary';q.a.trackPageview('/canvas/synthetic_title_canary?keep=functional#tab=retained')")
    await page.wait_for_timeout(650)
    payloads = [json.loads(r['body']) for r in nonessential(before) if r['kind'] == 'collector' and r['body']]
    check('provider mocks cannot read parent or referrer and see only static frame title', bool(payloads) and all(not p['parentReadable'] and not p['referrer'] and p['title'] == 'Infinite Canvas' for p in payloads))
    check('emitted queues contain static route template and safe GA defaults', '/canvas/:id' in json.dumps(payloads) and 'send_page_view' in json.dumps(payloads) and all(x not in json.dumps(payloads) for x in CANARIES + ['keep=functional', 'tab=retained']))
    REPORT['provider_payloads'] = payloads
    await page.get_by_role('switch', name=labels[0], exact=True).click()
    await page.wait_for_timeout(600)
    before = len(REPORT['requests'])
    await page.wait_for_timeout(1100)
    check('analytics opt-out destroys provider context and future timers', not nonessential(before) and not [f for f in page.frames if f.url.endswith('/analytics-frame.html')])
    await page.get_by_role('switch', name=labels[1], exact=True).click()
    await page.wait_for_timeout(500)
    check('version opt-in is separate from feed/analytics', bool(nonessential(before)) and all(r['kind'] == 'version' for r in nonessential(before)))
    await page.get_by_role('switch', name=labels[1], exact=True).click()
    await page.evaluate('window.__advance()')
    before = len(REPORT['requests'])
    await page.get_by_role('switch', name=labels[2], exact=True).click()
    await page.wait_for_timeout(600)
    check('feed opt-in starts immediate due refresh', any(r['kind'] == 'feed' for r in nonessential(before)) and await page.evaluate('window.__intervalCount()') > 0)
    await page.evaluate("q.r.router.navigate('/')")
    await page.wait_for_timeout(500)
    check('feed opt-in permits prompt images', any(r['kind'] == 'image' for r in nonessential(before)))
    before = len(REPORT['requests'])
    await page.evaluate('window.__advance();window.__tick()')
    await page.wait_for_timeout(500)
    check('later timer tick refreshes only after explicit feed opt-in', any(r['kind'] == 'feed' for r in nonessential(before)))
    await page.evaluate("q.r.router.navigate('/config')")
    await page.get_by_role('tab', name=re.compile('偏好|Preferences', re.I)).click()
    await page.get_by_role('switch', name=labels[2], exact=True).click()
    await page.wait_for_timeout(400)
    before = len(REPORT['requests'])
    await page.evaluate('window.__advance();window.__tick()')
    await page.wait_for_timeout(600)
    check('feed opt-out clears scheduler and fences later requests', not nonessential(before) and await page.evaluate('window.__intervalCount()') == 0)
    await page.reload(wait_until='networkidle')
    await page.wait_for_timeout(400)
    check('reload after explicit opt-ins returns to default-off', not nonessential(before))
    await page.evaluate(MODULES)
    await page.evaluate("q.r.router.navigate('/canvas/'+q.canvas.useCanvasStore.getState().createProject('Synthetic plugin QA'))")
    await page.wait_for_timeout(400)
    before = len(REPORT['requests'])
    await page.get_by_role('button', name=re.compile('节点插件|Node plugins', re.I), exact=True).click()
    dialog = page.get_by_role('dialog')
    await page.wait_for_timeout(400)
    check('opening plugin manager alone cannot load catalogs or execute source', not nonessential(before) and not await page.evaluate('window.__qaPluginRuns'))
    check('manual plugin catalog destination is visible', await dialog.get_by_text(re.compile('https://plugins.invalid/catalog.json')).is_visible())
    check('manual development plugin destination is visible before load', await dialog.get_by_text(re.compile('https://plugins.invalid/dev.js')).is_visible())
    await dialog.get_by_role('button', name=re.compile('^刷新$|^Refresh$', re.I)).click()
    await page.wait_for_timeout(300)
    check('explicit catalog refresh fetches only the disclosed mock manifest', [r['url'] for r in nonessential(before)] == ['https://plugins.invalid/catalog.json'])
    check('official install destination is visible before installation', await dialog.get_by_text('https://plugins.invalid/official.js', exact=True).is_visible())
    before = len(REPORT['requests'])
    await dialog.get_by_role('button', name=re.compile('下载并发现插件')).click()
    await page.wait_for_timeout(600)
    check('explicit manager discovery downloads local/dev metadata without executing source', not await page.evaluate('window.__qaPluginRuns') and len(nonessential(before)) == 3 and all(r['kind'] == 'plugin-manager' for r in nonessential(before)))
    await page.evaluate("async source => {const {usePluginStore}=await import('/src/stores/canvas/use-plugin-store.ts');usePluginStore.getState().upsert({id:'synthetic-cached',name:'Synthetic cached',version:'0.0.0',url:'https://plugins.invalid/cached.js',source,enabled:true})}", PLUGIN)
    before = len(REPORT['requests'])
    await page.reload(wait_until='networkidle')
    await page.wait_for_timeout(400)
    check('legacy enabled plugin cache cannot authorize loading on reload', not nonessential(before) and not await page.evaluate('window.__qaPluginRuns'))
    # Intentional navigation with a synthetic credential URL is intercepted locally; no Referer escapes.
    await page.goto(ORIGIN + '/?apiKey=' + CANARIES[0] + '&baseUrl=https%3A%2F%2Fprovider.invalid#tab=retained', wait_until='networkidle')
    await page.evaluate(MODULES)
    await page.wait_for_timeout(400)
    await page.evaluate("document.body.insertAdjacentHTML('beforeend','<a id=qa-navigation href=https://navigation.invalid/out>QA navigation</a>')")
    await page.locator('#qa-navigation').click()
    await page.wait_for_timeout(200)
    check('intentional outbound navigation has no referrer', all(not r['headers'].get('referer') for r in REPORT['requests'] if r['kind'] == 'navigation'))
    await ctx.close()


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
        try:
            await exercise(browser)
            await exercise(browser, True)
            check('no unmocked background/catalog/CDN/companion attempts', not [r for r in REPORT['requests'] if r['kind'] == 'unexpected'])
            # The initial navigation necessarily reaches the host with the query. Exclude only that document URL,
            # never resource headers, queues, emitted payloads, injected scripts, or outbound navigation.
            check('no secret canary in injected scripts, pageview payloads, or any request referrer', all(all(c not in unquote(json.dumps(r['headers'])) and c not in unquote(r['body'] or '') and (r['url'].startswith(ORIGIN + '/?') or c not in unquote(r['url'])) for c in CANARIES) for r in REPORT['requests']))
            check('browser has no uncaught application errors', not REPORT['page_errors'])
        finally:
            await browser.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', 43193)) == 0: raise RuntimeError('QA port already occupied; refusing to use/stop it')
    log = (OUT / 'vite.log').open('w')
    env = {**os.environ, 'PATH': str(ROOT / '.local-tools/node-v22.23.4-darwin-arm64/bin') + os.pathsep + os.environ['PATH'], 'VITE_DEV_PLUGINS': 'https://plugins.invalid/dev.js', 'VITE_PLUGIN_REGISTRY_URL': 'https://plugins.invalid/catalog.json'}
    server = subprocess.Popen([str(ROOT / '.local-tools/bun-darwin-aarch64/bun'), str(ROOT / 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '43193', '--strictPort'], cwd=ROOT / 'web', env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            if server.poll() is not None: raise RuntimeError('Task-owned Vite exited; see local evidence/vite.log')
            try:
                with urlopen(ORIGIN, timeout=1) as response:
                    if response.status == 200: break
            except OSError: time.sleep(.1)
        else: raise RuntimeError('Task-owned Vite did not become ready')
        asyncio.run(main())
    except Exception as error:
        REPORT['failure'] = str(error)
        raise
    finally:
        server.terminate()
        server.wait(timeout=15)
        log.close()
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        print(json.dumps({'checks': len(REPORT['checks']), 'nonessential_requests': len(nonessential()), 'failure': REPORT.get('failure')}, indent=2))
