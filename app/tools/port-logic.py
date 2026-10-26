"""Port the design's logic class (design/design-logic.reference.js) into web/src/App.jsx.

The design logic is kept almost verbatim so the UI behaves exactly like the prototype;
only the data sources (mock arrays) and side effects (calls, audio, uploads) are swapped
for the real API. Run: python3 tools/port-logic.py
"""
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'web/design/design-logic.reference.js').read_text(encoding='utf-8')
src = src.replace('</script>', '')

def sub(old, new, count=1, regex=False):
    global src
    if regex:
        src2, n = re.subn(old, new, src, count=count, flags=re.S)
    else:
        n = src.count(old)
        src2 = src.replace(old, new) if count == 0 else src.replace(old, new, count)
    if n == 0:
        raise SystemExit('pattern not found: ' + old[:90])
    src = src2

# --- data that now comes from the server ---
sub(r"const TODAY='1405/07/15';\nconst DATES=.*?\n", "", regex=True)
sub(r"const OPS=\[.*?\];\nconst QUEUES=\[.*?\];\nconst NAMES=\[.*?\];\n", "", regex=True)
sub(r"\nfunction build\(\)\{.*?\n\}\n(?=\nconst GL=|const GL=)", "\n", regex=True)
for name in ['ROUTES0', 'TG0', 'HOL0', 'TC0', 'RG0', 'BL0', 'EXT0', 'TR0', 'QU0', 'SND0', 'IVR0']:
    sub(r"const %s=\[.*?\];\n(?=const |\n)" % name, "const %s=[];\n" % name, regex=True)
sub(r"const FM0=\{.*?\};\n(?=const )", "const FM0={};\n", regex=True)
sub("const CF0={from:'1405/07/01'", "const CF0={from:MONTH_START")
sub("const F0={q:'',from:'1405/07/01'", "const F0={q:'',from:MONTH_START")
sub("const R0={from:'1405/07/01'", "const R0={from:MONTH_START")

# --- class shell ---
sub("class Component extends DCLogic {\n calls=build();", "export default class App extends React.Component {\n calls=[];")
sub("hDate:'1405/08/10'", "hDate:TODAY")
sub("const d=new Date();const wd=4;", "const d=new Date();const wd=jWeekday(d);")
sub("nowText:'چهارشنبه '+TODAY", "nowText:WD_NAMES[jWeekday(new Date())]+' '+TODAY")
sub("'نگار احمدی'", "ME.name", count=0)
sub("OPS[0].name", "ME.name", count=0)
sub("op:OPS[0],opName:ME.name,ext:OPS[0].ext", "op:{id:ME.id,name:ME.name,ext:ME.ext},opName:ME.name,ext:ME.ext")
sub("ext:OPS[0].ext,tel:", "ext:cs.ext||ME.ext||'—',tel:")
sub("const QD=[['امروز',TODAY,TODAY],['دیروز','1405/07/14','1405/07/14'],['۷ روز اخیر','1405/07/09',TODAY],['این ماه','1405/07/01',TODAY]];",
    "const QD=[['امروز',TODAY,TODAY],['دیروز',jAdd(-1),jAdd(-1)],['۷ روز اخیر',jAdd(-6),TODAY],['این ماه',MONTH_START,TODAY]];")
sub("dates:DATES,hours:HOURS,ops,queues:QUEUES,statuses,cats};",
    "dates:[],hours:HOURS,ops,queues:s.vqs.map(q=>q.name),statuses,cats,me:this.meVals(),todayLong:jLong(new Date())};")
# uploads go to the server (converted to 8kHz mono wav there)
sub(r"upload:e=>\{const file=e\.target\.files&&e\.target\.files\[0\];if\(!file\)return;.*?e\.target\.value='';\},",
    "upload:e=>{const file=e.target.files&&e.target.files[0];if(!file)return;this.uploadSound(file,s.sndCat==='all'?'greet':s.sndCat);e.target.value='';},", regex=True)
# trunk test runs a real OPTIONS qualify on the server
sub(r"test:\(\)=>\{this\.setState\(st=>\(\{trTest:\{\.\.\.st\.trTest,\[t\.id\]:'در حال تست اتصال…'\}\}\)\);setTimeout\(.*?,1200\);\}",
    "test:()=>this.testTrunk(t)", regex=True)
