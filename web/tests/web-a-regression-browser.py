"""Synthetic WEB-A replay through the WEB-C consent gate; real IndexedDB/ZIP.
Requires task Vite :43215, ffmpeg, and uv run --offline --no-project --with playwright python.
"""
import asyncio, base64, json, subprocess
from pathlib import Path
from urllib.parse import urlsplit, unquote
from zipfile import ZipFile
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local-tools/web-c-web-a-regression-evidence'
ORIGIN = 'http://127.0.0.1:43215'
KEY = 'repair_browser_selected_canary'
UNKNOWN = 'repair_unknown_url_canary'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII='
REPORT: dict = {'checks': [], 'cases': [], 'exports': []}

async def main():
 OUT.mkdir(parents=True,exist_ok=True)
 fixtures=OUT/'fixtures';fixtures.mkdir(exist_ok=True)
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=black:s=16x16:r=1:d=1','-c:v','libx264','-pix_fmt','yuv420p',str(fixtures/'valid.mp4')],check=True)
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','1',str(fixtures/'valid.wav')],check=True)
 async with async_playwright() as pw:
  browser = await pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking'])
  ctx = await browser.new_context(service_workers='block', accept_downloads=True)
  calls, blocked, logs, errors = [], [], [], []
  mode = {'value': 'json', 'redirect': None, 'media_only': False}
  async def route(r):
   req = r.request; u = urlsplit(req.url)
   if req.url.startswith(ORIGIN + '/'): return await r.continue_()
   calls.append({'url':req.url, 'method':req.method, 'headers':await req.all_headers()})
   if u.hostname not in ['channel.invalid','dav.invalid']:
    blocked.append(req.url); return await r.abort('blockedbyclient')
   h = {'access-control-allow-origin':ORIGIN, 'access-control-allow-headers':'*', 'access-control-allow-methods':'GET,POST,PUT,MKCOL,PROPFIND,OPTIONS', 'content-type':'application/json'}
   if req.method == 'OPTIONS': return await r.fulfill(status=204, headers=h)
   if mode['redirect'] and (not mode['media_only'] or 'media.mp4' in u.path): return await r.fulfill(status=302,headers={**h,'location':mode['redirect']},body='')
   if u.hostname == 'dav.invalid': return await r.fulfill(status=207 if req.method=='PROPFIND' else 201,headers=h,body='')
   if 'predictLongRunning' in u.path: data = {'name':'operations/synthetic'}
   elif '/operations/' in u.path:
    if mode['value']=='encoded-error': data={'done':True,'error':{'message':'provider echo %72'+KEY[1:]}}
    else: data={'done':True,'response':{'generateVideoResponse':{'generatedSamples':[{'video':{'uri':'https://channel.invalid/prefix/media.mp4'}}]}}}
   elif '/images/' in u.path or 'generateContent' in u.path:
    inline = 'data:image/png;name='+KEY+';base64,'+PNG
    if 'generateContent' in u.path:
     part = {'inlineData':{'data':PNG,'mimeType':'image/png;name='+KEY}}
     if mode['value']=='image-file': part={'fileData':{'fileUri':inline,'mimeType':'image/png;name='+KEY}}
     if mode['value']=='image-remote': part={'fileData':{'fileUri':'https://channel.invalid/prefix/image.png','mimeType':'image/png;name='+KEY}}
     data={'candidates':[{'content':{'parts':[part]}}]}
    else: data={'data':[{'url':'https://channel.invalid/prefix/image.png' if mode['value'] in ['image-remote','json','html','wrong-mime','comment','comment-preamble','fragment'] else inline}]}
   else:
    if mode['value'].startswith('image-'):
     return await r.fulfill(status=200,headers={**h,'content-type':'image/png;name='+KEY},body=base64.b64decode(PNG))
    if mode['value']=='valid':
     audio = '/audio/' in u.path
     return await r.fulfill(status=200, headers={**h,'content-type':('audio/wav' if audio else 'video/mp4')+';name='+KEY}, body=(fixtures/('valid.wav' if audio else 'valid.mp4')).read_bytes())
    if mode['value']=='html':
     return await r.fulfill(status=200,headers={**h,'content-type':'text/html'},body='<html>authentication unsupported '+KEY+'</html>')
    if mode['value']=='fragment':
     content = '<div class="gateway-error"><h1>401 Unauthorized</h1><p>Header authentication unsupported; echo '+KEY+'</p></div>'
     mime = 'image/png' if u.path.endswith('.png') else 'audio/mpeg' if '/audio/' in u.path else 'video/mp4'
     return await r.fulfill(status=200,headers={**h,'content-type':mime},body=content)
    if mode['value'] in ['comment','comment-preamble']:
     prefix = '<!-- gateway authentication failure -->\n' if mode['value']=='comment' else '\ufeff \n<!-- first -->\n<!-- second -->\n'
     content = prefix+'<html><body>Header authentication unsupported; echo '+KEY+'</body></html>'
     mime = 'image/png' if u.path.endswith('.png') else 'audio/mpeg' if '/audio/' in u.path else 'video/mp4'
     return await r.fulfill(status=200,headers={**h,'content-type':mime},body=content)
    if mode['value']=='wrong-mime': h['content-type']='image/png' if u.path.endswith('.png') else 'audio/mpeg' if '/audio/' in u.path else 'video/mp4'
    data={'error':{'message':'header authentication unsupported; echo '+KEY}}
   await r.fulfill(status=200,headers=h,body=json.dumps(data))
  await ctx.route('**/*',route)
  await ctx.route_web_socket('**/*',lambda ws:ws.close())
  page=await ctx.new_page(); page.on('console',lambda m:logs.append(m.text)); page.on('pageerror',lambda e:errors.append(str(e)))
  try:
   await page.goto(ORIGIN+'/canvas',wait_until='networkidle')
   await page.evaluate('''async key=>{
    window.q={c:await import('/src/stores/use-config-store.ts'),v:await import('/src/services/api/video.ts'),a:await import('/src/services/api/audio.ts'),p:await import('/src/services/api/model-plugin.ts'),b:await import('/src/services/api/channel-request.ts'),i:await import('/src/services/api/image.ts'),s:await import('/src/services/image-storage.ts'),f:await import('/src/services/file-storage.ts'),cs:await import('/src/stores/canvas/use-canvas-store.ts'),e:await import('/src/lib/canvas/canvas-export.ts'),l:await import('/src/lib/secret-redaction.ts')};
    q.key=key; q.config=(format='gemini',script)=>({...q.c.defaultConfig,model:'default::test',count:'1',baseUrl:'https://channel.invalid/prefix',apiKey:key,apiFormat:format,channels:[{...q.c.defaultConfig.channels[0],baseUrl:'https://channel.invalid/prefix',apiKey:key,apiFormat:format,models:[{name:'test',capability:'video',script}]}]});
    q.id=q.cs.useCanvasStore.getState().createProject('Repair isolated synthetic regression');
    q.nodes=[];q.add=(file,type)=>{q.nodes.push({id:'node-'+q.nodes.length,type,title:'synthetic',x:0,y:0,width:100,height:100,metadata:{...file,content:file.url}});q.cs.useCanvasStore.getState().updateProject(q.id,{nodes:q.nodes})};
    q.snapshot=async()=>{const db=await new Promise((ok,no)=>{const r=indexedDB.open('infinite-canvas');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});let result={};for(const name of [...db.objectStoreNames]){if(!['media_files','image_files'].includes(name))continue;const values=await new Promise(ok=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>ok(r.result)});result[name]=await Promise.all(values.map(async b=>({type:b.type,bytes:b.size,canary:(await b.text()).includes(q.key)})))}db.close();return result};
    // Run previous media/transport regressions through actual digest consent, never an unconsented early rejection.
    const trust=await import('/src/lib/executable-trust.ts');
    for(const [name,actions] of [['v',['createVideoGenerationTask','pollVideoGenerationTask']],['i',['requestGeneration']],['a',['requestAudioGeneration']]]) {
     const module=q[name];q[name]={...module};
     for(const action of actions)q[name][action]=async(...args)=>{for(const channel of args[0].channels)for(const model of channel.models)if(model.script)await trust.approveExecutable('model',model.script.trim(),async()=>true);return module[action](...args)};
    }
    const model=q.p;q.p={...model,runModelPlugin:async args=>{await trust.approveExecutable('model',args.script,async()=>true);return model.runModelPlugin(args)}};
   }''',KEY)
   async def check(name, ok):
    assert ok,name
    REPORT['checks'].append(name)
   name_probe = await page.evaluate('''()=>{
    q.c.useConfigStore.setState({config:q.c.defaultConfig,webdav:q.c.defaultWebdavSyncConfig});
    const before=JSON.stringify(q.c.useConfigStore.getState());
    const canary='unstored_browser_error_name_canary';
    const error=new Error('safe message');error.name=canary;
    const output=[],savedError=console.error,savedInfo=console.info;
    console.error=(...args)=>{output.push(args);savedError(...args)};
    console.info=(...args)=>{output.push(args);savedInfo(...args)};
    try{q.l.logError(error);q.l.logInfo({nested:[error]})}finally{console.error=savedError;console.info=savedInfo}
    const safeNames=['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError','AggregateError','AbortError','TimeoutError'];
    const controls=safeNames.map(name=>{const e=new Error('safe message');e.name=name;return q.l.redactLogValue(e)});
    return {unconfigured:!before.includes(canary),stateUnchanged:before===JSON.stringify(q.c.useConfigStore.getState()),inputUnchanged:error.name===canary,output,direct:q.l.redactLogValue(error),controls,safeNames};
   }''')
   REPORT['unconfigured_error_name']=name_probe
   await check('unknown Error.name only canary absent from unconfigured direct and real browser console output',name_probe['unconfigured'] and 'unstored_browser_error_name_canary' not in json.dumps(name_probe) and all('unstored_browser_error_name_canary' not in line for line in logs))
   expected={'name':'Error','message':'safe message'}
   await check('unknown error name uses safe fixed name and preserves message in error/info nested logs',name_probe['direct']==expected and name_probe['output']==[[expected],[{'nested':[expected]}]])
   await check('known error names messages settings and original error remain intact',name_probe['stateUnchanged'] and name_probe['inputUnchanged'] and name_probe['controls']==[{'name':n,'message':'safe message'} for n in name_probe['safeNames']])
   before=await page.evaluate('q.snapshot()')
   REPORT['negative_indexeddb_before']=before
   for variant in ['json','html','wrong-mime','comment','comment-preamble','fragment']:
    mode['value']=variant
    for op in ['native-video','template-video','native-audio','remote-image']:
     start=len(calls)
     reply=await page.evaluate('''async op=>{try{
      if(op==='native-video'){const state=await q.v.pollVideoGenerationTask(q.config(),{id:'operations/test',provider:'gemini',model:'default::test'});if(state.status==='completed')q.add(await q.v.storeGeneratedVideo(state.result),'video')}
      if(op==='template-video'){const c=q.config('gemini',q.p.getPluginTemplates().video[1].script);const t=await q.v.createVideoGenerationTask(c,'synthetic');const state=await q.v.pollVideoGenerationTask(c,t);if(state.status==='completed')q.add(await q.v.storeGeneratedVideo(state.result),'video')}
      if(op==='native-audio')q.add(await q.a.storeGeneratedAudio(await q.a.requestAudioGeneration(q.config('openai'),'synthetic')),'audio');
      if(op==='remote-image'){const images=await q.i.requestGeneration(q.config('openai'),'synthetic');q.add(await q.s.uploadImage(images[0].dataUrl),'image')}
      return {rejected:false};
     }catch(e){return {rejected:true,error:e.message}}}''',op)
     await check(variant+' '+op+' rejects without persistence',reply['rejected'] and KEY not in unquote(reply.get('error','')))
     REPORT['cases'].append({'variant':variant,'operation':op,**reply,'requests':len(calls)-start})
   mode['value']='fragment'
   forms=await page.evaluate(r'''async()=>{
    const rows=[],body='<div class="gateway-error"><h1>401 Unauthorized</h1><p>Header authentication unsupported; echo '+q.key+'</p></div>';
    for(const kind of ['image','audio','video'])for(const form of ['blob','record.blob','inline','url']){
     const type=kind==='image'?'image/png':kind==='audio'?'audio/mpeg':'video/mp4';
     const blob='new Blob(['+JSON.stringify(body)+'],{type:'+JSON.stringify(type)+'})';
     const path=kind==='image'?'/image.png':kind==='audio'?'/audio/media.mp4':'/media.mp4';
     const source=form==='blob'?blob:form==='record.blob'?'{blob:'+blob+'}':form==='inline'?JSON.stringify('data:'+type+';base64,'+btoa(body)):'{url:baseUrl+'+JSON.stringify(path)+'}';
     const c=q.config('openai','return '+source);let rejected=false,error='';
     try{
      if(kind==='image'){const images=await q.i.requestGeneration(c,'synthetic');q.add(await q.s.uploadImage(images[0].dataUrl),'image')}
      if(kind==='audio')q.add(await q.a.storeGeneratedAudio(await q.a.requestAudioGeneration(c,'synthetic')),'audio');
      if(kind==='video'){const task=await q.v.createVideoGenerationTask(c,'synthetic');const state=await q.v.pollVideoGenerationTask(c,task);if(state.status==='completed')q.add(await q.v.storeGeneratedVideo(state.result),'video')}
     }catch(e){rejected=true;error=e.message}
     rows.push({kind,form,rejected,error});
    }
    for(const kind of ['audio','video']){let rejected=false,error='';try{const blob=new Blob([body],{type:kind==='audio'?'audio/mpeg':'video/mp4'});q.add(kind==='audio'?await q.a.storeGeneratedAudio(blob):await q.v.storeGeneratedVideo({blob}),kind)}catch(e){rejected=true;error=e.message}rows.push({kind,form:'direct-storage',rejected,error})}
    return rows;
   }''')
   for row in forms:
    await check('fragment '+row['kind']+' '+row['form']+' API rejects before persistence',row['rejected'] and '渠道未返回有效媒体' in row['error'] and KEY not in unquote(row['error']))
   REPORT['all_return_forms']=forms
   mode['value']='image-script'
   native_images=await page.evaluate(r'''async()=>{
    const rows=[],body='<div class="gateway-error"><h1>401 Unauthorized</h1><p>Header authentication unsupported; echo '+q.key+'</p></div>';
    const original=window.fetch;
    window.fetch=async(input,init)=>{const url=input instanceof Request?input.url:String(input);if(!url.startsWith('https://channel.invalid/'))return original(input,init);if(url.endsWith('/fragment.png'))return new Response(body,{headers:{'Content-Type':'image/png'}});const source='data:image/png;base64,'+btoa(body);return Response.json(url.includes('generateContent')?{candidates:[{content:{parts:[q.imageRoute==='inline'?{inlineData:{data:btoa(body),mimeType:'image/png'}}:{fileData:{fileUri:q.imageRoute==='remote'?'https://channel.invalid/prefix/fragment.png':source,mimeType:'image/png'}}]}}]}:{data:[{url:q.imageRoute==='remote'?'https://channel.invalid/prefix/fragment.png':source}]})};
    try{for(const format of ['openai','gemini'])for(const route of ['inline','fileData','remote']){q.imageRoute=route;let rejected=false,error='';try{const images=await q.i.requestGeneration(q.config(format),'synthetic');q.add(await q.s.uploadImage(images[0].dataUrl),'image')}catch(e){rejected=true;error=e.message}rows.push({format,route,rejected,error})}}finally{window.fetch=original}
    return rows;
   }''')
   for row in native_images:
    await check('fragment native '+row['format']+' '+row['route']+' image rejects before persistence',row['rejected'] and '渠道未返回有效媒体' in row['error'] and KEY not in unquote(row['error']))
   REPORT['native_image_fragments']=native_images
   REPORT['negative_indexeddb_after']=await page.evaluate('q.snapshot()')
   await check('negative cases leave actual media/image IndexedDB unchanged',before==await page.evaluate('q.snapshot()'))
   metadata=await page.evaluate('''async()=>{await new Promise(r=>setTimeout(r,700));const {localForageStorage:s}=await import('/src/lib/localforage-storage.ts');return {nodes:q.nodes,persisted:await s.getItem('infinite-canvas:canvas_store'),configUnconfigured:!JSON.stringify(q.c.useConfigStore.getState()).includes(q.key)}}''')
   REPORT['negative_metadata']=metadata
   await check('negative actual project metadata nodes and unconfigured settings contain no selected key',metadata['nodes']==[] and bool(metadata['persisted']) and KEY not in metadata['persisted'] and metadata['configUnconfigured'])
   async def export(name):
    async with page.expect_download() as d:
     await page.evaluate("async name=>q.e.exportCanvasProjects(q.cs.useCanvasStore.getState().projects.filter(p=>p.id===q.id),name)",name)
    path=OUT/(name+'.zip'); await (await d.value).save_as(path)
    with ZipFile(path) as z:
     entries=z.namelist(); leaks=[n for n in entries if KEY.encode() in z.read(n) or KEY.encode() in z.read(n).lower()]
    await check(name+' actual project/media ZIP excludes selected key',not leaks)
    REPORT['exports'].append({'file':path.name,'entries':entries,'canary_entries':leaks})
   await export('negative-media')
   mode['value']='encoded-error'
   state=await page.evaluate("q.v.pollVideoGenerationTask(q.config(),{id:'operations/test',provider:'gemini',model:'default::test'})")
   await check('native failed-state percent key redacted with unconfigured selected context',state['status']=='failed' and KEY not in unquote(json.dumps(state)))
   for fmt in ['openai','gemini']:
    for variant in ['image-inline','image-file','image-remote','image-script','image-blob']:
     mode['value']=variant
     reply=await page.evaluate('''async({fmt,variant,png})=>{const source='data:image/png;name='+q.key+';base64,'+png;const script=variant==='image-script'?'return '+JSON.stringify(source):variant==='image-blob'?'return {blob:await (await fetch('+JSON.stringify(source)+')).blob()}':undefined;const images=await q.i.requestGeneration(q.config(fmt,script),'synthetic');const file=await q.s.uploadImage(images[0].dataUrl);q.add(file,'image');return {url:images[0].dataUrl,file}}''',{'fmt':fmt,'variant':variant,'png':PNG})
     await check(fmt+' '+variant+' valid PNG stored with normalized MIME',reply['url']=='data:image/png;base64,'+PNG and reply['file']['mimeType']=='image/png' and KEY not in json.dumps(reply))
   await export('normalized-images')
   mode['value']='valid'
   positive=await page.evaluate('''async()=>{let files=[];for(const script of [undefined,q.p.getPluginTemplates().video[1].script]){const c=q.config('gemini',script);const t=script?await q.v.createVideoGenerationTask(c,'synthetic'):{id:'operations/synthetic',provider:'gemini',model:'default::test'};const state=await q.v.pollVideoGenerationTask(c,t);const file=await q.v.storeGeneratedVideo(state.result);q.add(file,'video');files.push(file)}const audio=await q.a.storeGeneratedAudio(await q.a.requestAudioGeneration(q.config('openai'),'synthetic'));q.add(audio,'audio');files.push(audio);return files}''')
   await check('decodable synthetic native/template video and audio save normally',len(positive)==3 and all(x['mimeType'] in ['video/mp4','audio/wav'] for x in positive) and KEY not in json.dumps(positive))
   start=len(calls)
   mutations=await page.evaluate('''async()=>{const results=[];for(const options of [{params:{key:q.key}},{baseURL:'https://attacker.invalid',allowAbsoluteUrls:false},{params:{ok:1},paramsSerializer:()=>'%61pi_key='+q.key}]){try{await q.b.channelAxios(q.config(),'models',{headers:{Authorization:'Bearer '+q.key},...options});results.push(false)}catch{results.push(true)}}return results}''')
   await check('browser final Axios query/origin/serializer rejection is zero transport',mutations==[True]*3 and len(calls)==start)
   redirects=[]
   for destination in ['https://channel.invalid/second','https://second.invalid/second','http://channel.invalid/second']:
    for operation in ['helper','raw','discovery','image','audio','text','gemini-native','gemini-template','gemini-native-media','gemini-template-media','webdav']:
     start=len(calls);mode['redirect']=destination;mode['media_only']=operation.endswith('-media')
     reply=await page.evaluate("""async op=>{const c=q.config('openai');try{
      if(op==='helper')await q.p.runModelPlugin({config:c,capability:'text',script:"return http.get('/redirect')"});
      if(op==='raw')await q.p.runModelPlugin({config:c,capability:'text',script:"return request({url:'/redirect',headers:{Authorization:'Bearer '+apiKey}})"});
      if(op==='discovery')await q.i.fetchImageModels(c);
      if(op==='image')await q.i.requestGeneration(c,'synthetic');
      if(op==='audio')await q.a.requestAudioGeneration(c,'synthetic');
      if(op==='text')await q.i.requestImageQuestion(c,[],()=>{});
      if(op.startsWith('gemini-native'))await q.v.pollVideoGenerationTask(q.config(),{id:'operations/synthetic',provider:'gemini',model:c.model});
      if(op.startsWith('gemini-template'))await q.p.runModelPlugin({config:q.config(),capability:'video',script:q.p.getPluginTemplates().video[1].script});
      if(op==='webdav'){const d=await import('/src/services/webdav-sync.ts');await d.testWebdavConnection({url:'https://dav.invalid/root',directory:'',username:'synthetic-dav-user',password:'synthetic-dav-password'})}
      return {rejected:false};}catch(e){return {rejected:true,message:e.message}}}""",operation)
     actual=[c for c in calls[start:] if c['method']!='OPTIONS']
     expected=2 if operation=='gemini-native-media' else 3 if operation=='gemini-template-media' else 1
     await check('real redirect refusal '+operation+' '+destination,reply['rejected'] and len(actual)==expected and all('/second' not in c['url'] for c in calls[start:]))
     redirects.append({'operation':operation,'destination':destination,'first_requests':len(actual),'second_requests':0})
   mode['redirect']=None;mode['media_only']=False;REPORT['redirect_cases']=redirects
   dav=await page.evaluate("async()=>{const d=await import('/src/services/webdav-sync.ts');await d.testWebdavConnection({url:'https://dav.invalid/root',directory:'',username:'synthetic-dav-user',password:'synthetic-dav-password'});return true}")
   await check('manual HTTPS WebDAV positive still uses direct Basic header authentication',dav and any(c['headers'].get('authorization','').startswith('Basic ') for c in calls if urlsplit(c['url']).hostname=='dav.invalid'))
   await page.evaluate('''async unknown=>{q.c.useConfigStore.setState({config:q.config()});const e=new Error('ordinary %72'+q.key.slice(1));e.name=q.key;q.l.logError(e, 'https://channel.invalid/?%61pi_key=prefix%26'+unknown+'#%74oken='+unknown,{'x-goog-api-key':q.key,Authorization:'Bearer '+q.key});q.c.useConfigStore.setState({config:q.c.defaultConfig});try{await q.p.runModelPlugin({config:q.config(),capability:'text',script:"throw new Error('%72'+apiKey.slice(1))"})}catch(e){q.l.logError(e)}}''',UNKNOWN)
   await check('real browser logger redacts Error.name encoded params and template selected context',all(KEY not in unquote(line) and UNKNOWN not in unquote(line) for line in logs))
   await page.wait_for_timeout(700)
   persisted=await page.evaluate("async()=>{const {localForageStorage:s}=await import('/src/lib/localforage-storage.ts');return await s.getItem('infinite-canvas:canvas_store')}")
   await check('actual IndexedDB project metadata excludes selected key',bool(persisted) and KEY not in persisted)
   REPORT['indexeddb']=await page.evaluate('q.snapshot()')
   await check('actual saved media/image blobs and MIME contain no selected key',all(not b['canary'] and KEY not in b['type'] for blobs in REPORT['indexeddb'].values() for b in blobs))
   await export('valid-media-and-images')
   REPORT.update(calls=calls,blocked_non_test_requests=blocked,console=logs,page_errors=errors,companion_proxy_requests=len([c for c in calls if urlsplit(c['url']).hostname in ['localhost','127.0.0.1']]),second_requests=len([c for c in calls if '/second' in c['url']]))
   await check('no companion/proxy or redirect followups',REPORT['companion_proxy_requests']==0 and REPORT['second_requests']==0)
   await check('no key-bearing outbound URLs',all(KEY not in c['url'] for c in calls))
   await check('no browser page errors',not errors)
   await page.screenshot(path=str(OUT/'repair-browser.png'),full_page=True)
  finally:
   await ctx.close(); await browser.close()

try: asyncio.run(main())
except Exception as e: REPORT['failure']=str(e); raise
finally:
 (OUT/'repair-browser.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2))
 print(json.dumps({'checks':len(REPORT['checks']),'cases':len(REPORT['cases']),'exports':len(REPORT['exports']),'failure':REPORT.get('failure')},indent=2))
