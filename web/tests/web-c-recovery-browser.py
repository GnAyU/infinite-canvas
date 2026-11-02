"""WEB-C v2+C1-C4: actual page termination, competing tabs and policy-aware hydration.
Synthetic values, isolated Chrome contexts; run against task-owned Vite on :43215:
uv run --offline --no-project --with playwright python web/tests/web-c-recovery-browser.py
"""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

ORIGIN = 'http://127.0.0.1:43215'
OUT = Path(__file__).resolve().parents[2] / '.local-tools/web-c-recovery-evidence'
REPORT: dict = {'checks': [], 'schedules': {}, 'external_requests': [], 'page_errors': []}
MODULES = """async()=>{window.q={c:await import('/src/stores/use-config-store.ts'),p:await import('/src/stores/use-prompt-source-store.ts'),f:await import('/src/services/config-file.ts'),r:await import('/src/services/config-import.ts')};await q.c.useConfigStore.persist.rehydrate();await q.p.usePromptSourceStore.persist.rehydrate()}"""
SNAP = """()=>({config:q.c.useConfigStore.getState().config,webdav:q.c.useConfigStore.getState().webdav,sources:q.p.usePromptSourceStore.getState().sources,schedule:q.p.usePromptSourceStore.getState().schedule,rawConfig:localStorage.getItem(q.c.CONFIG_STORE_KEY),rawPrompt:localStorage.getItem(q.p.usePromptSourceStore.persist.getOptions().name)})"""
IMPORT = """async()=>{const data=q.f.createAppConfigExport();data.config.quality='high';data.promptSources.sources[0].enabled=false;try{await q.f.importAppConfig(new File([JSON.stringify(data)],'synthetic.json'),async()=>true);return {ok:true}}catch(e){return {ok:false,reason:e.reason,restoration:e.restoration,attempts:e.compensationAttempts,recovery:!!e.recovery,message:e.message}}}"""


def check(name, value):
    assert value, name
    REPORT['checks'].append(name)


async def context(browser):
    ctx = await browser.new_context(service_workers='block')
    async def route(r):
        if r.request.url.startswith(ORIGIN + '/'):
            return await r.continue_()
        REPORT['external_requests'].append(r.request.url)
        await r.abort('blockedbyclient')
    await ctx.route('**/*', route)
    await ctx.route_web_socket('**/*', lambda ws: ws.close())
    return ctx


async def page_in(ctx):
    page = await ctx.new_page()
    page.on('pageerror', lambda e: REPORT['page_errors'].append(str(e)))
    await page.goto(ORIGIN + '/config', wait_until='networkidle')
    await page.evaluate(MODULES)
    return page


async def seed(page):
    await page.evaluate("""()=>{const s=q.c.useConfigStore.getState();s.updateConfig('quality','auto');q.p.usePromptSourceStore.getState().toggleSource(q.p.usePromptSourceStore.getState().sources[0].id,true)}""")
    return await page.evaluate(SNAP)


async def pause_hook(ctx, page, compensation=False):
    cdp = await ctx.new_cdp_session(page)
    await cdp.send('Debugger.enable')
    pauses = asyncio.Queue()
    cdp.on('Debugger.paused', lambda event: pauses.put_nowait(event))
    await page.evaluate("""compensation=>{
        const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
        window.__writes=[];window.__configCalls=0;window.__promptCalls=0;
        window.__restore=()=>{Storage.prototype.setItem=set;Storage.prototype.removeItem=remove};
        Storage.prototype.setItem=function(k,v){__writes.push({key:k,value:v});set.call(this,k,v);
            if(k===q.c.CONFIG_STORE_KEY&&++__configCalls===(compensation?2:1)){debugger;}
            if(compensation&&k.includes('prompt_source')&&++__promptCalls===1)throw new Error('synthetic post-write second-apply failure');
        };
        Storage.prototype.removeItem=function(k){__writes.push({key:k,value:null});return remove.call(this,k)};
    }""", compensation)
    task = asyncio.create_task(page.evaluate(IMPORT))
    await asyncio.wait_for(pauses.get(), timeout=30)
    return cdp, task