# new trunks carry credentials/codec, new extensions get a secure SIP secret on the server
sub("upd('trunks',l=>[...l,{id:'t'+Date.now(),name:fm.name,prov:fm.prov||'—',type:'SIP',host:fm.host||'—',did:fm.did||'—',used:0,ch:+fm.ch||8,codec:'G.711',on:true,reg:false}]);",
    "upd('trunks',l=>[...l,{id:'t'+Date.now(),name:fm.name,prov:fm.prov||'—',type:'SIP',host:fm.host||'—',did:fm.did||'—',used:0,ch:+fm.ch||8,codec:fm.codec||'ulaw,alaw',user:fm.user||'',pass:fm.pass||'',on:true,reg:false}]);")
sub("['n','name','type','q','prov','host','ch','did','num','strat']", "['n','name','type','q','prov','host','ch','did','num','strat','user','pass','codec']")
sub("rows:ex.map(e=>({...e,stO:EXST[e.st],", "rows:ex.map(e=>({...e,stO:EXST[e.st]||EXST.offline,secretText:s.showSecret===e.n?'SIP: '+(e.secret||'—'):'رمز SIP: ••••••',revealSecret:()=>set({showSecret:s.showSecret===e.n?null:e.n}),")
sub("dot:EXST[e.st].dot", "dot:(EXST[e.st]||EXST.offline).dot", count=0)
# reports: patients' call file link + real player/audio
sub("download:()=>{}}:{show:false};", "download:()=>this.download(pc)}:{show:false};")

# --- replace simulated side effects with real ones ---
def replace_method(name, body):
    global src
    m = re.search(r"\n %s\(.*?\n(?= [a-zA-Z]+\(|\n\}\n?$| async )" % re.escape(name), src, flags=re.S)
    if not m:
        raise SystemExit('method not found: ' + name)
    src = src[:m.start()] + '\n' + body.rstrip('\n') + '\n' + src[m.end():]

replace_method('componentDidMount', " componentDidMount(){this.init();}")
replace_method('componentWillUnmount', " componentWillUnmount(){this.teardown();}")
replace_method('play', " play(id){this.playCall(id);}")
replace_method('startCall', " startCall(p){this.originate(p);}")
m = re.search(r"\n async connect\(\)\{.*?\n(?= endCall)", src, flags=re.S)
src = src[:m.start()] + "\n connect(){}\n" + src[m.end():]
replace_method('endCall', " endCall(ans){this.hangupCall(ans);}")
replace_method('playSnd', " playSnd(x){this.playSound(x);}")

sub("const vms=C.filter(c=>c.st==='voicemail');const AI=C.filter(c=>c.ai);",
    "const vms=C.filter(c=>c.st==='voicemail'&&this.deptOk(c,s));const AI=C.filter(c=>c.ai&&!c.ai.pending);")
i = src.index('  // player'); j = src.index('  return {...this.voip(s)')
src = src[:i] + src[i:j].replace('pc.dur', '(this.audDur||pc.dur)') + src[j:]
sub("const sameP=sel&&sel.known?C.filter(c=>c.phone===sel.phone):[sel];", "const sameP=sel&&sel.known?C.filter(c=>c.phone===sel.phone):(sel?[sel]:[]);")
# --- migration features: announcements, IVR/queue options, outbound routes, trunk DTMF
sub("{id:'vm',label:'صندوق پیام صوتی'}", "...s.snds.map(x=>({id:'ann:'+x.id,label:'پخش پیام «'+x.name+'» و قطع'})),{id:'vm',label:'صندوق پیام صوتی'}")
sub("setTo:e=>ui('timeout',+e.target.value||0),",
    "setTo:e=>ui('timeout',Math.max(1,+e.target.value||1)),setRep:e=>ui('rep',Math.max(0,+e.target.value||0)),setTdest:e=>ui('tdest',e.target.value),setIdest:e=>ui('idest',e.target.value),setDdial:e=>ui('ddial',e.target.value==='1'),ddialV:iv&&iv.ddial?'1':'0',")
