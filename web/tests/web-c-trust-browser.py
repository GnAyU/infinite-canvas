"""WEB-C full-trust controls: real consent dialogs/evaluators, immutable bytes, restart and dependency gates.
Isolated Chrome, no live requests; Vite :43215.
uv run --offline --no-project --with playwright python web/tests/web-c-trust-browser.py
"""
import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ORIGIN = 'http://127.0.0.1:43215'
OUT = Path(__file__).resolve().parents[2] / '.local-tools/web-c-trust-evidence'
SCRIPT = "globalThis.__modelRuns=(globalThis.__modelRuns||0)+1; return 'synthetic-approved-result';"
PLUGIN = "globalThis.__pluginRuns=(globalThis.__pluginRuns||0)+1;export default {id:'synthetic-browser-plugin',name:'Synthetic',version:'1',nodes:[{type:'synthetic-browser:node',title:'Synthetic',defaultSize:{width:100,height:100},Component:()=>null}],setup(){globalThis.__pluginSetups=(globalThis.__pluginSetups||0)+1;return ()=>{globalThis.__pluginCleanups=(globalThis.__pluginCleanups||0)+1}}}"
FACTORY = "globalThis.__factoryModuleRuns=(globalThis.__factoryModuleRuns||0)+1;export default runtime=>{globalThis.__factoryRuns=(globalThis.__factoryRuns||0)+1;return {id:'synthetic-factory',nodes:[{type:'synthetic-factory:node'}]}}"
REPORT: dict = {'checks': [], 'requests': [], 'unexpected_requests': [], 'page_errors': []}
MODULES = """async()=>{window.q={c:await import('/src/stores/use-config-store.ts'),f:await import('/src/services/config-file.ts'),r:await import('/src/services/config-import.ts'),t:await import('/src/lib/executable-trust.ts'),m:await import('/src/services/api/model-plugin.ts'),l:await import('/src/lib/canvas/plugin-loader.ts'),p:await import('/src/stores/canvas/use-plugin-store.ts')};await q.p.usePluginStore.persist.rehydrate()}"""


def check(name, value):
    assert value, name
    REPORT['checks'].append(name)


async def model_open(page):
    await page.get_by_role('button', name=re.compile(r'^编\s*辑$')).first.click()
    drawer = page.get_by_role('dialog').filter(has=page.locator('input[placeholder="sk-..."]'))
    await drawer.get_by_role('button', name='脚本已设', exact=True).first.click()
    editor = page.get_by_role('dialog').filter(has=page.get_by_role('button', name='检查并授权当前脚本', exact=True))
    await editor.wait_for()
    return editor, drawer