async def termination(browser, compensation):
    ctx = await context(browser)
    try:
        page = await page_in(ctx)
        before = await seed(page)
        cdp, importing = await pause_hook(ctx, page, compensation)
        observer = await page_in(ctx)
        mixed = await observer.evaluate(SNAP)
        label = 'compensation' if compensation else 'apply'
        check(label + ' termination fixture actually paused between durable store operations', mixed['config']['quality'] == ('auto' if compensation else 'high') and mixed['sources'][0]['enabled'] == (not compensation))
        await page.close(run_before_unload=False)
        try:
            await importing
        except Exception:
            pass  # Execution context was actually destroyed, not a simulated throw/rollback.
        await observer.reload(wait_until='networkidle')
        await observer.evaluate(MODULES)
        fresh = await observer.evaluate(SNAP)
        check(label + ' actual page termination leaves disclosed mixed state after fresh hydration', fresh['rawConfig'] == mixed['rawConfig'] and fresh['rawPrompt'] == mixed['rawPrompt'] and fresh['config']['quality'] == mixed['config']['quality'] and fresh['sources'] == mixed['sources'])
        check(label + ' termination is not advertised as crash-atomic recovery', before['rawConfig'] != mixed['rawConfig'] or before['rawPrompt'] != mixed['rawPrompt'])
        REPORT['schedules'][label + '_termination'] = {'before': before, 'paused': mixed, 'fresh': fresh}
    finally:
        await ctx.close()


async def competing(browser, mode):
    ctx = await context(browser)
    try:
        a = await page_in(ctx)
        before = await seed(a)
        b = await page_in(ctx)
        cdp, importing = await pause_hook(ctx, a)
        if mode == 'divergence':
            await b.evaluate("q.c.useConfigStore.getState().updateConfig('quality','medium')")
        else:
            await b.evaluate("""()=>{const key=q.c.CONFIG_STORE_KEY,raw=localStorage.getItem(key);window.__aba=raw;localStorage.setItem(key,JSON.stringify({synthetic:'intermediate'}));localStorage.setItem(key,raw)}""")
        foreign = await b.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)')
        await cdp.send('Debugger.resume')
        result = await importing
        writes = await a.evaluate('__writes')
        if mode == 'divergence':
            check('actual second-tab intervention is conservatively detected without compensation', result['reason'] == 'divergence' and result['restoration'] == 'incomplete' and result['attempts'] == 0 and result['recovery'])
            check('second-tab durable bytes survive direct and indirect error/settings UI writes', len(writes) == 1 and await a.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)') == foreign)
            await a.evaluate('q.c.useConfigStore.getState().openConfigDialog();q.c.useConfigStore.getState().setConfigDialogOpen(false)')
            check('actual second-tab conflict recovery UI does not republish stale first-tab state', len(await a.evaluate('__writes')) == 1 and await b.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)') == foreign)
            check('error does not claim identification or isolation of another writer', '可能有其他标签页' in result['message'])
        else:
            check('actual same-value ABA interference can be invisible under approved best effort', result == {'ok': True} and len(writes) == 2)
            check('same-value ABA does not imply CAS or joint-snapshot isolation', await b.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)') == foreign)
        REPORT['schedules'][mode] = {'before': before, 'foreign': foreign, 'result': result, 'writes': writes, 'final': await b.evaluate(SNAP)}
    finally:
        await ctx.close()


async def stale_setter(browser):
    ctx = await context(browser)
    try:
        a = await page_in(ctx)
        await seed(a)
        b = await page_in(ctx)
        await b.evaluate("q.c.useConfigStore.getState().updateConfig('quality','medium')")
        foreign = await b.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)')
        check('stale tab still has its old in-memory snapshot', await a.evaluate('q.c.useConfigStore.getState().config.quality') == 'auto')
        await a.evaluate("q.c.useConfigStore.getState().updateConfig('systemPrompt','synthetic-stale-setter')")
        await b.reload(wait_until='networkidle')
        await b.evaluate(MODULES)
        check('actual stale setter demonstrates disclosed last-writer-wins lost update', await b.evaluate('q.c.useConfigStore.getState().config.quality') == 'auto' and await b.evaluate('q.c.useConfigStore.getState().config.systemPrompt') == 'synthetic-stale-setter')
        REPORT['schedules']['stale_setter_lost_update'] = {'overwritten': foreign, 'fresh': await b.evaluate(SNAP)}
    finally:
        await ctx.close()