sub("has:!!iv,sel:iv||{},", "has:!!iv,sel:iv?{rep:1,tdest:'vm',idest:'vm',...iv}:{},")
sub("setWait:e=>u('maxWait',+e.target.value||0),",
    "setWait:e=>u('maxWait',Math.max(0,+e.target.value||0)),setRing:e=>u('ring',Math.max(5,+e.target.value||20)),setRiu:e=>u('riu',e.target.value==='1'),setFail:e=>u('fail',e.target.value),ringV:q.ring||20,riuV:q.riu?'1':'0',failV:q.fail||'vm',maxWaitText:+q.maxWait?q.maxWait+' ث':'بی‌نهایت',")
sub("strats:Object.keys(STRAT).map(k=>({id:k,label:STRAT[k]})),sounds:sndOpts,", "strats:Object.keys(STRAT).map(k=>({id:k,label:STRAT[k]})),sounds:sndOpts,dests:this.mkDests(s),")
sub("user:fm.user||'',pass:fm.pass||'',on:true", "user:fm.user||'',pass:fm.pass||'',dtmf:fm.dtmf||'rfc4733',on:true")
sub("'user','pass','codec']", "'user','pass','codec','dtmf']")
sub("vroute:nv('vroute',s.routes.length),", "vroute:nv('vroute',s.routes.length),vout:nv('vout',(s.oroutes||[]).length),")
sub("['vext','vtrunk','vqueue','vivr','vsound','vroute','vtime','vring','vfollow','vblack'].includes(s.page)", "['vext','vtrunk','vqueue','vivr','vsound','vroute','vout','vtime','vring','vfollow','vblack'].includes(s.page)")
sub("'vring','vfollow','vblack','file'].forEach", "'vring','vfollow','vblack','vout','file'].forEach")
sub("return {...this.voip(s),...this.voip2(s),", "return {...this.voip(s),...this.voip2(s),...this.voipOut(s),")
# --- extension SIP password editing (server applies it on save)
sub("revealSecret:()=>set({showSecret:s.showSecret===e.n?null:e.n}),",
    "revealSecret:()=>set({showSecret:s.showSecret===e.n?null:e.n}),editing:!!s.pwEdit&&s.pwEdit.n===e.n,pwVal:s.pwEdit&&s.pwEdit.n===e.n?s.pwEdit.val:'',"
    "editPw:()=>set({pwEdit:{n:e.n,val:''}}),setPw:ev=>set({pwEdit:{n:e.n,val:ev.target.value}}),cancelPw:()=>set({pwEdit:null}),"
    "savePw:()=>{const v=(s.pwEdit&&s.pwEdit.val||'').trim();if(v.length<4||/[\\s;\"]/.test(v)){this.toast('رمز باید حداقل ۴ کاراکتر و بدون فاصله باشد');return;}"
    "upd('exts',l=>l.map(x=>x.n===e.n?{...x,newSecret:v}:x));set({pwEdit:null,showSecret:e.n});this.toast('رمز SIP داخلی '+e.n+' تغییر کرد؛ همین رمز را در گوشی وارد کنید');},")
# --- Excel export of inbound calls (all filtered, or every unanswered call in the date range)
sub("const ib={pick:{", "const ib={exportAll:()=>this.exportXlsx(ibl,'تماس‌های ورودی',f),exportMissed:()=>this.exportXlsx(C.filter(c=>c.dir==='in'&&(c.st==='missed'||c.st==='voicemail')&&c.date>=f.from&&c.date<=f.to&&qm(c,f.q)),'تماس‌های بی‌پاسخ',f),pick:{")
sub("const cl={pick:{", "const cl={exportAll:()=>this.exportXlsx(cf,'لیست تماس‌ها',cF),exportMissed:()=>this.exportXlsx(C.filter(c=>c.dir==='in'&&(c.st==='missed'||c.st==='voicemail')&&c.date>=cF.from&&c.date<=cF.to&&qm(c,s.cQ)),'تماس‌های بی‌پاسخ',cF),pick:{")
# --- report builder: styled Excel instead of CSV
sub(r"exportCsv:\(\)=>\{const h=\['شناسه'.*?a\.click\(\);\}\};",
    "exportCsv:()=>this.exportReport({title:'گزارش تماس‌ها بر اساس '+GL[r.group],groupLabel:GL[r.group],from:r.from,to:r.to,"
    "filters:[r.op!=='all'?'اپراتور: '+(r.op==='ivr'?'IVR / بدون اپراتور':((OPS.find(o=>o.id===r.op)||{}).name||r.op)):'',r.dir!=='all'?(r.dir==='in'?'فقط ورودی':'فقط خروجی'):'',r.st!=='all'?'وضعیت: '+ST[r.st].label:'',r.q?'جستجو: '+r.q:''],"
    "kpis:[{label:'کل تماس‌ها',value:ta.count},{label:'پاسخ‌داده',value:ta.answered},{label:'بی‌پاسخ',value:ta.missed},{label:'پیام صوتی',value:ta.voicemail},{label:'نرخ پاسخگویی',value:ta.rate+'%'},{label:'میانگین مکالمه',value:fmt(ta.avg)},{label:'میانگین انتظار',value:Math.round(ta.wait)+' ثانیه'}],"
    "headers:[GL[r.group],...selMet.map(x=>x.label)],rows:groups.map(g=>({key:g.k,cells:selMet.map(x=>x.f(g.a)),count:g.a.count})),totals:selMet.map(x=>x.f(ta)),total:ta.count,ids:rc.map(c=>c.id)})};", regex=True)
