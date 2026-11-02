"""WEB-C F1/F2: real editor -> default downloaded JSON, then parsed URL controls.
Use task-owned Vite on 127.0.0.1:43215; synthetic values and disposable Chrome only.
uv run --offline --no-project --with playwright python web/tests/web-c-export-url-browser.py
"""
import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ORIGIN = 'http://127.0.0.1:43215'
OUT = Path(__file__).resolve().parents[2] / '.local-tools/web-c-f2-evidence/browser'
REPORT = {'checks': [], 'external_requests': [], 'page_errors': [], 'failure': None}
PASSWORD = 'synthetic-f1-ui-password'
QUERY = 'synthetic-f2-ui-query'


def check(name, condition):
    assert condition, name
    REPORT['checks'].append(name)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
        ctx = await browser.new_context(service_workers='block', accept_downloads=True)
        async def route(r):
            if r.request.url.startswith(ORIGIN + '/'):
                return await r.continue_()
            REPORT['external_requests'].append(r.request.url)
            await r.abort('blockedbyclient')
        await ctx.route('**/*', route)
        await ctx.route_web_socket('**/*', lambda ws: ws.close())
        page = await ctx.new_page()
        page.on('pageerror', lambda error: REPORT['page_errors'].append(str(error)))
        downloads = []
        page.on('download', lambda download: downloads.append(download))
        try:
            await page.goto(ORIGIN + '/config', wait_until='networkidle')
            await page.get_by_role('tab', name='提示词来源', exact=True).click()
            addresses = [
                'https:' + chr(92) * 2 + f'alice:{PASSWORD}@feed.invalid/list.json',
                f'https://alice:{PASSWORD}@feed.invalid/list.json',
                f'https://feed.invalid/list.json?api\t_key={QUERY}',
                f'https://feed.invalid/list.json?%61pi\t_key={QUERY}',
                'https://feed.invalid/path@label/list.json?view=public#section',
            ]
            for index, address in enumerate(addresses):
                await page.get_by_role('button', name='新增来源', exact=True).click()
                drawer = page.get_by_role('dialog', name='新增提示词来源', exact=True)
                await drawer.get_by_placeholder('用于分类展示').fill(f'Synthetic F1 source {index}')
                await drawer.get_by_placeholder('https://example.com/prompts.json', exact=True).fill(address)
                await drawer.get_by_placeholder('https://example.com', exact=True).fill(address)
                await drawer.get_by_role('button', name=re.compile(r'^保\s*存$')).click()
                await drawer.wait_for(state='hidden')
                check(f'real editor accepted and saved source {index}', await drawer.is_hidden())
            # Read back only AFTER real UI intake; no fixture/store seeding establishes this reproduction.
            originals = await page.evaluate("async()=>{const s=await import('/src/stores/use-prompt-source-store.ts');return JSON.parse(JSON.stringify(s.usePromptSourceStore.getState().sources))}")
            created = [s for s in originals if s['name'].startswith('Synthetic F1 source ')]
            check('real editor preserved exact URL/homepage bytes including literal TAB and identities', len(created) == len(addresses) and [s['url'] for s in created] == addresses and [s['homepage'] for s in created] == addresses and len({s['id'] for s in created}) == len(addresses))
            check('browser parses both literal TAB query names as api_key', await page.evaluate('(addresses)=>addresses.slice(2,4).every(value=>[...new URL(value).searchParams.keys()][0]==="api_key")', addresses))
            before = await page.evaluate('JSON.stringify(localStorage)')
            async with page.expect_download() as event:
                await page.get_by_role('button', name='脱敏导出', exact=True).click()
            download = await event.value
            path = OUT / 'ui-created-safe-download.json'
            await download.save_as(path)
            raw = path.read_text()
            safe = json.loads(raw)
            check('actual default file contains no TAB-split query credential canary', QUERY not in raw)
            check('actual default file contains no structured URL password canary', PASSWORD not in raw)
            check('default download retains v1 app and filename without sensitive confirmation', safe['app'] == 'infinite-canvas' and safe['version'] == 1 and download.suggested_filename == 'infinite-canvas-config.json' and await page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文').count() == 0)
            for source in created:
                exported = next(s for s in safe['promptSources']['sources'] if s['id'] == source['id'])
                check(f"source identity/name retained {source['name']}", exported['name'] == source['name'])
                if source['url'] == addresses[-1]:
                    check('credential-free URL with @ path is preserved verbatim', exported['url'] == source['url'] and exported['homepage'] == source['homepage'])
                else:
                    check(f"credential-bearing URL/homepage omitted, not masked {source['name']}", 'url' not in exported and 'homepage' not in exported)
            check('default export never mutates original stored settings', await page.evaluate('JSON.stringify(localStorage)') == before)
            count = len(downloads)
            await page.get_by_role('button', name='完整敏感导出', exact=True).click()
            dialog = page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文')
            check('sensitive export still warns plaintext and sharing per invocation', '请勿分享' in await dialog.inner_text())
            await dialog.get_by_role('button', name=re.compile(r'^取\s*消$')).click()
            await dialog.wait_for(state='detached')
            check('cancelled sensitive action produces no file', len(downloads) == count)
            await page.get_by_role('button', name='完整敏感导出', exact=True).click()
            dialog = page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文')
            async with page.expect_download() as event:
                await dialog.get_by_role('button', name='确认本次明文导出', exact=True).click()
            path = OUT / 'confirmed-sensitive-download.json'
            await (await event.value).save_as(path)
            full = json.loads(path.read_text())
            check('separately confirmed sensitive file retains exact source values', all(next(s for s in full['promptSources']['sources'] if s['id'] == source['id']) == source for source in created))
            await dialog.wait_for(state='detached')
            await page.get_by_role('button', name='完整敏感导出', exact=True).click()
            dialog = page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文')
            check('next sensitive export requests confirmation again', await dialog.is_visible())
            await dialog.get_by_role('button', name=re.compile(r'^取\s*消$')).click()
            await dialog.wait_for(state='detached')
            # Service-boundary matrix is separate from the all-UI reproduction above.
            rows = await page.evaluate('''async () => {
                const c=await import('/src/stores/use-config-store.ts'),s=await import('/src/stores/use-prompt-source-store.ts'),f=await import('/src/services/config-file.ts');
                const forms=['https://alice:synthetic-f1-service-password@feed.invalid/list.json','https:'+String.fromCharCode(92,92)+'alice:synthetic-f1-service-password@feed.invalid/list.json','//alice:synthetic-f1-service-password@feed.invalid/list.json'];
                return forms.map(address=>{
                    c.useConfigStore.setState({config:{...structuredClone(c.defaultConfig),baseUrl:address,proxyUrl:address,channels:[{...structuredClone(c.defaultConfig.channels[0]),baseUrl:address}]},webdav:{...c.defaultWebdavSyncConfig,url:address}});
                    s.usePromptSourceStore.setState({sources:[{id:'exact-f1-service',name:'Service source',url:address,homepage:address,enabled:false,builtIn:false}]});
                    const safe=JSON.parse(JSON.stringify(f.createAppConfigExport()));
                    return {omitted:[[safe.config,'baseUrl'],[safe.config,'proxyUrl'],[safe.config.channels[0],'baseUrl'],[safe.webdav,'url'],[safe.promptSources.sources[0],'url'],[safe.promptSources.sources[0],'homepage']].every(([owner,key])=>!Object.hasOwn(owner,key)),canaryAbsent:!JSON.stringify(safe).includes('synthetic-f1-service-password'),channelId:safe.config.channels[0].id,sourceId:safe.promptSources.sources[0].id};
                });
            }''')
            for index, row in enumerate(rows):
                check(f'structural form {index}: all six URL slots omit credentials and retain identities', row == {'omitted': True, 'canaryAbsent': True, 'channelId': 'default', 'sourceId': 'exact-f1-service'})
            # Exercise all six slots in an ACTUAL download per parsed query form;
            # only prompt-source intake above is claimed as editor admission.
            for index, name in enumerate(['api\t_key', '%61pi\t_key']):
                address = f'https://feed.invalid/list.json?{name}={QUERY}'
                await page.evaluate('''async address => {
                    const c=await import('/src/stores/use-config-store.ts'),s=await import('/src/stores/use-prompt-source-store.ts');
                    c.useConfigStore.setState({config:{...structuredClone(c.defaultConfig),baseUrl:address,proxyUrl:address,channels:[{...structuredClone(c.defaultConfig.channels[0]),baseUrl:address}]},webdav:{...c.defaultWebdavSyncConfig,url:address}});
                    s.usePromptSourceStore.setState({sources:[{id:'exact-f2-service',name:'Service source',url:address,homepage:address,enabled:false,builtIn:false}]});
                }''', address)
                before = await page.evaluate('JSON.stringify(localStorage)')
                async with page.expect_download() as event:
                    await page.get_by_role('button', name='脱敏导出', exact=True).click()
                path = OUT / f'all-six-query-{index}-safe-download.json'
                await (await event.value).save_as(path)
                raw = path.read_text()
                safe = json.loads(raw)
                slots = [(safe['config'], 'baseUrl'), (safe['config'], 'proxyUrl'), (safe['config']['channels'][0], 'baseUrl'), (safe['webdav'], 'url'), (safe['promptSources']['sources'][0], 'url'), (safe['promptSources']['sources'][0], 'homepage')]
                check(f'parsed query form {index}: actual default download omits all six URL fields and canary without masks', all(field not in owner for owner, field in slots) and QUERY not in raw and '[REDACTED]' not in raw)
                check(f'parsed query form {index}: retains exact identities, original settings and no sensitive consent', safe['config']['channels'][0]['id'] == 'default' and safe['promptSources']['sources'][0]['id'] == 'exact-f2-service' and await page.evaluate('JSON.stringify(localStorage)') == before and await page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文').count() == 0)
            check('no external or companion requests', not REPORT['external_requests'])
            check('no unhandled page errors', not REPORT['page_errors'])
        finally:
            await ctx.close()
            await browser.close()


try:
    asyncio.run(main())
except Exception as error:
    REPORT['failure'] = str(error)
    raise
finally:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
    print(json.dumps(REPORT, ensure_ascii=False, indent=2))
