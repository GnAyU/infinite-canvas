"""WEB-C lifecycle controls. Disposable Chrome, synthetic values, no live traffic.
Run Vite on 127.0.0.1:43215, then:
uv run --offline --no-project --with playwright python web/tests/web-c-lifecycle-browser.py
"""
import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ORIGIN = 'http://127.0.0.1:43215'
OUT = Path(__file__).resolve().parents[2] / '.local-tools/web-c-lifecycle-evidence'
KEY = 'synthetic_lifecycle_api'
DAV = 'synthetic_lifecycle_password'
USER = 'synthetic_lifecycle_username'
REPORT: dict = {'checks': [], 'external_requests': [], 'page_errors': []}
MODULES = '''async () => {
    window.q={c:await import('/src/stores/use-config-store.ts'),p:await import('/src/stores/use-prompt-source-store.ts'),f:await import('/src/services/config-file.ts'),l:await import('/src/lib/localforage-storage.ts'),m:await import('/src/services/file-storage.ts')};
}'''


def check(name, condition):
    assert condition, name
    REPORT['checks'].append(name)


async def raw(page):
    return await page.evaluate('localStorage.getItem(q.c.CONFIG_STORE_KEY)')


async def reload(page):
    await page.reload(wait_until='networkidle')
    await page.evaluate(MODULES)


def entry(page, text):
    return page.locator('section > div').filter(has=page.locator('span').filter(has_text=text)).filter(has=page.get_by_role('button', name='本次会话后忘记', exact=True)).first