# --- "unanswered and never reached" (پیگیری‌نشده) filter + section
sub("const today=C.filter(c=>c.date===TODAY);", "const today=C.filter(c=>c.date===TODAY);const lastOk=this.contactIndex(C);const isUR=c=>c.dir==='in'&&(c.st==='missed'||c.st==='voicemail')&&/\\d{5,}/.test(c.phoneRaw)&&!((lastOk[c.phoneRaw]||'')>c.date+' '+c.time);")
sub("(cF.st==='all'||c.st===cF.st)", "(cF.st==='all'||(cF.st==='unreached'?isUR(c):c.st===cF.st))")
sub("(f.st==='all'||c.st===f.st)", "(f.st==='all'||(f.st==='unreached'?isUR(c):c.st===f.st))")
sub("if(f.st!=='all')chips.push({label:'وضعیت: '+ST[f.st].label", "if(f.st!=='all')chips.push({label:'وضعیت: '+(ST[f.st]||{label:'بی‌پاسخ بدون ارتباط'}).label")
sub("  // player", "  const urV=this.unreachedPage(C,isUR,lastOk);\n  // player")
sub("toast,nav,is,cl,", "toast,nav:{...nav,unreached:nv('unreached',urV.navCount)},is,ur:urV,cl,")
sub("'vblack','vout','file'].forEach", "'vblack','vout','unreached','file'].forEach")
# --- «تنظیمات API» page
sub("vout:nv('vout',(s.oroutes||[]).length),", "vout:nv('vout',(s.oroutes||[]).length),vapi:nv('vapi',''),")
sub("'vblack','vout','unreached','file'].forEach", "'vblack','vout','unreached','vapi','file'].forEach")
sub("...this.voipOut(s),", "...this.voipOut(s),...this.apiVals(s),")
# --- «بکاپ و بازیابی» page (VoIP menu)
sub("vapi:nv('vapi',''),", "vapi:nv('vapi',''),vbackup:nv('vbackup',(s.bk&&s.bk.items.filter(b=>b.status==='done').length)||''),")
sub("'vblack','vout','unreached','vapi','file'].forEach", "'vblack','vout','unreached','vapi','vbackup','file'].forEach")
sub("['vext','vtrunk','vqueue','vivr','vsound','vroute','vout','vtime','vring','vfollow','vblack'].includes(s.page)", "['vext','vtrunk','vqueue','vivr','vsound','vroute','vout','vtime','vring','vfollow','vblack','vbackup'].includes(s.page)")
sub("...this.apiVals(s),", "...this.apiVals(s),...this.backupVals(s),")
# --- settings hub («تنظیمات») + AI settings page; AI's own suggested action wins over the fixed one
sub("vapi:nv('vapi',''),", "vapi:nv('vapi',''),settings:nv('settings',''),")
sub("'vapi','vbackup','file'].forEach", "'vapi','vbackup','settings','vai','file'].forEach")
sub("...this.backupVals(s),", "...this.backupVals(s),...this.settingsVals(s),...this.aiSettingsVals(s),")
sub("sugg:sel?SUGG[sel.ai.cat.id]:''", "sugg:sel?(sel.ai.action||SUGG[sel.ai.cat.id]||''):''")
# --- post-call survey settings page + report labels from the settings
sub("'settings','vai','file'].forEach", "'settings','vai','vsurvey','file'].forEach")
sub("...this.aiSettingsVals(s),", "...this.aiSettingsVals(s),...this.surveyVals(s),")
sub("qs:QS.map((q,i)=>{const a=svl.length?svl.reduce((x,c)=>x+c.survey.answers[i],0)/svl.length:0;", "qs:this.svLabels(s).map((q,i)=>{const al=svl.filter(c=>c.survey.answers[i]!=null);const a=al.length?al.reduce((x,c)=>x+c.survey.answers[i],0)/al.length:0;")
sub("qText:QS.map((q,i)=>q+': '+c.survey.answers[i]).join(' · ')", "qText:this.svLabels(s).map((q,i)=>c.survey.answers[i]!=null?q+': '+c.survey.answers[i]:'').filter(Boolean).join(' · ')")
# --- survey voice comment (low score): text or a play button
sub("commentText:c.survey.comment||'بدون توضیح'", "...this.svComment(c)", count=0)
# --- patient system (CRM) settings page
sub("'settings','vai','vsurvey','file'].forEach", "'settings','vai','vsurvey','vcrm','file'].forEach")
sub("...this.surveyVals(s),", "...this.surveyVals(s),...this.crmVals(s),")
# --- AI receptionist as a destination everywhere (IVR keys, routes, time conditions…)
sub("{id:'vm',label:'صندوق پیام صوتی'},{id:'busy',label:'بوق اشغال'}", "{id:'ai',label:'دستیار هوشمند (AI)'},{id:'vm',label:'صندوق پیام صوتی'},{id:'busy',label:'بوق اشغال'}")
# --- AI receptionist settings page
sub("'settings','vai','vsurvey','vcrm','file'].forEach", "'settings','vai','vsurvey','vcrm','vagent','file'].forEach")
sub("...this.crmVals(s),", "...this.crmVals(s),...this.agentVals(s),")
# --- AI receptionist conversations: review page for the manager
sub("vapi:nv('vapi',''),settings:nv('settings',''),", "vapi:nv('vapi',''),settings:nv('settings',''),aiconv:nv('aiconv',C.filter(c=>c.queue==='دستیار هوشمند').length),")
sub("'settings','vai','vsurvey','vcrm','vagent','file'].forEach", "'settings','vai','vsurvey','vcrm','vagent','aiconv','file'].forEach")
sub("...this.agentVals(s),", "...this.agentVals(s),...this.aiConvVals(s),")
# --- «گزارش روزها»: even/odd weekdays, weeks, days, hours
sub("vapi:nv('vapi',''),settings:nv('settings',''),", "vapi:nv('vapi',''),settings:nv('settings',''),days:nv('days',''),")
sub("'settings','vai','vsurvey','vcrm','vagent','aiconv','file'].forEach", "'settings','vai','vsurvey','vcrm','vagent','aiconv','days','file'].forEach")
sub("...this.aiConvVals(s),", "...this.aiConvVals(s),...this.daysVals(s),")
# --- «تماس‌های زنده»: live calls + listen-only monitoring
sub("vapi:nv('vapi',''),settings:nv('settings',''),", "vapi:nv('vapi',''),settings:nv('settings',''),live:nv('live',(s.liveCalls||[]).length),")
sub("'settings','vai','vsurvey','vcrm','vagent','aiconv','days','file'].forEach", "'settings','vai','vsurvey','vcrm','vagent','aiconv','days','live','file'].forEach")
sub("...this.daysVals(s),", "...this.daysVals(s),...this.liveVals(s),")
# --- sidebar: both reports under one «گزارش‌ها» menu
sub("nav.voipBg=isV?'rgba(141,198,63,.12)':'transparent';", "nav.voipBg=isV?'rgba(141,198,63,.12)':'transparent';const isR=['reports','days'].includes(s.page);nav.repOpen=s.repOpen||isR;nav.toggleRep=()=>this.setState({repOpen:!(s.repOpen||isR)});nav.repChev=nav.repOpen?'rotate(180deg)':'none';nav.repBg=isR?'rgba(141,198,63,.12)':'transparent';")
# --- «وضعیت سرور»: resources, disk forecast, services, recommendations
sub("vapi:nv('vapi',''),settings:nv('settings',''),", "vapi:nv('vapi',''),settings:nv('settings',''),sys:nv('sys',''),")
sub("'settings','vai','vsurvey','vcrm','vagent','aiconv','days','live','file'].forEach", "'settings','vai','vsurvey','vcrm','vagent','aiconv','days','live','sys','file'].forEach")
sub("...this.liveVals(s),", "...this.liveVals(s),...this.sysVals(s),")
# --- call view: clicking a call shows recording, AI summary and the conversation as chat
sub("openFile:()=>this.openFile(c),isPlaying:pl,", "openFile:()=>this.openFile(c),openCall:()=>this.openCall(c),isPlaying:pl,")
sub("...this.sysVals(s),", "...this.sysVals(s),...this.callViewVals(s),")
# --- AI page: operator calls open the full call view (assessment, chat, player)
sub("isVm:c.st==='voicemail',openVm:", "isVm:c.st==='voicemail',isCallAi:c.st!=='voicemail',openVm:")
# --- «مصرف توکن»: AI tokens and cost per day, part and model
sub("vapi:nv('vapi',''),settings:nv('settings',''),", "vapi:nv('vapi',''),settings:nv('settings',''),usage:nv('usage',''),")
sub("'vagent','aiconv','days','live','sys','file'].forEach", "'vagent','aiconv','days','live','sys','usage','file'].forEach")
sub("...this.callViewVals(s),", "...this.callViewVals(s),...this.usageVals(s),")
# --- AI page: no NaN, search by phone / extension, pagination
sub("const ai={kpis:[{label:'ویس تحلیل‌شده',value:AI.length},{label:'اولویت فوری',value:AI.filter(c=>c.ai.urg==='high').length},{label:'احساس منفی',value:Math.round(sc.neg/AI.length*100)+'%'},{label:'میانگین دقت تبدیل',value:Math.round(AI.reduce((a,c)=>a+c.ai.conf,0)/AI.length)+'%'}],",
    "const confs=AI.map(c=>+c.ai.conf).filter(x=>isFinite(x)&&x>0);const ai={kpis:[{label:'مورد تحلیل‌شده',value:AI.length},{label:'اولویت فوری',value:AI.filter(c=>c.ai.urg==='high').length},{label:'احساس منفی',value:AI.length?Math.round(sc.neg/AI.length*100)+'%':'—'},{label:'میانگین دقت تبدیل',value:confs.length?Math.round(confs.reduce((a,x)=>a+x,0)/confs.length)+'%':'—'}],")
