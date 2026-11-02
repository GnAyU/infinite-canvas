"""WEB-C config UI: disposable Chrome, synthetic secrets, no live network.
Start authorized Vite on 127.0.0.1:43215, then:
uv run --offline --no-project --with playwright python web/tests/web-c-config-ui-browser.py
"""
import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-tools/web-c-ui-evidence'
ORIGIN = 'http://127.0.0.1:43215'
KEY = 'synthetic_web_c_ui_key'
DAV = 'synthetic_web_c_ui_dav'
SCRIPT = "globalThis.__webCImportedSideEffect = true; return 'synthetic-web-c-ui-script'"
REPORT: dict = {'checks': [], 'external_requests': [], 'page_errors': []}


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
            await page.evaluate('''async ({key,dav,script}) => {
                window.q={c:await import('/src/stores/use-config-store.ts'), f:await import('/src/services/config-file.ts'), r:await import('/src/services/config-import.ts')};
                const s=q.c.useConfigStore.getState();
                s.updateConfig('channels',[{...s.config.channels[0],apiKey:key,models:s.config.channels[0].models.map((m,i)=>i?m:{...m,script})}]);
                s.updateWebdavConfig('url','https://dav.invalid/files');
                s.updateWebdavConfig('password',dav);
            }''', {'key': KEY, 'dav': DAV, 'script': SCRIPT})
            check('seeded store is the rendered application store', await page.get_by_role('button', name='记住到此浏览器（明文）', exact=True).count() >= 2)
            check('safe-export warning requires review of remaining user text', await page.get_by_text(re.compile('其他用户文本仍可能含秘密')).is_visible())
            async with page.expect_download() as event:
                await page.get_by_role('button', name='脱敏导出', exact=True).click()
            download = await event.value
            path = OUT / 'safe-config.json'
            await download.save_as(path)
            safe = json.loads(path.read_text())
            check('actual default file preserves v1 app and identity', safe['app'] == 'infinite-canvas' and safe['version'] == 1 and safe['config']['channels'][0]['id'] == 'default' and download.suggested_filename == 'infinite-canvas-config.json')
            check('actual default download omits credentials and executable source', all(value not in path.read_text() for value in [KEY, DAV, SCRIPT]) and 'apiKey' not in safe['config']['channels'][0] and 'script' not in safe['config']['channels'][0]['models'][0])
            before = len(downloads)
            await page.get_by_role('button', name='完整敏感导出', exact=True).click()
            dialog = page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文')
            check('separate sensitive-export confirmation warns about plaintext and sharing', await dialog.is_visible() and '请勿分享' in await dialog.inner_text())
            await dialog.get_by_role('button', name=re.compile(r'^取\s*消$')).click()
            await dialog.wait_for(state='detached')
            check('cancelled sensitive export produces no file', len(downloads) == before)
            await page.get_by_role('button', name='完整敏感导出', exact=True).click()
            dialog = page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文')
            async with page.expect_download() as event:
                await dialog.get_by_role('button', name='确认本次明文导出', exact=True).click()
            path = OUT / 'sensitive-config.json'
            await (await event.value).save_as(path)
            check('separately confirmed file contains synthetic values and script', all(value in json.loads(path.read_text())['config']['channels'][0].get('apiKey','') + path.read_text() for value in [KEY, DAV]) and json.loads(path.read_text())['config']['channels'][0]['models'][0]['script'] == SCRIPT)
            await page.get_by_role('button', name='完整敏感导出', exact=True).click()
            check('each sensitive export requests fresh confirmation', await page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文').is_visible())
            await page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文').get_by_role('button', name=re.compile(r'^取\s*消$')).click()
            await page.get_by_role('dialog').filter(has_text='完整敏感导出包含明文').wait_for(state='detached')
            original = await page.evaluate('JSON.stringify(localStorage)')
            await page.locator('main input[type=file]').set_input_files({'name':'synthetic-config.json','mimeType':'application/json','buffer':json.dumps(safe).encode()})
            dialog = page.get_by_role('dialog').filter(has_text='不是跨存储事务')
            await dialog.get_by_role('button', name=re.compile(r'^取\s*消$')).click()
            await dialog.wait_for(state='detached')
            check('cancelled import neither writes nor shows import success', await page.evaluate('JSON.stringify(localStorage)') == original and await page.get_by_text('配置与用户偏好已导入', exact=True).count() == 0)
            # Feed actual safe output with omitted required addresses through the real file input.
            missing = await page.evaluate('''() => {
                const s=q.c.useConfigStore.getState();
                s.updateConfig('channels',[s.config.channels[0], ...[1,2].map(n=>({...s.config.channels[0], id:'missing-'+n, baseUrl:'https://missing.invalid/'+n+'?token=synthetic_omitted_'+n}))]);
                window.__wcBeforeState=q.c.useConfigStore.getState();
                window.__wcBeforeData=JSON.stringify({config:__wcBeforeState.config,webdav:__wcBeforeState.webdav});
                window.__wcAdmissionWrites=[];
                const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
                window.__wcAdmissionRestore=()=>{Storage.prototype.setItem=set;Storage.prototype.removeItem=remove};
                Storage.prototype.setItem=function(k,v){__wcAdmissionWrites.push(k);return set.call(this,k,v)};
                Storage.prototype.removeItem=function(k){__wcAdmissionWrites.push(k);return remove.call(this,k)};
                return JSON.parse(JSON.stringify(q.f.createAppConfigExport()));
            }''')
            check('missing-address fixture is actual JSON omission, not null', 'baseUrl' not in missing['config']['channels'][1] and 'baseUrl' not in missing['config']['channels'][2])
            original = await page.evaluate('JSON.stringify(localStorage)')
            await page.locator('main input[type=file]').set_input_files({'name':'missing-addresses.json','mimeType':'application/json','buffer':json.dumps(missing).encode()})
            diagnostic = page.get_by_text(re.compile('缺少必填地址字段：'))
            await diagnostic.first.wait_for()
            text = await diagnostic.first.inner_text()
            check('actual file UI identifies every omitted channel field and actionable recovery', all(v in text for v in ['config.channels[1].baseUrl','config.channels[2].baseUrl','重新导出','手动重新配置']) and 'synthetic_omitted_' not in text)
            check('whole-file rejection and error UI perform zero writes or live mutation', await page.evaluate('__wcAdmissionWrites.length===0 && q.c.useConfigStore.getState()===__wcBeforeState') and await page.evaluate('JSON.stringify(localStorage)') == original)
            check('missing addresses never trigger replacement confirmation or success', await page.get_by_role('dialog').filter(has_text='不是跨存储事务').count() == 0 and await page.get_by_text('配置与用户偏好已导入', exact=True).count() == 0)
            await page.screenshot(path=str(OUT / 'missing-addresses.png'), full_page=True)
            await page.evaluate('__wcAdmissionRestore()')
            await page.reload(wait_until='networkidle')
            check('rejected import leaves exact persistent bytes unchanged across fresh-page hydration', await page.evaluate('JSON.stringify(localStorage)') == original)
            await page.evaluate('''async () => {
                window.q={c:await import('/src/stores/use-config-store.ts'),f:await import('/src/services/config-file.ts'),r:await import('/src/services/config-import.ts')};
                q.c.useConfigStore.getState().updateConfig('channels',[q.c.useConfigStore.getState().config.channels[0]]);
            }''')
            # Import actual sensitive executable data with forged authority; intake must stay inert.
            sensitive = json.loads((OUT / 'sensitive-config.json').read_text())
            sensitive['trusted'] = True
            sensitive['config']['remember'] = True
            sensitive['config']['channels'][0]['models'][0].update({'trusted':True,'enabled':True})
            await page.locator('main input[type=file]').set_input_files({'name':'foreign-sensitive.json','mimeType':'application/json','buffer':json.dumps(sensitive).encode()})
            await page.get_by_role('dialog').filter(has_text='不是跨存储事务').get_by_role('button', name='确认替换', exact=True).click()
            await page.get_by_text('配置与用户偏好已导入', exact=True).first.wait_for()
            result = await page.evaluate('''async () => {
                const m=await import('/src/services/api/model-plugin.ts'),t=await import('/src/lib/executable-trust.ts');
                const c=q.c.useConfigStore.getState().config,script=c.channels[0].models[0].script;
                let blocked=false;try{await m.runModelPlugin({config:c,capability:'text',script})}catch{blocked=true}
                return {blocked,inert:!window.__webCImportedSideEffect,source:script,remember:q.c.secretPersistenceStatus('channel:default'),persisted:localStorage.getItem(q.c.CONFIG_STORE_KEY)};
            }''')
            check('full source imported with foreign trust flags remains inert at actual evaluator', result['blocked'] and result['inert'] and result['source'] == SCRIPT)
            check('imported supplied values grant no remembering consent', result['remember'] == 'session' and KEY not in result['persisted'] and DAV not in result['persisted'])
            # Simulate detected interference through the real shipped importer; trace all actual storage writes.
            result = await page.evaluate('''async () => {
                const data=q.f.createAppConfigExport();data.config.quality='high';
                window.__wcWrites=[];window.__wcNativeSet=Storage.prototype.setItem;window.__wcNativeRemove=Storage.prototype.removeItem;
                Storage.prototype.setItem=function(k,v){__wcWrites.push(k);__wcNativeSet.call(this,k,v);if(!window.__wcIntervened&&k===q.c.CONFIG_STORE_KEY){window.__wcIntervened=true;__wcNativeSet.call(this,k,'synthetic-durable-intervention')}};
                Storage.prototype.removeItem=function(k){__wcWrites.push(k);__wcNativeRemove.call(this,k)};
                try {await q.f.importAppConfig(new File([JSON.stringify(data)],'synthetic.json'),async()=>true);return {failed:false}}
                catch(e){return {failed:true,restoration:e.restoration,reason:e.reason,writes:[...__wcWrites]}}
            }''')
            check('real detected divergence aborts with no compensation writes', result == {'failed':True,'restoration':'incomplete','reason':'divergence','writes':['infinite-canvas:ai_config_store']})
            # Client-side navigation retains the RAM recovery record; a reload intentionally cannot.
            await page.evaluate("async()=>{const a=document.createElement('a');a.href='/image';document.body.append(a);a.remove();history.pushState({},'', '/image');window.dispatchEvent(new PopStateEvent('popstate'))}")
            banner = page.get_by_role('alert').filter(has_text='恢复不完整/无法核验')
            await banner.wait_for()
            check('recovery remains visibly actionable outside configuration page', await banner.get_by_role('button', name='检查设置并重试', exact=True).is_visible())
            await banner.get_by_role('button', name='检查设置并重试', exact=True).click()
            settings = page.get_by_role('dialog').filter(has=page.get_by_role('button', name='脱敏导出', exact=True))
            await settings.wait_for()
            await settings.get_by_role('button', name='Close', exact=True).click()
            await settings.wait_for(state='hidden')
            check('recovery banner and real error/settings open-close perform zero extra writes', await page.evaluate('__wcWrites') == ['infinite-canvas:ai_config_store'] and await page.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)') == 'synthetic-durable-intervention')
            check('recovery input remains in memory after closing settings', await page.evaluate('Boolean(q.r.useConfigImportRecovery.getState().failure.recovery)'))
            check('imported executable source was never evaluated', not await page.evaluate('Boolean(window.__webCImportedSideEffect)'))
            check('no external or companion transport', not REPORT['external_requests'])
            check('no page errors', not REPORT['page_errors'])
            await page.screenshot(path=str(OUT / 'recovery-ui.png'), full_page=True)
        except Exception:
            REPORT['ui_diagnostic'] = await page.locator('body').inner_text()
            REPORT['import_diagnostic'] = await page.evaluate('''() => ({failure:window.q?.r.useConfigImportRecovery.getState().failure?.message,sideEffect:Boolean(window.__webCImportedSideEffect)})''')
            await page.screenshot(path=str(OUT / 'failure-ui.png'), full_page=True)
            raise
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