async def choice(page, row, mode, cancel=False, race=False):
    label = '本次会话后忘记' if mode == 'forget' else re.compile('^记住到此浏览器（明文）$|^继续明文记住$')
    await row.get_by_role('button', name=label).click()
    dialog = page.get_by_role('dialog').filter(has_text='能访问浏览器配置的人')
    await dialog.wait_for()
    text = await dialog.inner_text()
    check('choice warning names plaintext, profile access, trusted extensions and session retention', all(v in text for v in ['明文', '不是加密', '浏览器配置', '受信任扩展', '本页仍可使用']))
    if race:
        await page.evaluate("q.c.useConfigStore.getState().updateConfig('quality','high')")
    label = re.compile(r'^取\s*消$') if cancel else '仅移除已存秘密' if mode == 'forget' else '确认明文记住当前值'
    await dialog.get_by_role('button', name=label).click()
    await dialog.wait_for(state='detached')


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
        ctx = await browser.new_context(service_workers='block')
        async def route(r):
            if r.request.url.startswith(ORIGIN + '/'):
                return await r.continue_()
            REPORT['external_requests'].append(r.request.url)
            await r.abort('blockedbyclient')
        await ctx.route('**/*', route)
        await ctx.route_web_socket('**/*', lambda ws: ws.close())
        page = await ctx.new_page()
        page.on('pageerror', lambda e: REPORT['page_errors'].append(str(e)))
        try:
            await page.goto(ORIGIN + '/config', wait_until='networkidle')
            await page.evaluate(MODULES)
            await page.get_by_role('button', name=re.compile(r'^编\s*辑$')).first.click()
            drawer = page.get_by_role('dialog').filter(has=page.locator('input[placeholder="sk-..."]'))
            await drawer.locator('input[placeholder="sk-..."]').fill(KEY)
            await drawer.get_by_role('button', name=re.compile(r'^保\s*存$')).click()
            await drawer.wait_for(state='hidden')
            await page.get_by_role('tab', name='WebDAV', exact=True).click()
            await page.locator('input[placeholder="https://nas.example.com/webdav"]').fill('https://dav.invalid/files')
            await page.locator('input[autocomplete="username"]').fill(USER)
            await page.locator('input[autocomplete="current-password"]').fill(DAV)
            check('actual API/WebDAV edits remain usable only in current page', await page.evaluate('''({key,user,dav}) => {const s=q.c.useConfigStore.getState();return s.config.channels[0].apiKey===key&&s.webdav.username===user&&s.webdav.password===dav}''', {'key': KEY, 'user': USER, 'dav': DAV}))
            check('new API/WebDAV edits persist nonsecrets but not secrets', all([v not in await raw(page) for v in [KEY, USER, DAV]]) and 'https://dav.invalid/files' in await raw(page))
            await reload(page)
            check('fresh page loses unremembered secrets and retains channel/settings identity', await page.evaluate("(()=>{const s=q.c.useConfigStore.getState();return s.config.channels[0].id==='default'&&!s.config.channels[0].apiKey&&!s.webdav.username&&!s.webdav.password&&s.webdav.url==='https://dav.invalid/files'})()"))
            await page.evaluate('''({key,user,dav})=>{const s=q.c.useConfigStore.getState();s.updateConfig('channels',[{...s.config.channels[0],apiKey:key}]);s.updateWebdavConfig('username',user);s.updateWebdavConfig('password',dav)}''', {'key': KEY, 'user': USER, 'dav': DAV})
            channel_name = await page.evaluate('q.c.useConfigStore.getState().config.channels[0].name')
            before = await raw(page)
            await choice(page, entry(page, channel_name), 'remember', cancel=True)
            check('remember cancel leaves exact disk and session policy unchanged', await raw(page) == before and await page.evaluate("q.c.secretPersistenceStatus('channel:default')") == 'session')
            await choice(page, entry(page, channel_name), 'remember', race=True)
            check('changed settings while consent is open require fresh confirmation', KEY not in await raw(page) and await page.evaluate("q.c.secretPersistenceStatus('channel:default')") == 'session' and await page.get_by_text('设置已更改，请重新确认当前值。', exact=True).is_visible())
            await choice(page, entry(page, channel_name), 'remember')
            await choice(page, entry(page, 'WebDAV 凭据'), 'remember')
            check('explicit remember writes declared plaintext values', all([v in await raw(page) for v in [KEY, USER, DAV]]))
            await reload(page)
            check('remembered API/WebDAV survive fresh page without a new storage representation', await page.evaluate('''({key,dav})=>{const s=q.c.useConfigStore.getState();return s.config.channels[0].apiKey===key&&s.webdav.password===dav&&JSON.parse(localStorage.getItem(q.c.CONFIG_STORE_KEY)).version===0}''', {'key': KEY, 'dav': DAV}))
            check('existing plaintext is disclosed as unresolved legacy on a fresh page', await page.get_by_text(re.compile('旧明文仍在磁盘，尚未选择')).count() == 2)
            # Unrelated IndexedDB owners and Blob: seed through existing app APIs; no schema/ID changes.
            unrelated = await page.evaluate('''async()=>{
                const c=await import('/src/stores/canvas/use-canvas-store.ts'),a=await import('/src/stores/use-asset-store.ts');
                await c.useCanvasStore.persist.rehydrate();await a.useAssetStore.persist.rehydrate();
                const project=c.useCanvasStore.getState().createProject('synthetic-preserved-project');
                const asset=a.useAssetStore.getState().addAsset({kind:'text',title:'synthetic-preserved-asset',coverUrl:'',tags:[],data:{content:'synthetic-preserved-content'}});
                await q.m.setMediaBlob('file:synthetic-lifecycle-preserved',new Blob(['synthetic-preserved-bytes'],{type:'application/octet-stream'}));
                localStorage.setItem('synthetic-unrelated','preserved');return {project,asset};
            }''')
            durable = False
            for _ in range(100):
                durable = await page.evaluate("async ids=>Boolean((await q.l.localForageStorage.getItem('infinite-canvas:canvas_store'))?.includes(ids.project)&&(await q.l.localForageStorage.getItem('infinite-canvas:asset_store'))?.includes(ids.asset))", unrelated)
                if durable:
                    break
                await asyncio.sleep(0.05)
            check('preservation fixture waits for actual debounced durable project/asset writes', durable)
            original_idb = await page.evaluate('''async()=>({canvas:await q.l.localForageStorage.getItem('infinite-canvas:canvas_store'),assets:await q.l.localForageStorage.getItem('infinite-canvas:asset_store'),blob:await (await q.m.getMediaBlob('file:synthetic-lifecycle-preserved')).text()})''')
            before = await raw(page)
            await choice(page, entry(page, channel_name), 'forget', cancel=True)
            check('legacy migration cancel preserves exact bytes and usable credential', await raw(page) == before and await page.evaluate("q.c.secretPersistenceStatus('channel:default')") == 'legacy')
            await page.evaluate("q.c.useConfigStore.getState().updateConfig('quality','medium')")
            check('unrelated preference write retains unresolved legacy plaintext', all([v in await raw(page) for v in [KEY, USER, DAV]]))
            await page.get_by_role('tab', name='WebDAV', exact=True).click()
            address = page.locator('input[placeholder="https://nas.example.com/webdav"]')
            await address.fill('https://changed.invalid/files')
            # RED for unhandled direct WebDAV guard; must remain visible and report migration action.
            check('legacy WebDAV recipient edit is handled without an unhandled page error', not REPORT['page_errors'])
            await page.get_by_text(re.compile('请先为受影响的旧密钥选择')).first.wait_for()
            check('legacy WebDAV edit has actionable UI and leaves recipient/bytes unchanged', await address.input_value() == 'https://dav.invalid/files' and 'https://changed.invalid' not in await raw(page))
            await choice(page, entry(page, channel_name), 'forget')
            check('selective API forget removes only its persisted value but preserves live use and WebDAV', KEY not in await raw(page) and DAV in await raw(page) and await page.evaluate('q.c.useConfigStore.getState().config.channels[0].apiKey') == KEY)
            await choice(page, entry(page, 'WebDAV 凭据'), 'forget')
            check('selective WebDAV forget removes stored username/password, not URL/directory or live use', all([v not in await raw(page) for v in [USER, DAV]]) and await page.evaluate('q.c.useConfigStore.getState().webdav.password') == DAV and 'https://dav.invalid/files' in await raw(page))
            preserved = await page.evaluate('''async()=>({canvas:await q.l.localForageStorage.getItem('infinite-canvas:canvas_store'),assets:await q.l.localForageStorage.getItem('infinite-canvas:asset_store'),blob:await (await q.m.getMediaBlob('file:synthetic-lifecycle-preserved')).text()})''')
            if preserved != original_idb:
                REPORT['preservation_diagnostic'] = {'before': original_idb, 'after': preserved}
            check('forget preserves exact unrelated IndexedDB owners/blob and local settings', preserved == original_idb and await page.evaluate("localStorage.getItem('synthetic-unrelated')") == 'preserved')
            await reload(page)
            check('forgotten values stay absent on fresh page, unrelated IDs and media survive', await page.evaluate('''async ids=>{const s=q.c.useConfigStore.getState();return !s.config.channels[0].apiKey&&!s.webdav.password&&!s.webdav.username&&(await q.l.localForageStorage.getItem('infinite-canvas:canvas_store')).includes(ids.project)&&(await q.l.localForageStorage.getItem('infinite-canvas:asset_store')).includes(ids.asset)&&await (await q.m.getMediaBlob('file:synthetic-lifecycle-preserved')).text()==='synthetic-preserved-bytes'}''', unrelated))
            # Browser quota, silent write and read failure: no false acknowledged choice.
            for failure in ['throw', 'silent', 'read']:
                await page.evaluate('''({key,failure})=>{
                    const data={version:0,state:{config:{...q.c.defaultConfig,channels:[{...q.c.defaultConfig.channels[0],apiKey:key}]},webdav:q.c.defaultWebdavSyncConfig}};
                    localStorage.setItem(q.c.CONFIG_STORE_KEY,JSON.stringify(data));q.c.useConfigStore.persist.rehydrate();
                    window.__before=localStorage.getItem(q.c.CONFIG_STORE_KEY);const set=Storage.prototype.setItem,get=Storage.prototype.getItem;
                    window.__restore=()=>{Storage.prototype.setItem=set;Storage.prototype.getItem=get};
                    Storage.prototype.setItem=function(k,v){if(k===q.c.CONFIG_STORE_KEY){if(failure==='throw')throw new Error('synthetic quota');if(failure==='silent')return}return set.call(this,k,v)};
                    if(failure==='read')Storage.prototype.getItem=function(k){if(k===q.c.CONFIG_STORE_KEY)throw new Error('synthetic read');return get.call(this,k)};
                }''', {'key': KEY, 'failure': failure})
                await choice(page, entry(page, channel_name), 'forget')
                await page.get_by_text('秘密存储选择未能完成，请检查浏览器存储后重试。', exact=True).first.wait_for()
                result = await page.evaluate("(()=>{__restore();return q.c.secretPersistenceStatus('channel:default')==='legacy'&&localStorage.getItem(q.c.CONFIG_STORE_KEY)===__before})()")
                check(f'{failure} storage failure leaves exact disk, legacy policy and actionable failure UI', result)
            check('no companion or external transport and no uncaught page errors', not REPORT['external_requests'] and not REPORT['page_errors'])
            await page.screenshot(path=str(OUT / 'lifecycle.png'), full_page=True)
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