sub("const fa=AI.filter(c=>(s.aiCat==='all'||c.ai.cat.id===s.aiCat)&&(s.aiSent==='all'||c.ai.sent===s.aiSent));",
    "const aq=(s.aiQ||'').replace(/\\s/g,'');const fa=AI.filter(c=>(s.aiCat==='all'||c.ai.cat.id===s.aiCat)&&(s.aiSent==='all'||c.ai.sent===s.aiSent)&&(!aq||(c.phoneRaw||'').includes(aq.replace(/^\\+?98/,'0'))||(c.op&&String(c.op.ext)===aq)||(c.name||'').includes(s.aiQ.trim())));const aiPS=+s.aiPS||(()=>{try{return +localStorage.getItem('cc.aiPS')||24}catch(e){return 24}})(),aiPages=Math.max(1,Math.ceil(fa.length/aiPS)),aiPg=Math.min(s.aiPg||0,aiPages-1);")
sub("count:fa.length,items:fa.slice(0,24).map(c=>",
    "count:fa.length,q:s.aiQ||'',setQ:e=>this.setState({aiQ:e.target.value,aiPg:0}),pageText:'صفحه '+(aiPg+1).toLocaleString('fa-IR')+' از '+aiPages.toLocaleString('fa-IR'),hasPages:aiPages>1,prev:()=>this.setState({aiPg:Math.max(0,aiPg-1)}),next:()=>this.setState({aiPg:Math.min(aiPages-1,aiPg+1)}),prevOp:aiPg>0?1:.4,ps:String(aiPS),psOpts:[24,48,96,200,500].map(n=>({v:String(n),label:n.toLocaleString('fa-IR')+' مورد'})),setPS:e=>{const n=+e.target.value;try{localStorage.setItem('cc.aiPS',n)}catch(x){}this.setState({aiPS:n,aiPg:0})},nextOp:aiPg<aiPages-1?1:.4,items:fa.slice(aiPg*aiPS,aiPg*aiPS+aiPS).map(c=>")