async def policy_hydration(browser):
    ctx = await context(browser)
    try:
        page = await page_in(ctx)
        await seed(page)
        result = await page.evaluate("""async()=>{
            const s=q.c.useConfigStore.getState();
            s.updateConfig('channels',[{...s.config.channels[0],apiKey:'synthetic-recovery-memory'},{...s.config.channels[0],id:'remembered',models:[],apiKey:'synthetic-recovery-remembered'}]);
            q.c.chooseSecretPersistence('channel:remembered','remember');
            s.importBootstrapCredentials('https://bootstrap.invalid/exact/v1','synthetic-recovery-bootstrap');
            s.updateWebdavConfig('url','https://dav.invalid/exact');s.updateWebdavConfig('username','synthetic-recovery-user');s.updateWebdavConfig('password','synthetic-recovery-dav');
            q.c.chooseSecretPersistence('webdav','remember');
            const before=structuredClone({config:q.c.useConfigStore.getState().config,webdav:q.c.useConfigStore.getState().webdav});
            const action=q.c.useConfigStore.getState().updateConfig,guard=q.c.useConfigStore.getState().isAiConfigReady;
            const data=q.f.createAppConfigExport();data.config.quality='high';
            await q.f.importAppConfig(new File([JSON.stringify(data)],'synthetic-safe.json'),async()=>true);
            let blocked=false;try{q.c.assertBootstrapRecipient({...q.c.useConfigStore.getState().config.channels.at(-1),baseUrl:'https://changed.invalid'})}catch{blocked=true}
            return JSON.parse(JSON.stringify({before,live:{config:q.c.useConfigStore.getState().config,webdav:q.c.useConfigStore.getState().webdav},raw:localStorage.getItem(q.c.CONFIG_STORE_KEY),actions:action===q.c.useConfigStore.getState().updateConfig&&guard===q.c.useConfigStore.getState().isAiConfigReady,blocked}));
        }""")
        check('redacted import preserves admitted live memory/bootstrap/remember credentials and exact identities', result['live']['config']['channels'] == result['before']['config']['channels'] and result['live']['webdav'] == result['before']['webdav'])
        check('actual durable projection contains only explicitly remembered original values', 'synthetic-recovery-memory' not in result['raw'] and 'synthetic-recovery-bootstrap' not in result['raw'] and all(v in result['raw'] for v in ['synthetic-recovery-remembered','synthetic-recovery-user','synthetic-recovery-dav']))
        check('successful import preserves actual actions and bootstrap recipient guard', result['actions'] and result['blocked'])
        await page.reload(wait_until='networkidle')
        await page.evaluate(MODULES)
        fresh = await page.evaluate(SNAP)
        check('policy-aware fresh hydration retains IDs/settings and intentionally drops session/bootstrap secrets', [c['id'] for c in fresh['config']['channels']] == [c['id'] for c in result['live']['config']['channels']] and fresh['config']['quality'] == 'high' and not fresh['config']['channels'][0]['apiKey'] and not fresh['config']['channels'][2]['apiKey'] and fresh['config']['channels'][1]['apiKey'] == 'synthetic-recovery-remembered' and fresh['webdav']['password'] == 'synthetic-recovery-dav')
        check('fresh remembered plaintext is explicitly legacy pending keep or forget', await page.evaluate("q.c.secretPersistenceStatus('channel:remembered')==='legacy'&&q.c.secretPersistenceStatus('webdav')==='legacy'"))
        before = await page.evaluate(SNAP)
        rejected = await page.evaluate("""async()=>{let writes=0;const set=Storage.prototype.setItem;Storage.prototype.setItem=function(...a){writes++;return set.apply(this,a)};try{await q.f.importAppConfig(new File([JSON.stringify(q.f.createAppConfigExport())],'synthetic.json'),async()=>true);return {rejected:false}}catch(e){return {rejected:true,message:e.message,writes}}finally{Storage.prototype.setItem=set}}""")
        check('unresolved legacy rejects entire replacement before live/raw mutations or writes', rejected['rejected'] and rejected['writes'] == 0 and '旧密钥' in rejected['message'] and await page.evaluate(SNAP) == before)
        REPORT['schedules']['policy_hydration'] = {'result': result, 'fresh': fresh, 'legacy_rejection': rejected}
    finally:
        await ctx.close()


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
        try:
            await termination(browser, False)
            await termination(browser, True)
            await competing(browser, 'divergence')
            await competing(browser, 'same_value_ABA')
            await stale_setter(browser)
            await policy_hydration(browser)
            check('all recovery schedules have zero external/companion requests and uncaught errors', not REPORT['external_requests'] and not REPORT['page_errors'])
        finally:
            await browser.close()


try:
    asyncio.run(main())
except Exception as error:
    REPORT['failure'] = str(error)
    raise
finally:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
    print(json.dumps({k:v for k,v in REPORT.items() if k != 'schedules'}, ensure_ascii=False, indent=2))