async def model_run(page, source=None):
    return await page.evaluate("""async source=>{try{const s=q.c.useConfigStore.getState().config;return {value:await q.m.runModelPlugin({config:s,capability:'text',script:source??s.channels[0].models[0].script}),runs:window.__modelRuns||0}}catch(e){return {blocked:true,message:e.message,runs:window.__modelRuns||0}}}""", source)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
        ctx = await browser.new_context(service_workers='block', viewport={'width':1600,'height':1000})
        plugin_response = {'source': PLUGIN}
        async def route(r):
            url = r.request.url
            if url.startswith(ORIGIN + '/') and '/plugins/' not in url:
                return await r.continue_()
            REPORT['requests'].append(url)
            headers = {'access-control-allow-origin':'*','access-control-allow-headers':'*'}
            if '/plugins/index.json' in url:
                return await r.fulfill(content_type='application/json', body='["/plugins/synthetic-browser.js","/plugins/factory.js"]')
            if '/plugins/factory.js' in url:
                return await r.fulfill(headers=headers, content_type='text/javascript', body=FACTORY)
            if '/plugins/synthetic-browser.js' in url or url.startswith('https://plugins.invalid/'):
                return await r.fulfill(headers=headers, content_type='text/javascript', body=plugin_response['source'])
            REPORT['unexpected_requests'].append(url)
            await r.abort('blockedbyclient')
        await ctx.route('**/*', route)
        await ctx.route_web_socket('**/*', lambda ws: ws.close())
        page = await ctx.new_page()
        page.on('pageerror', lambda e: REPORT['page_errors'].append(str(e)))
        try:
            await page.goto(ORIGIN + '/config', wait_until='networkidle')
            await page.evaluate(MODULES)
            await page.evaluate("""script=>{const s=q.c.useConfigStore.getState();s.updateConfig('channels',[{...s.config.channels[0],apiKey:'synthetic-trust-session-key',models:s.config.channels[0].models.map((m,i)=>i?m:{...m,script})}])}""", SCRIPT)
            check('actual model evaluator blocks unconsented executable source', (await model_run(page)).get('blocked') and not await page.evaluate('Boolean(window.__modelRuns)'))
            editor, drawer = await model_open(page)
            check('editor preview never evaluates source', not await page.evaluate('Boolean(window.__modelRuns)'))
            await editor.get_by_role('button', name='检查并授权当前脚本', exact=True).click()
            consent = page.get_by_role('dialog').filter(has_text='完全信任并授权这份代码（仅本次页面会话）？')
            await consent.wait_for()
            text = await consent.inner_text()
            check('real consent discloses persisted secrets, remaining Agent token, page/session data, requests and modification', all(v in text for v in ['API/WebDAV','Agent Token','页面数据','纯内存密钥','发起请求','修改应用','不是沙箱','不证明发布者可信','不能撤回']))
            check('dialog digest is exact executable bytes, not URL or publisher metadata', (await page.evaluate('q.t.executableDigest(q.c.useConfigStore.getState().config.channels[0].models[0].script)')) in text and SCRIPT in text)
            await consent.get_by_role('button', name='不授权', exact=True).click()
            await consent.wait_for(state='detached')
            check('cancelled real consent leaves actual evaluator blocked', (await model_run(page)).get('blocked'))
            await editor.get_by_role('button', name='检查并授权当前脚本', exact=True).click()
            consent = page.get_by_role('dialog').filter(has_text='完全信任并授权这份代码（仅本次页面会话）？')
            await consent.get_by_role('button', name='我信任此代码，授权运行', exact=True).click()
            await consent.wait_for(state='detached')
            check('unchanged bytes after real consent execute successfully', await model_run(page) == {'value':'synthetic-approved-result','runs':1})
            changed = SCRIPT + '\n// replaced at same model/version'
            check('changed source cannot use old digest approval', (await model_run(page, changed)).get('blocked') and await page.evaluate('__modelRuns') == 1)
            await editor.get_by_role('button', name='撤销本页全部模型脚本授权', exact=True).click()
            check('real revoke button blocks future model calls', (await model_run(page)).get('blocked'))
            await editor.get_by_role('button', name='检查并授权当前脚本', exact=True).click()
            consent = page.get_by_role('dialog').filter(has_text='完全信任并授权这份代码（仅本次页面会话）？')
            await consent.wait_for()
            await page.evaluate("q.t.revokeExecutable('model')")
            await consent.get_by_role('button', name='我信任此代码，授权运行', exact=True).click()
            await consent.wait_for(state='detached')
            check('revocation during real pending confirmation invalidates late approval', (await model_run(page)).get('blocked'))
            # The editor can authorize new bytes before Save; saving must keep that separate consent.
            await editor.locator('.cm-content[contenteditable=true]').fill(changed)
            await editor.get_by_role('button', name='检查并授权当前脚本', exact=True).click()
            consent = page.get_by_role('dialog').filter(has_text='完全信任并授权这份代码（仅本次页面会话）？')
            await consent.get_by_role('button', name='我信任此代码，授权运行', exact=True).click()
            await consent.wait_for(state='detached')
            await editor.get_by_role('button', name=re.compile(r'^保\s*存$')).click()
            await editor.wait_for(state='hidden')
            await drawer.get_by_role('button', name=re.compile(r'^保\s*存$')).click()
            await drawer.wait_for(state='hidden')
            check('new editor draft separately approved then actually saved remains executable', (await model_run(page)).get('value') == 'synthetic-approved-result')
            check('saving changed source invalidates old digest approval', (await model_run(page, SCRIPT)).get('blocked'))
            # Actual WebCrypto await: replace digest only with a delay around the real implementation.
            result = await page.evaluate("""async script=>{
                const digest=crypto.subtle.digest.bind(crypto.subtle),entered=Promise.withResolvers(),release=Promise.withResolvers();
                crypto.subtle.digest=async(...args)=>{entered.resolve();await release.promise;return digest(...args)};
                const approving=q.t.approveExecutable('hash-race',script,async()=>true);await entered.promise;q.t.revokeExecutable('hash-race');release.resolve();
                try{return {approved:await approving}}finally{crypto.subtle.digest=digest}
            }""", SCRIPT)
            check('revocation while real digest is pending wins before approval', result == {'approved':False})
            result = await page.evaluate("""async script=>{
                await q.t.approveExecutable('model',script,async()=>true);
                const args={config:q.c.useConfigStore.getState().config,capability:'text',script};const pending=q.m.runModelPlugin(args);args.script='globalThis.__swappedRuns=true;return 0';
                const value=await pending;return {value,swapped:!!window.__swappedRuns}
            }""", SCRIPT)
            check('caller source mutation during hashing cannot swap evaluated bytes', result == {'value':'synthetic-approved-result','swapped':False})
            await page.reload(wait_until='networkidle')
            await page.evaluate(MODULES)
            check('fresh page never treats old script cache as execution consent', (await model_run(page)).get('blocked') and not await page.evaluate('Boolean(window.__modelRuns)'))
            # Exercise discovery/factory and legacy enabled cache with the real localForage store.
            await page.evaluate('q.l.ensurePluginsLoaded()')
            check('local discovery and factory metadata intake do not evaluate modules or factories', not await page.evaluate('Boolean(window.__pluginRuns||window.__factoryModuleRuns||window.__factoryRuns)'))
            await page.evaluate("q.l.installPluginFromUrl('https://plugins.invalid/remote.js',{official:true,id:'synthetic-official',name:'Synthetic official',version:'1'})")
            check('official-labelled remote install is inert and disabled', await page.evaluate("q.p.usePluginStore.getState().plugins.every(p=>!p.enabled)&&!window.__pluginRuns"))
            await page.evaluate("q.l.updatePlugin(q.p.usePluginStore.getState().plugins.find(p=>p.id==='synthetic-official'))")
            check('remote update is not run consent', not await page.evaluate('Boolean(window.__pluginRuns)'))
            project = await page.evaluate("async()=>{const c=await import('/src/stores/canvas/use-canvas-store.ts');await c.useCanvasStore.persist.rehydrate();return c.useCanvasStore.getState().createProject('synthetic-trust-project')}")
            await page.evaluate("id=>{history.pushState({},'', '/canvas/'+id);window.dispatchEvent(new PopStateEvent('popstate'))}", project)
            await page.get_by_role('button', name='节点插件', exact=True).click()
            manager = page.get_by_role('dialog', name='节点插件', exact=True)
            await manager.get_by_role('tab', name='本地插件', exact=True).click()
            row = manager.locator('div.rounded-xl').filter(has_text='synthetic-browser').first
            await row.get_by_role('switch').click()
            consent = page.get_by_role('dialog').filter(has_text='完全信任并授权这份代码（仅本次页面会话）？')
            await consent.wait_for()
            check('plugin enable separately presents exact code and full-trust warning', PLUGIN in await consent.inner_text() and 'SHA-256:' in await consent.inner_text())
            await consent.get_by_role('button', name='我信任此代码，授权运行', exact=True).click()
            await consent.wait_for(state='detached')
            await page.wait_for_function('window.__pluginSetups===1')
            check('unchanged plugin real enable executes approved module and setup', await page.evaluate('__pluginRuns===1&&__pluginSetups===1'))
            await row.get_by_role('switch').click()
            check('plugin disable revokes and cleans active registration without undo claim', await page.evaluate('__pluginCleanups===1&&__pluginRuns===1'))
            plugin_response['source'] = PLUGIN + '\n// changed while confirmation is open'
            await row.get_by_role('switch').click()
            consent = page.get_by_role('dialog').filter(has_text='完全信任并授权这份代码（仅本次页面会话）？')
            await consent.wait_for()
            plugin_response['source'] = PLUGIN + '\n// different bytes on execution refetch'
            await consent.get_by_role('button', name='我信任此代码，授权运行', exact=True).click()
            await consent.wait_for(state='detached')
            await page.get_by_text(re.compile('尚未获得本次会话')).first.wait_for()
            check('local refetch changed during dialog cannot evaluate replacement bytes', await page.evaluate('__pluginRuns===1&&!q.p.usePluginStore.getState().plugins.find(p=>p.id==="synthetic-browser").enabled'))
            for name, dependency in [('markdown','https://esm.sh/marked@14'),('panorama','https://esm.sh/three@0.180.0')]:
                result = await page.evaluate("""async ({name,dependency})=>{
                    const code=`globalThis.__dependencyRuns=true;const d=await import('${dependency}');export default {}`;
                    const record={id:name,name,version:'1',url:'https://plugins.invalid/'+name+'.js',source:code,enabled:false};q.p.usePluginStore.getState().upsert(record);
                    let confirms=0,error='';try{await q.t.approveExecutable(q.l.pluginTrustScope(name),code,async()=>{confirms++;return true})}catch(e){error=e.message}
                    let blocked=false;try{await q.l.setPluginEnabled(record,true)}catch{blocked=true}
                    return {confirms,error,blocked,inert:!window.__dependencyRuns}
                }""", {'name':name,'dependency':dependency})
                check(name + ' unbound CDN dependency disabled before confirmation/evaluation with explanation', result['confirms'] == 0 and result['blocked'] and result['inert'] and '完整可执行内容' in result['error'])
            # Persist malicious old cache explicitly through the existing storage identity; new page must ignore enabled.
            await page.evaluate("""async()=>{const storage=q.p.usePluginStore.persist.getOptions().storage;await storage.setItem('infinite-canvas:plugin_store',{version:0,state:{plugins:q.p.usePluginStore.getState().plugins.map(p=>({...p,enabled:true,trusted:true}))}})}""")
            await page.reload(wait_until='networkidle')
            await page.evaluate(MODULES)
            check('fresh startup rejects imported/legacy plugin enabled cache and revoked/changed source', await page.evaluate('q.p.usePluginStore.getState().plugins.every(p=>!p.enabled)&&!window.__pluginRuns&&!window.__factoryModuleRuns'))
            check('no unbound dependency, companion or other unexpected network request', not REPORT['unexpected_requests'])
            check('no unhandled page errors', not REPORT['page_errors'])
            await page.screenshot(path=str(OUT / 'trust.png'), full_page=True)
        except Exception:
            REPORT['ui_diagnostic'] = await page.locator('body').inner_text()
            await page.screenshot(path=str(OUT / 'failure.png'), full_page=True)
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