# --- permissions: menus by section, users page
sub("vapi:nv('vapi',''),settings:nv('settings',''),", "vapi:nv('vapi',''),settings:nv('settings',''),users:nv('users',''),")
sub("'vagent','aiconv','days','live','sys','usage','file'].forEach", "'vagent','aiconv','days','live','sys','usage','users','file'].forEach")
sub("...this.usageVals(s),", "...this.usageVals(s),...this.canVals(s),...this.usersVals(s),...this.delVals(s),")
# --- call reports: count badge on rows, «گزارش‌های ثبت‌شده» page
sub("days:nv('days',''),", "days:nv('days',''),creports:nv('creports',''),")
sub("'vagent','aiconv','days','live','sys','usage','users','file'].forEach", "'vagent','aiconv','days','live','sys','usage','users','creports','file'].forEach")
sub("const isR=['reports','days'].includes(s.page);", "const isR=['reports','days','creports'].includes(s.page);")
sub("...this.delVals(s),", "...this.delVals(s),...this.creportsVals(s),")
# --- permanent delete of calls (list and report builder)
sub("...this.delVals(s),", "...this.delVals(s),...this.dialVals(s),")
sub("rowBg:cur?'#f7fbf1':'transparent'}};", "rowBg:cur?'#f7fbf1':'transparent',canDel:CAN('calls','delete'),onDel:()=>this.askDelete([c],'یک تماس')}};")
sub("const cl={exportAll:", "const cl={canDel:CAN('calls','delete'),del:()=>this.askDelete(cf,'لیست تماس‌ها با فیلترهای فعلی'),delText:'حذف '+cf.length.toLocaleString('fa-IR')+' تماس',exportAll:")
sub("const rp={pick:{", "const rp={canDel:CAN('calls','delete'),del:()=>this.askDelete(dl,r.drill?'گزارش‌ساز · '+GL[r.group]+': '+r.drill:'گزارش‌ساز · همه نتایج گزارش'),delText:'حذف '+dl.length.toLocaleString('fa-IR')+' تماس'+(r.drill?' ('+r.drill+')':''),pick:{")
sub("onDel:()=>this.askDelete([c],'یک تماس')}};", "onDel:()=>this.askDelete([c],'یک تماس'),hasRep:c.rep>0,repText:(c.rep||0).toLocaleString('fa-IR')+' گزارش',canRep:CAN('calls','edit'),onRep:()=>this.setState({cvId:c.id,crForm:{callId:c.id,editId:null,cat:'',outcome:'',text:'',fu:''}})}};")
# --- voice mailbox settings + redesigned voice messages page
sub("creports:nv('creports',''),", "creports:nv('creports',''),vvm:nv('vvm',''),")
sub("'vagent','aiconv','days','live','sys','usage','users','creports','file'].forEach", "'vagent','aiconv','days','live','sys','usage','users','creports','vvm','file'].forEach")
sub("...this.creportsVals(s),", "...this.creportsVals(s),...this.vmboxVals(s),...this.voiceboxVals(s),")
# --- caller card in the corner + CRM data in the patient file
sub("...this.vmboxVals(s),", "...this.vmboxVals(s),...this.popVals(s),...this.fileExtraVals(s,fl.length>0),")
# --- SMS: settings page, sent badge on call rows
sub("vvm:nv('vvm',''),", "vvm:nv('vvm',''),vsms:nv('vsms',''),")
sub("'vagent','aiconv','days','live','sys','usage','users','creports','vvm','file'].forEach", "'vagent','aiconv','days','live','sys','usage','users','creports','vvm','vsms','file'].forEach")
sub("...this.popVals(s),", "...this.popVals(s),...this.smsSettingsVals(s),")
sub("canRep:CAN('calls','edit'),", "canRep:CAN('calls','edit'),hasSms:(c.sms||[]).length>0,smsText:(c.sms||[]).length.toLocaleString('fa-IR')+' پیامک',smsTip:(c.sms||[]).map(x=>x.title).join('، '),")
head = (root / 'tools/app-head.js').read_text(encoding='utf-8')
src = src.replace("export default class App extends React.Component {", "export default class App extends LiveApp {")
(root / 'web/src/App.jsx').write_text(head + '\n' + src.strip() + '\n', encoding='utf-8')
print('App.jsx written', len(src))
