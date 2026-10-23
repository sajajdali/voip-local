const pad=n=>String(n).padStart(2,'0');
const fmt=s=>pad(Math.floor(s/60))+':'+pad(Math.floor(s%60));
const fmtH=t=>Math.floor(t/3600)+':'+pad(Math.floor(t%3600/60))+' ساعت';
const TODAY='1405/07/15';
const DATES=Array.from({length:15},(_,i)=>'1405/07/'+pad(i+1));
const OPS=[{id:'o1',name:'نگار احمدی',ext:'201'},{id:'o2',name:'زهرا موسوی',ext:'202'},{id:'o3',name:'الهام رستمی',ext:'203'},{id:'o4',name:'مهسا نوری',ext:'204'},{id:'o5',name:'سمیرا بهرامی',ext:'205'}];
const QUEUES=['پذیرش','مشاوره جراحی','پیگیری بعد از عمل','امور مالی'];
const NAMES=['مریم رضایی','امیرحسین محمدی','سارا کریمی','علی اکبری','نازنین حسینی','فاطمه جعفری','رضا قاسمی','الناز صادقی','محمد طاهری','شیما رحیمی','پریسا کاظمی','حمید نظری','نگین یوسفی','کیان مرادی','هانیه عباسی','سپیده فرهادی','مهدی شریفی','آیدا کرمانی','بهاره اصفهانی','یاسمن زارعی'];
const ST={answered:{label:'پاسخ‌داده',fg:'#3d6a0c',bg:'#eaf4dc'},missed:{label:'بی‌پاسخ',fg:'#b42318',bg:'#fdeceb'},voicemail:{label:'پیام صوتی',fg:'#1d5a85',bg:'#e5eff7'},transferred:{label:'انتقال‌یافته',fg:'#6a4b9c',bg:'#f0ebf8'}};
const HIST={answered:'تماس پاسخ داده شد',missed:'تماس بی‌پاسخ',voicemail:'پیام صوتی ثبت شد',transferred:'انتقال به داخلی دیگر'};
const CATS=[
{id:'postop',name:'پیگیری بعد از جراحی',fg:'#3d6a0c',bg:'#eaf4dc',bar:'#8DC63F',items:[
 {t:'سلام وقت بخیر. من بعد از جراحی که هفته قبل داشتم از دیشب کمی درد و ورم دارم و می‌خواستم بدونم طبیعی هست یا نیاز هست امروز برای ویزیت مراجعه کنم. لطفاً با من تماس بگیرید.',s:['گزارش درد و ورم از شب گذشته','سؤال درباره نیاز به مراجعه حضوری','درخواست تماس از طرف پشتیبانی'],k:['درد','ورم','ویزیت'],u:'high'},
 {t:'سلام، ده روز از عملم گذشته و می‌خواستم بپرسم کی می‌تونم چسب بینی رو بردارم و برای کشیدن بخیه باید چه روزی بیام.',s:['سؤال درباره برداشتن چسب بینی','هماهنگی زمان کشیدن بخیه'],k:['چسب بینی','بخیه','بعد از عمل'],u:'mid'}]},
{id:'book',name:'درخواست نوبت',fg:'#1d5a85',bg:'#e5eff7',bar:'#5b9bd0',items:[
 {t:'سلام، برای مشاوره جراحی بینی می‌خواستم نوبت بگیرم. اگه امکانش هست برای هفته آینده یه وقت بهم بدید. ممنون.',s:['درخواست نوبت مشاوره جراحی بینی','ترجیح زمانی: هفته آینده'],k:['نوبت','مشاوره','رینوپلاستی'],u:'low'},
 {t:'وقتتون بخیر، از طریق سایت نتونستم نوبت ثبت کنم، خطا می‌داد. لطفاً برای ثبت نوبت ویزیت باهام تماس بگیرید.',s:['مشکل در ثبت نوبت آنلاین','درخواست ثبت نوبت تلفنی'],k:['سایت','نوبت','خطا'],u:'mid'}]},
{id:'cost',name:'سؤال درباره هزینه',fg:'#8a5a00',bg:'#fbf1dc',bar:'#e0a83a',items:[
 {t:'سلام، می‌خواستم هزینه جراحی بینی و شرایط پرداخت اقساطی رو بدونم. ممنون می‌شم اطلاعات رو برام بفرستید.',s:['استعلام هزینه جراحی بینی','سؤال درباره پرداخت اقساطی'],k:['هزینه','اقساط','رینوپلاستی'],u:'low'}]},
{id:'consult',name:'مشاوره قبل از عمل',fg:'#0f6b63',bg:'#e2f3f1',bar:'#3fb3a6',items:[
 {t:'سلام، من سابقه انحراف تیغه بینی دارم و مشکل تنفسی دارم. می‌خواستم بدونم میشه همزمان جراحی زیبایی و درمانی انجام بشه؟',s:['سابقه انحراف تیغه بینی و مشکل تنفسی','سؤال درباره جراحی همزمان زیبایی و درمانی'],k:['انحراف','تنفس','سپتوپلاستی'],u:'mid'}]},
{id:'complaint',name:'شکایت / نارضایتی',fg:'#b42318',bg:'#fdeceb',bar:'#e0574a',items:[
 {t:'سلام، سه بار امروز تماس گرفتم و کسی جواب نداد. خیلی مهمه، لطفاً هرچه زودتر با من تماس بگیرید.',s:['چند تماس بی‌پاسخ در یک روز','نارضایتی از پاسخگویی','درخواست تماس فوری'],k:['بی‌پاسخ','فوری','ویزیت'],u:'high'}]},
{id:'cancel',name:'تغییر یا لغو نوبت',fg:'#6a4b9c',bg:'#f0ebf8',bar:'#9a7ccf',items:[
 {t:'سلام، من برای پنجشنبه نوبت داشتم ولی متأسفانه نمی‌تونم بیام. لطفاً نوبتم رو به هفته بعد منتقل کنید.',s:['درخواست جابه‌جایی نوبت پنجشنبه','زمان پیشنهادی: هفته بعد'],k:['جابه‌جایی','نوبت','پنجشنبه'],u:'low'}]}];
const SENT={pos:{label:'مثبت',fg:'#3d6a0c',bg:'#eaf4dc'},neu:{label:'خنثی',fg:'#55585c',bg:'#efefed'},neg:{label:'منفی',fg:'#b42318',bg:'#fdeceb'}};
const URG={high:{label:'فوری',fg:'#b42318',bg:'#fdeceb'},mid:{label:'متوسط',fg:'#8a5a00',bg:'#fbf1dc'},low:{label:'عادی',fg:'#55585c',bg:'#efefed'}};
const FOLLOW={new:{label:'جدید',fg:'#c2410c',bg:'#fdeee4'},follow:{label:'پیگیری',fg:'#1d5a85',bg:'#e5eff7'},done:{label:'انجام‌شده',fg:'#3d6a0c',bg:'#eaf4dc'}};
const QS=['برخورد اپراتور','پاسخ به سؤال','زمان انتظار'];
const COMMENTS=['خیلی با حوصله توضیح دادند، ممنون.','زمان انتظار کمی طولانی بود.','پاسخ کامل و دقیق بود.','اپراتور بسیار مؤدب بودند.','بار اول قطع شد ولی بعد پیگیری کردند.','','عالی بود.','','هنوز جواب سؤالم رو کامل نگرفتم.'];
const ini=n=>n==='شماره ناشناس'?'؟':n.split(' ').slice(0,2).map(w=>w[0]).join(' ');

function build(){
 let s=20251;const r=()=>(s=(s*16807)%2147483647)/2147483647;const pick=a=>a[Math.floor(r()*a.length)];
 const ph=()=>'09'+(10+Math.floor(r()*29))+' '+(100+Math.floor(r()*900))+' '+(1000+Math.floor(r()*9000));
 const pats=NAMES.map(n=>({name:n,phone:ph(),nid:(100+Math.floor(r()*900))+'•••••'+pad(Math.floor(r()*100)),surgery:'1405/0'+(5+Math.floor(r()*2))+'/'+pad(1+Math.floor(r()*28))}));
 const out=[];
 for(let i=0;i<170;i++){
  const day=Math.max(1,15-Math.floor(Math.pow(r(),1.6)*15));
  const hr=8+Math.floor(r()*12),mn=Math.floor(r()*60);
  const known=r()>.12;const p=known?pick(pats):{name:'شماره ناشناس',phone:ph(),nid:'—',surgery:'—'};
  const dir=r()<.8?'in':'out';const x=r();
  const st=dir==='in'?(x<.55?'answered':x<.73?'missed':x<.9?'voicemail':'transferred'):(x<.82?'answered':'missed');
  const op=st==='voicemail'?null:pick(OPS);
  const dur=st==='answered'||st==='transferred'?25+Math.floor(r()*560):st==='voicemail'?18+Math.floor(r()*60):0;
  const wait=3+Math.floor(r()*80);
  let ai=null;
  if(st==='voicemail'||(st==='answered'&&r()<.55)){const cat=pick(CATS);const it=pick(cat.items);const sv=r();
   const sent=cat.id==='complaint'?(sv<.8?'neg':'neu'):cat.id==='postop'?(sv<.35?'neg':sv<.8?'neu':'pos'):(sv<.15?'neg':sv<.55?'neu':'pos');
   ai={cat,tx:it.t,sum:it.s,kw:it.k,urg:it.u,sent,conf:82+Math.floor(r()*17)};}
  let survey=null;
  if(dir==='in'&&st==='answered'&&r()<.62){const base=r();const sc=()=>Math.max(1,Math.min(5,Math.round(base<.12?1+r()*2:3.6+r()*1.6)));const ans=QS.map(()=>sc());survey={answers:ans,score:Math.round(ans.reduce((a,b)=>a+b,0)/3*10)/10,comment:pick(COMMENTS)};}
  const follow=st==='voicemail'?(day===15?(r()<.6?'new':'follow'):(r()<.7?'done':'follow')):null;
  out.push({id:'C'+(4200+i),date:'1405/07/'+pad(day),time:pad(hr)+':'+pad(mn),name:p.name,phone:p.phone,phoneRaw:p.phone.replace(/\s/g,''),nid:p.nid,surgery:p.surgery,known,ini:ini(p.name),
   dir,dirLabel:dir==='in'?'ورودی':'خروجی',st,status:ST[st],histTitle:HIST[st],op,opName:op?op.name:'IVR',ext:op?op.ext:'—',queue:st==='voicemail'?'صندوق صوتی':pick(QUEUES),
   dur,durText:dur?fmt(dur):'—',wait,waitText:wait+' ثانیه',hasVoice:dur>0,noVoice:!dur,ai,hasAi:!!ai,noAi:!ai,aiName:ai?ai.cat.name:'',aiFg:ai?ai.cat.fg:'',aiBg:ai?ai.cat.bg:'',
   survey,follow,wave:Array.from({length:56},()=>6+Math.floor(r()*34))});
 }
 return out.sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
}

const GL={operator:'اپراتور',queue:'صف',date:'تاریخ',hour:'ساعت',status:'وضعیت',category:'دسته AI',direction:'جهت',phone:'شماره'};
const GK={operator:c=>c.opName,queue:c=>c.queue,date:c=>c.date,hour:c=>c.time.slice(0,2)+':00',status:c=>c.status.label,category:c=>c.ai?c.ai.cat.name:'بدون تحلیل',direction:c=>c.dirLabel,phone:c=>c.name+' ('+c.phone+')'};
const agg=l=>{const n=l.length,ans=l.filter(c=>c.st==='answered'||c.st==='transferred'),talk=ans.reduce((a,c)=>a+c.dur,0),sv=l.filter(c=>c.survey);
 return {count:n,answered:ans.length,missed:l.filter(c=>c.st==='missed').length,voicemail:l.filter(c=>c.st==='voicemail').length,rate:n?Math.round(ans.length/n*100):0,avg:ans.length?talk/ans.length:0,total:talk,wait:n?l.reduce((a,c)=>a+c.wait,0)/n:0,csat:sv.length?sv.reduce((a,c)=>a+c.survey.score,0)/sv.length:null}};
const MET=[{id:'count',label:'تعداد کل',f:a=>a.count},{id:'answered',label:'پاسخ‌داده',f:a=>a.answered},{id:'missed',label:'بی‌پاسخ',f:a=>a.missed},{id:'voicemail',label:'پیام صوتی',f:a=>a.voicemail},{id:'rate',label:'نرخ پاسخگویی',f:a=>a.rate+'%'},{id:'avg',label:'میانگین مکالمه',f:a=>fmt(a.avg)},{id:'total',label:'مجموع مکالمه',f:a=>fmtH(a.total)},{id:'wait',label:'میانگین انتظار',f:a=>Math.round(a.wait)+' ث'},{id:'csat',label:'میانگین رضایت',f:a=>a.csat==null?'—':a.csat.toFixed(1)}];
const HOURS=Array.from({length:13},(_,i)=>pad(8+i)+':00');
const REFS=[{id:'none',label:'بدون ارجاع',fg:'#55585c',bg:'#f4f5f1'},{id:'acc',label:'ارجاع به حسابداری',fg:'#8a5a00',bg:'#fbf1dc'},{id:'rec',label:'ارجاع به پذیرش',fg:'#1d5a85',bg:'#e5eff7'},{id:'emg',label:'ارجاع به پشتیبانی اضطراری',fg:'#b42318',bg:'#fdeceb'}];
const mkNote=n=>{const r=REFS.find(x=>x.id===n.ref)||REFS[0];return {...n,hasRef:r.id!=='none',refLabel:r.label,refBg:r.bg,refFg:r.fg,hasText:!!n.t};};
const CF0={from:'1405/07/01',to:TODAY,h1:'08:00',h2:'20:00',op:'all',queue:'all',st:'all',minDur:'0',cat:'all',sort:'new'};
const SUGG={postop:'تماس پرستار و هماهنگی ویزیت امروز',book:'ثبت نوبت مشاوره در سامانه نوبت‌دهی',cost:'ارسال تعرفه و شرایط پرداخت اقساطی',consult:'تعیین وقت مشاوره حضوری با دکتر',complaint:'تماس فوری سرپرست مرکز تماس',cancel:'جابه‌جایی نوبت در سامانه'};
const RECM={dontcare:'طبق تنظیمات داخلی',always:'ضبط همیشه',never:'بدون ضبط',ondemand:'ضبط با درخواست (*1)'};
const BLACT={hang:'قطع فوری تماس',busy:'پخش بوق اشغال',msg:'پخش پیام و قطع',vm:'انتقال به صندوق صوتی'};
const BLR={spam:{l:'تبلیغاتی / اسپم',fg:'#8a5a00',bg:'#fbf1dc'},harass:{l:'مزاحمت',fg:'#b42318',bg:'#fdeceb'},fraud:{l:'کلاهبرداری',fg:'#6a4b9c',bg:'#f0ebf8'},other:{l:'سایر',fg:'#55585c',bg:'#efefed'}};
const RGS={ringall:'زنگ همزمان همه',hunt:'به ترتیب (Hunt)',memoryhunt:'تجمعی (Memory Hunt)',firstavailable:'اولین داخلی آزاد',random:'تصادفی'};
const DAYS=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه'];
const ROUTES0=[{id:'r1',name:'خط اصلی کلینیک',did:'02188001234',cid:'',dest:'tc:tc1',prio:2,prefix:'',moh:'s2',rec:'always',alert:'',lang:'fa',fax:false,on:true},
{id:'r2',name:'بیماران ویژه (VIP)',did:'02188001234',cid:'0912111XXXX',dest:'rg:rg2',prio:1,prefix:'VIP: ',moh:'s2',rec:'always',alert:'<http://x>;info=vip',lang:'fa',fax:false,on:true},
{id:'r3',name:'خط مستقیم مشاوره جراحی',did:'02188001240',cid:'',dest:'q:q2',prio:3,prefix:'مشاوره: ',moh:'s2',rec:'always',alert:'',lang:'fa',fax:false,on:true},
{id:'r4',name:'خط پشتیبان آسیاتک',did:'02191002000',cid:'',dest:'ivr:i1',prio:4,prefix:'',moh:'s2',rec:'dontcare',alert:'',lang:'fa',fax:true,on:true},
{id:'r5',name:'پیش‌فرض (همه تماس‌ها)',did:'',cid:'',dest:'ivr:i1',prio:9,prefix:'',moh:'s2',rec:'dontcare',alert:'',lang:'fa',fax:false,on:true}];
const TG0=[{id:'g1',name:'ساعات کاری کلینیک',ranges:[{days:[0,1,2,3,4],from:'09:00',to:'20:00'},{days:[5],from:'09:00',to:'13:00'}]},{id:'g2',name:'ساعت ناهار',ranges:[{days:[0,1,2,3,4],from:'13:30',to:'14:30'}]}];
const HOL0=[{date:'1405/08/01',name:'تعطیلی داخلی کلینیک (سرویس تجهیزات)'},{date:'1405/11/22',name:'پیروزی انقلاب اسلامی'},{date:'1405/12/29',name:'ملی شدن صنعت نفت'},{date:'1406/01/01',name:'نوروز'},{date:'1406/01/02',name:'نوروز'},{date:'1406/01/03',name:'نوروز'},{date:'1406/01/04',name:'نوروز'},{date:'1406/01/12',name:'روز جمهوری اسلامی'},{date:'1406/01/13',name:'روز طبیعت'}];
const TC0=[{id:'tc1',name:'ساعت کاری - خط اصلی',group:'g1',open:'ivr:i1',closed:'ivr:i2',useHol:true,ovr:'none'},{id:'tc2',name:'ساعت ناهار - پذیرش',group:'g2',open:'vm',closed:'q:q1',useHol:false,ovr:'none'}];
const RG0=[{id:'rg1',num:'600',name:'پذیرش همه',strat:'ringall',members:['201','205','210'],ext:[],ring:20,prefix:'پذیرش: ',confirm:false,skipBusy:true,moh:'ring',na:'vm',rec:'always'},{id:'rg2',num:'601',name:'اورژانس پزشک',strat:'hunt',members:['210','201'],ext:['09121112233'],ring:25,prefix:'فوری: ',confirm:true,skipBusy:false,moh:'s2',na:'e:201',rec:'always'}];
const FM0={'210':{on:true,init:10,strat:'hunt',ring:20,list:['210','09121112233','201'],confirm:true,announce:true,na:'vm'},'202':{on:true,init:8,strat:'ringall',ring:25,list:['202','09351234567'],confirm:false,announce:false,na:'q:q2'}};
const BL0=[{num:'02144556677',reason:'spam',note:'تماس تبلیغاتی مکرر بیمه',date:'1405/07/02',by:'نگار احمدی',hits:14,today:3,last:'1405/07/15 · 10:12'},{num:'09350001122',reason:'harass',note:'تماس‌های مزاحم در ساعت شب',date:'1405/06/28',by:'زهرا موسوی',hits:9,today:1,last:'1405/07/15 · 08:41'},{num:'09011234567',reason:'fraud',note:'ادعای کاذب از طرف بانک',date:'1405/07/10',by:'نگار احمدی',hits:3,today:0,last:'1405/07/12 · 16:05'},{num:'02633445566',reason:'spam',note:'',date:'1405/05/14',by:'سمیرا بهرامی',hits:21,today:0,last:'1405/07/09 · 11:30'}];
const EXT0=[{n:'201',name:'نگار احمدی',type:'SIP',dev:'Yealink T31P',st:'online',rec:true,vm:true,q:'پذیرش'},{n:'202',name:'زهرا موسوی',type:'SIP',dev:'Yealink T31P',st:'busy',rec:true,vm:true,q:'مشاوره جراحی'},{n:'203',name:'الهام رستمی',type:'WebRTC',dev:'مرورگر',st:'online',rec:true,vm:false,q:'پیگیری بعد از عمل'},{n:'204',name:'مهسا نوری',type:'SIP',dev:'Grandstream GXP1610',st:'offline',rec:true,vm:true,q:'امور مالی'},{n:'205',name:'سمیرا بهرامی',type:'SIP',dev:'Yealink T33G',st:'online',rec:true,vm:true,q:'پذیرش'},{n:'210',name:'مطب دکتر افلاکی',type:'SIP',dev:'Yealink T46U',st:'online',rec:false,vm:true,q:'—'},{n:'211',name:'اتاق عمل',type:'SIP',dev:'Yealink T31P',st:'offline',rec:false,vm:false,q:'—'},{n:'220',name:'حسابداری',type:'WebRTC',dev:'مرورگر',st:'busy',rec:true,vm:true,q:'امور مالی'}];
const EXST={online:{label:'آنلاین',fg:'#3d6a0c',bg:'#eaf4dc',dot:'#8DC63F'},busy:{label:'در حال مکالمه',fg:'#8a5a00',bg:'#fbf1dc',dot:'#e0a83a'},offline:{label:'آفلاین',fg:'#55585c',bg:'#efefed',dot:'#b9bbb6'}};
const TR0=[{id:'t1',name:'مخابرات - خط اصلی',prov:'شرکت مخابرات',type:'SIP',host:'sip.tci.ir',did:'021-88001234',used:6,ch:10,codec:'G.711 / G.729',on:true,reg:true},{id:'t2',name:'خط پشتیبان ITSP',prov:'آسیاتک',type:'SIP',host:'voip.asiatech.ir',did:'021-91002000',used:2,ch:8,codec:'G.711',on:true,reg:true},{id:'t3',name:'خط PRI قدیمی',prov:'مخابرات',type:'PRI / E1',host:'—',did:'021-22334455',used:0,ch:30,codec:'—',on:false,reg:false}];
const QU0=[{id:'q1',name:'پذیرش',num:'500',strat:'ringall',members:['201','205'],maxWait:120,moh:'s2',waiting:3,sla:91},{id:'q2',name:'مشاوره جراحی',num:'501',strat:'leastrecent',members:['202','201'],maxWait:180,moh:'s2',waiting:1,sla:86},{id:'q3',name:'پیگیری بعد از عمل',num:'502',strat:'roundrobin',members:['203'],maxWait:90,moh:'s3',waiting:0,sla:95},{id:'q4',name:'امور مالی',num:'503',strat:'ringall',members:['204','220'],maxWait:240,moh:'s2',waiting:2,sla:78}];
const STRAT={ringall:'زنگ همزمان همه',leastrecent:'کم‌تماس‌ترین اپراتور',roundrobin:'نوبتی (چرخشی)',random:'تصادفی'};
const SND0=[{id:'s1',name:'خوشامدگویی اصلی',cat:'greet',dur:18,date:'1405/06/02',file:'welcome-main.wav'},{id:'s2',name:'موسیقی انتظار ملایم',cat:'moh',dur:184,date:'1405/05/20',file:'moh-soft.mp3'},{id:'s3',name:'اعلان صف پیگیری بعد از عمل',cat:'queue',dur:12,date:'1405/06/11',file:'q-postop.wav'},{id:'s4',name:'پیام خارج از ساعت کاری',cat:'after',dur:22,date:'1405/04/08',file:'after-hours.wav'},{id:'s5',name:'منوی اصلی IVR',cat:'ivr',dur:26,date:'1405/06/02',file:'ivr-main.wav'},{id:'s6',name:'پیام تعطیلات نوروز',cat:'after',dur:15,date:'1404/12/20',file:'nowruz.wav'},{id:'s7',name:'درخواست نظرسنجی پس از تماس',cat:'ivr',dur:14,date:'1405/03/15',file:'survey.wav'}];
const SCAT={greet:'خوشامدگویی',moh:'موسیقی انتظار',queue:'اعلان صف',after:'خارج از ساعت کاری',ivr:'منوی IVR'};
const IVR0=[{id:'i1',name:'منوی اصلی',did:'021-88001234',greet:'s5',after:'s4',hours:'شنبه تا پنجشنبه · 09:00 تا 20:00',timeout:8,opts:[{k:'1',label:'پذیرش و نوبت‌دهی',dest:'q:q1'},{k:'2',label:'مشاوره جراحی',dest:'q:q2'},{k:'3',label:'پیگیری بعد از عمل',dest:'q:q3'},{k:'4',label:'امور مالی',dest:'q:q4'},{k:'9',label:'ارسال پیام صوتی',dest:'vm'},{k:'0',label:'اپراتور',dest:'e:201'}]},{id:'i2',name:'خارج از ساعت کاری',did:'021-88001234',greet:'s4',after:'s4',hours:'سایر ساعات و تعطیلات',timeout:5,opts:[{k:'1',label:'ارسال پیام صوتی',dest:'vm'},{k:'2',label:'پیگیری اورژانسی بیماران',dest:'e:210'}]}];
const F0={q:'',from:'1405/07/01',to:TODAY,op:'all',queue:'all',st:'all',minDur:'0',voice:false,cat:'all',sort:'new'};
const R0={from:'1405/07/01',to:TODAY,group:'operator',op:'all',dir:'all',st:'all',q:'',metrics:['count','answered','missed','rate','avg','csat'],drill:null};

class Component extends DCLogic {
 calls=build();
 state={page:'calls',pid:null,pos:0,paused:true,speed:1,cTab:'all',routes:ROUTES0,selRoute:'r1',testDid:'02188001234',testCid:'09121112233',tgroups:TG0,holidays:HOL0,tconds:TC0,hDate:'1405/08/10',hName:'',rgroups:RG0,rgIn:{},fmes:FM0,selFm:'210',fmIn:'',blist:BL0,bset:{anon:true,action:'hang',sound:'s4'},bf:{num:'',reason:'spam',note:''},bq:'',bulk:'',fileKey:null,prevPage:'calls',call:null,toast:null,recPlay:null,noteRef:'none',doneAt:{},exts:EXT0,trunks:TR0,vqs:QU0,ivrs:IVR0,snds:SND0,form:null,xq:'',selIvr:'i1',sndCat:'all',sndPlay:null,trTest:{},voipOpen:false,cQ:'',cPage:0,cF:{...CF0},vQ:'',vDate:'all',notes:{},noteText:'',f:{...F0},ibLimit:20,vTab:'all',vSel:null,follow:{},r:{...R0},sOp:'all',aiCat:'all',aiSent:'all'};
 componentDidMount(){this.t=setInterval(()=>{const s=this.state;if(s.pid&&!s.paused){const c=this.calls.find(x=>x.id===s.pid);const pos=s.pos+.2*s.speed;if(pos>=c.dur)this.setState({pos:c.dur,paused:true});else this.setState({pos});}},200);}
 componentWillUnmount(){clearInterval(this.t);}
 play(id){const s=this.state;const cc=this.calls.find(x=>x.id===id);if(cc&&cc.url){this.playUrl(cc);return;}if(this.recA){this.recA.pause();this.recA=null;this.setState({recPlay:null});}if(s.pid===id){const c=this.calls.find(x=>x.id===id);this.setState({paused:!s.paused,pos:s.pos>=c.dur?0:s.pos});}else this.setState({pid:id,pos:0,paused:false});}
 mkDests(s){return [...s.vqs.map(q=>({id:'q:'+q.id,label:'صف '+q.name+' ('+q.num+')'})),...s.rgroups.map(g=>({id:'rg:'+g.id,label:'گروه زنگ '+g.name+' ('+g.num+')'})),...s.ivrs.map(i=>({id:'ivr:'+i.id,label:'IVR: '+i.name})),...s.tconds.map(t=>({id:'tc:'+t.id,label:'شرط زمانی: '+t.name})),...s.exts.map(e=>({id:'e:'+e.n,label:'داخلی '+e.n+' – '+e.name})),{id:'vm',label:'صندوق پیام صوتی'},{id:'busy',label:'بوق اشغال'},{id:'hang',label:'قطع تماس'}];}
 toggleBl(num){const has=this.state.blist.some(b=>b.num===num);this.setState(st=>({blist:has?st.blist.filter(b=>b.num!==num):[{num,reason:'other',note:'افزوده‌شده از پرونده بیمار',date:TODAY,by:'نگار احمدی',hits:0,today:0,last:'—'},...st.blist]}));this.toast(has?'شماره از لیست سیاه حذف شد':'شماره به لیست سیاه اضافه شد');}
 tcState(s,t){const g=s.tgroups.find(x=>x.id===t.group);const d=new Date();const wd=4;const hm=pad(d.getHours())+':'+pad(d.getMinutes());const hol=t.useHol&&s.holidays.some(x=>x.date===TODAY);let inR=!!g&&g.ranges.some(r=>r.days.includes(wd)&&hm>=r.from&&hm<r.to);if(hol)inR=false;if(t.ovr==='open')inR=true;if(t.ovr==='closed')inR=false;return {inR,hol};}
 voip2(s){
  const set=o=>this.setState(o);const upd=(k,fn)=>this.setState(st=>({[k]:fn(st[k])}));const V=e=>e.target.value;
  const tg=on=>({bg:on?'#8DC63F':'#d9dad6',j:on?'flex-end':'flex-start'});
  const dests=this.mkDests(s);const dl=id=>(dests.find(d=>d.id===id)||{label:'—'}).label;
  const sounds=s.snds.map(x=>({id:x.id,name:x.name}));const recOpts=Object.entries(RECM).map(([id,label])=>({id,label}));
  const selS=on=>({bd:on?'#8DC63F':'#e7e8e3',bg:on?'#f7fbf1':'#fff'});
  // routes
  const score=r=>(r.did?2:0)+(r.cid?1:0);
  const rx=p=>{try{return new RegExp('^'+p.toUpperCase().replace(/[^0-9XNZ.]/g,'').replace(/\./g,'.*').replace(/X/g,'[0-9]').replace(/N/g,'[2-9]').replace(/Z/g,'[1-9]')+'$');}catch(e){return /^$/;}};
  const dg=x=>(x||'').replace(/\D/g,'');
  const matchR=(did,cid)=>s.routes.filter(r=>r.on&&(!r.did||r.did===dg(did))&&(!r.cid||rx(r.cid).test(dg(cid)))).sort((a,b)=>score(b)-score(a)||a.prio-b.prio)[0];
  const resolve=(dest,dep)=>{if(dest&&dest.startsWith('tc:')&&dep<4){const t=s.tconds.find(x=>'tc:'+x.id===dest);if(t){const st=this.tcState(s,t);return [{t:'شرط زمانی «'+t.name+'»: '+(st.inR?'داخل بازه':'خارج از بازه')+(st.hol?' (تعطیل)':'')},...resolve(st.inR?t.open:t.closed,dep+1)];}}return [{t:'مقصد نهایی: '+dl(dest),fin:true}];};
  const blHit=n=>{const d=dg(n);return d?s.blist.some(b=>b.num===d):s.bset.anon;};
  let steps;
  if(blHit(s.testCid))steps=[{t:dg(s.testCid)?'شماره تماس‌گیرنده در لیست سیاه است':'تماس ناشناس (بدون CallerID) مسدود است'},{t:'اقدام: '+BLACT[s.bset.action],fin:true,bad:true}];
  else{const m=matchR(s.testDid,s.testCid);steps=m?[{t:'مسیر منطبق: «'+m.name+'»'},...(m.prefix?[{t:'پیشوند نام: '+m.prefix}]:[]),{t:'ضبط: '+RECM[m.rec]},...resolve(m.dest,0)]:[{t:'هیچ مسیری منطبق نیست؛ تماس رد می‌شود',fin:true,bad:true}];}
  steps=steps.map((x,i)=>({...x,n:i+1,bg:x.bad?'#fdeceb':x.fin?'#8DC63F':'#fff',fg:x.bad?'#b42318':x.fin?'#1f2021':'#3a3b3d',bd:x.bad?'#f5c2bd':x.fin?'#8DC63F':'#e1e3dc',arrow:i<steps.length-1}));
  const rt=s.routes.find(r=>r.id===s.selRoute)||s.routes[0];
  const ur=(k,v)=>upd('routes',l=>l.map(x=>x.id===rt.id?{...x,[k]:v}:x));
  const SCL=['همه تماس‌ها (پیش‌فرض)','فقط CallerID','فقط DID','DID + CallerID'];
  const vr={testDid:s.testDid,testCid:s.testCid,setTestDid:e=>set({testDid:V(e)}),setTestCid:e=>set({testCid:V(e)}),steps,dests,sounds,recOpts,
   langs:[{id:'fa',label:'فارسی'},{id:'en',label:'English'},{id:'ar',label:'العربية'}],
   rows:[...s.routes].sort((a,b)=>score(b)-score(a)||a.prio-b.prio).map(r=>({...r,didText:r.did||'هر شماره',cidText:r.cid||'هر تماس‌گیرنده',destLabel:dl(r.dest),typeLabel:SCL[score(r)],select:()=>set({selRoute:r.id}),...selS(rt&&rt.id===r.id),onT:tg(r.on),tog:()=>upd('routes',l=>l.map(x=>x.id===r.id?{...x,on:!x.on}:x)),op:r.on?1:.55})),
   add:()=>{const id='r'+Date.now();upd('routes',l=>[...l,{id,name:'مسیر جدید',did:'',cid:'',dest:'ivr:i1',prio:l.length+1,prefix:'',moh:'s2',rec:'dontcare',alert:'',lang:'fa',fax:false,on:true}]);set({selRoute:id});},
   has:!!rt,sel:rt||{},set:Object.fromEntries(['name','did','cid','dest','prefix','moh','rec','alert','lang'].map(k=>[k,e=>ur(k,k==='did'?dg(V(e)):V(e))])),
   setPrio:e=>ur('prio',+V(e)||0),faxT:tg(rt&&rt.fax),togFax:()=>ur('fax',!rt.fax),onT:tg(rt&&rt.on),togOn:()=>ur('on',!rt.on),
   dup:()=>{const id='r'+Date.now();upd('routes',l=>[...l,{...rt,id,name:rt.name+' (کپی)'}]);set({selRoute:id});},
   del:()=>{upd('routes',l=>l.filter(x=>x.id!==rt.id));set({selRoute:null});this.toast('مسیر ورودی حذف شد');},
   save:()=>rt&&this.toast('مسیر «'+rt.name+'» ذخیره شد')};
  // time
  const DS=['ش','ی','د','س','چ','پ','ج'];
  const dayTxt=d=>{const a=[...d].sort((x,y)=>x-y);if(!a.length)return 'بدون روز';const c=a.every((v,i)=>!i||v===a[i-1]+1);return c&&a.length>2?DAYS[a[0]]+' تا '+DAYS[a[a.length-1]]:a.map(i=>DAYS[i]).join('، ');};
  const ug=(gid,fn)=>upd('tgroups',l=>l.map(x=>x.id===gid?fn(x):x));const nd=new Date();
  const vtm={nowText:'چهارشنبه '+TODAY+' · ساعت '+pad(nd.getHours())+':'+pad(nd.getMinutes()),dests,groupOpts:s.tgroups.map(g=>({id:g.id,name:g.name})),
   groups:s.tgroups.map(g=>{const used=s.tconds.filter(t=>t.group===g.id).map(t=>t.name);return {...g,setName:e=>{const v=V(e);ug(g.id,x=>({...x,name:v}));},usedText:used.length?'استفاده در: '+used.join('، '):'استفاده نشده',canDel:!used.length,del:()=>upd('tgroups',l=>l.filter(x=>x.id!==g.id)),
    addRange:()=>ug(g.id,x=>({...x,ranges:[...x.ranges,{days:[0,1,2,3,4],from:'09:00',to:'17:00'}]})),
    rr:g.ranges.map((r,ri)=>{const ux=o=>ug(g.id,x=>({...x,ranges:x.ranges.map((y,j)=>j===ri?{...y,...o}:y)}));return {...r,sum:dayTxt(r.days)+' · '+r.from+' تا '+r.to,setFrom:e=>ux({from:V(e)}),setTo:e=>ux({to:V(e)}),del:()=>ug(g.id,x=>({...x,ranges:x.ranges.filter((y,j)=>j!==ri)})),
     days:DS.map((l,di)=>{const on=r.days.includes(di);return {l,bg:on?'#2E2F31':'#fff',fg:on?'#fff':(di===6?'#b42318':'#55585c'),bd:on?'#2E2F31':'#e1e3dc',t:()=>ux({days:on?r.days.filter(z=>z!==di):[...r.days,di]})}})}})}}),
   addGroup:()=>upd('tgroups',l=>[...l,{id:'g'+Date.now(),name:'گروه زمانی جدید',ranges:[{days:[0,1,2,3,4],from:'09:00',to:'17:00'}]}]),
   hol:[...s.holidays].sort((a,b)=>a.date<b.date?-1:1).map(x=>({...x,op:x.date<TODAY?.45:1,tag:x.date===TODAY?'امروز':x.date<TODAY?'گذشته':'',hasTag:x.date<=TODAY,del:()=>upd('holidays',l=>l.filter(y=>!(y.date===x.date&&y.name===x.name)))})),
   holCount:s.holidays.filter(x=>x.date>=TODAY).length,hDate:s.hDate,pickH:v=>set({hDate:v}),hName:s.hName,setHName:e=>set({hName:V(e)}),
   addHol:()=>{if(!s.hDate||!s.hName.trim())return;upd('holidays',l=>[...l,{date:s.hDate,name:s.hName.trim()}]);set({hName:''});this.toast('تعطیلی '+s.hDate+' اضافه شد');},
   conds:s.tconds.map(t=>{const st=this.tcState(s,t);const u=(k,v)=>upd('tconds',l=>l.map(x=>x.id===t.id?{...x,[k]:v}:x));return {...t,
    stLabel:st.inR?'الان: داخل بازه':'الان: خارج از بازه',stBg:st.inR?'#eaf4dc':'#fdeceb',stFg:st.inR?'#3d6a0c':'#b42318',activeDest:dl(st.inR?t.open:t.closed),
    setName:e=>u('name',V(e)),setGroup:e=>u('group',V(e)),setOpen:e=>u('open',V(e)),setClosed:e=>u('closed',V(e)),holT:tg(t.useHol),togHol:()=>u('useHol',!t.useHol),
    ovr:[['none','خودکار'],['open','اجبار: داخل بازه'],['closed','اجبار: خارج بازه']].map(([id,l])=>({l,bg:t.ovr===id?'#2E2F31':'transparent',fg:t.ovr===id?'#fff':'#55585c',c:()=>u('ovr',id)})),
    del:()=>upd('tconds',l=>l.filter(x=>x.id!==t.id))}}),
   addCond:()=>upd('tconds',l=>[...l,{id:'tc'+Date.now(),name:'شرط زمانی جدید',group:s.tgroups[0]?s.tgroups[0].id:'',open:'ivr:i1',closed:'vm',useHol:true,ovr:'none'}])};
  // ring groups
  const vrg={strats:Object.entries(RGS).map(([id,label])=>({id,label})),dests,sounds,recOpts,
   add:()=>upd('rgroups',l=>[...l,{id:'rg'+Date.now(),num:String(Math.max(599,...l.map(x=>+x.num))+1),name:'گروه زنگ جدید',strat:'ringall',members:[],ext:[],ring:20,prefix:'',confirm:false,skipBusy:true,moh:'ring',na:'vm',rec:'dontcare'}]),
   cards:s.rgroups.map(g=>{const u=(k,v)=>upd('rgroups',l=>l.map(x=>x.id===g.id?{...x,[k]:v}:x));const inp=s.rgIn[g.id]||'';const n=g.members.length+g.ext.length;return {...g,
    setName:e=>u('name',V(e)),setNum:e=>u('num',V(e)),setStrat:e=>u('strat',V(e)),setRing:e=>u('ring',+V(e)||0),setPrefix:e=>u('prefix',V(e)),setMoh:e=>u('moh',V(e)),setNa:e=>u('na',V(e)),setRec:e=>u('rec',V(e)),
    sbT:tg(g.skipBusy),togSb:()=>u('skipBusy',!g.skipBusy),cfT:tg(g.confirm),togCf:()=>u('confirm',!g.confirm),memCount:n,
    flow:(g.strat==='ringall'?'زنگ همزمان '+n+' مقصد':RGS[g.strat]+' بین '+n+' مقصد')+' به مدت '+g.ring+' ثانیه ← در صورت عدم پاسخ: '+dl(g.na),
    chips:s.exts.map(e=>{const on=g.members.includes(e.n);return {n:e.n,name:e.name,bg:on?'#2E2F31':'#fff',fg:on?'#fff':'#55585c',bd:on?'#2E2F31':'#e1e3dc',dot:EXST[e.st].dot,toggle:()=>u('members',on?g.members.filter(x=>x!==e.n):[...g.members,e.n])}}),
    extl:g.ext.map(x=>({n:x,del:()=>u('ext',g.ext.filter(y=>y!==x))})),hasExt:g.ext.length>0,inp,
    setInp:e=>{const v=V(e);this.setState(st=>({rgIn:{...st.rgIn,[g.id]:v}}));},
    addExt:()=>{const d=dg(inp);if(d.length<4||g.ext.includes(d))return;u('ext',[...g.ext,d]);this.setState(st=>({rgIn:{...st.rgIn,[g.id]:''}}));},
    del:()=>upd('rgroups',l=>l.filter(x=>x.id!==g.id))}})};
  // follow me
  const fmOf=n=>s.fmes[n]||{on:false,init:8,strat:'hunt',ring:20,list:[n],confirm:false,announce:false,na:'vm'};
  const fsel=s.exts.find(e=>e.n===s.selFm)||s.exts[0];const fm=fsel?fmOf(fsel.n):{list:[]};
  const setFm=(n,k,v)=>this.setState(st=>({fmes:{...st.fmes,[n]:{...fmOf(n),...st.fmes[n],[k]:v}}}));const uf=(k,v)=>setFm(fsel.n,k,v);
  const lbl=n=>{const e=s.exts.find(x=>x.n===n);return e?'داخلی '+n+' – '+e.name:'شماره خارجی '+n;};
  const tl=[];let tt=0;
  if(fsel){tl.push({t:'زنگ اولیه داخلی '+fsel.n,a:tt,b:tt+fm.init});tt+=fm.init;
   if(fm.strat==='ringall'){tl.push({t:'همزمان: '+fm.list.join('، '),a:tt,b:tt+fm.ring});tt+=fm.ring;}else fm.list.forEach(n=>{tl.push({t:lbl(n),a:tt,b:tt+fm.ring});tt+=fm.ring;});}
  const vf={rows:s.exts.map(e=>{const f=fmOf(e.n);return {...e,onT:tg(f.on),tog:()=>setFm(e.n,'on',!f.on),sum:f.on?f.list.length+' مقصد · '+(f.strat==='ringall'?'همزمان':'به ترتیب'):'غیرفعال',sumFg:f.on?'#3d6a0c':'#8b8e89',select:()=>set({selFm:e.n,fmIn:''}),...selS(fsel&&fsel.n===e.n)}}),
   has:!!fsel,ext:fsel||{},f:fm,dests,onT:tg(fm.on),togOn:()=>uf('on',!fm.on),cfT:tg(fm.confirm),togCf:()=>uf('confirm',!fm.confirm),anT:tg(fm.announce),togAn:()=>uf('announce',!fm.announce),
   setInit:e=>uf('init',+V(e)||0),setRing:e=>uf('ring',+V(e)||0),setStrat:e=>uf('strat',V(e)),setNa:e=>uf('na',V(e)),
   list:fm.list.map((n,i)=>({n,label:lbl(n),idx:i+1,up:()=>{if(i>0){const l=[...fm.list];[l[i-1],l[i]]=[l[i],l[i-1]];uf('list',l);}},down:()=>{if(i<fm.list.length-1){const l=[...fm.list];[l[i+1],l[i]]=[l[i],l[i+1]];uf('list',l);}},del:()=>uf('list',fm.list.filter((x,j)=>j!==i))})),
   quick:s.exts.filter(e=>!fm.list.includes(e.n)).map(e=>({n:e.n,add:()=>uf('list',[...fm.list,e.n])})),
   fmIn:s.fmIn,setIn:e=>set({fmIn:V(e)}),addIn:()=>{const d=dg(s.fmIn);if(d.length<3||fm.list.includes(d))return;uf('list',[...fm.list,d]);set({fmIn:''});},
   tl:tl.map((x,i)=>({...x,range:x.a+' تا '+x.b+' ثانیه',idx:i+1})),naLabel:dl(fm.na),total:tt,save:()=>fsel&&this.toast('تنظیمات Follow Me داخلی '+fsel.n+' ذخیره شد')};
  // blacklist
  const bl=s.blist.filter(b=>!s.bq||b.num.includes(dg(s.bq)||'~')||(b.note||'').includes(s.bq));
  const vb={kpis:[{label:'شماره‌های مسدود',value:s.blist.length},{label:'تماس مسدودشده امروز',value:s.blist.reduce((a,b)=>a+b.today,0)},{label:'کل تماس‌های مسدودشده',value:s.blist.reduce((a,b)=>a+b.hits,0)},{label:'تماس‌های ناشناس',value:s.bset.anon?'مسدود':'مجاز'}],
   anonT:tg(s.bset.anon),togAnon:()=>set({bset:{...s.bset,anon:!s.bset.anon}}),action:s.bset.action,setAction:e=>set({bset:{...s.bset,action:V(e)}}),isMsg:s.bset.action==='msg',sound:s.bset.sound,setSound:e=>set({bset:{...s.bset,sound:V(e)}}),sounds,
   actions:Object.entries(BLACT).map(([id,label])=>({id,label})),reasons:Object.entries(BLR).map(([id,r])=>({id,label:r.l})),
   bf:s.bf,setNum:e=>set({bf:{...s.bf,num:V(e)}}),setReason:e=>set({bf:{...s.bf,reason:V(e)}}),setNote:e=>set({bf:{...s.bf,note:V(e)}}),
   add:()=>{const d=dg(s.bf.num);if(d.length<4){this.toast('شماره معتبر وارد کنید');return;}if(s.blist.some(b=>b.num===d)){this.toast('این شماره قبلاً در لیست سیاه است');return;}set({blist:[{num:d,reason:s.bf.reason,note:s.bf.note,date:TODAY,by:'نگار احمدی',hits:0,today:0,last:'—'},...s.blist],bf:{num:'',reason:s.bf.reason,note:''}});this.toast('شماره '+d+' مسدود شد');},
   bulk:s.bulk,setBulk:e=>set({bulk:V(e)}),importBulk:()=>{const nums=[...new Set(s.bulk.split(/[\s,،;]+/).map(dg).filter(x=>x.length>=4&&!s.blist.some(b=>b.num===x)))];if(!nums.length){this.toast('شماره جدیدی برای افزودن پیدا نشد');return;}set({blist:[...nums.map(n=>({num:n,reason:'other',note:'ورود گروهی',date:TODAY,by:'نگار احمدی',hits:0,today:0,last:'—'})),...s.blist],bulk:''});this.toast(nums.length+' شماره به لیست سیاه اضافه شد');},
   q:s.bq,setQ:e=>set({bq:V(e)}),count:bl.length,empty:!bl.length,
   stats:Object.entries(BLR).map(([id,r])=>({label:r.l,n:s.blist.filter(b=>b.reason===id).length,fg:r.fg,bg:r.bg})),
   rows:bl.map(b=>({...b,rl:BLR[b.reason].l,rFg:BLR[b.reason].fg,rBg:BLR[b.reason].bg,noteText:b.note||'—',setR:e=>{const v=V(e);upd('blist',l=>l.map(x=>x.num===b.num?{...x,reason:v}:x));},del:()=>{upd('blist',l=>l.filter(x=>x.num!==b.num));this.toast('شماره '+b.num+' از لیست سیاه حذف شد');}}))};
  return {vr,vtm,vrg,vf,vb};
 }
 toast(t){clearTimeout(this.toT);this.setState({toast:t});this.toT=setTimeout(()=>this.setState({toast:null}),3400);}
 openFile(c){this.setState(s=>({page:'file',fileKey:c.phoneRaw,prevPage:s.page==='file'?s.prevPage:s.page}));try{window.scrollTo(0,0);}catch(e){}}
 playUrl(c){if(this.recA){this.recA.pause();this.recA=null;}if(this.state.recPlay===c.id){this.setState({recPlay:null});return;}this.recA=new Audio(c.url);this.recA.play();this.recA.onended=()=>this.setState({recPlay:null});this.setState({recPlay:c.id,paused:true});}
 startCall(p){this.setState({call:{name:p.name,phone:p.phone,phoneRaw:p.phoneRaw,vmId:p.vmId||null,stage:'dial',t0:0,el:0,rec:false,recErr:'',note:''}});try{const a=document.createElement('a');a.href='tel:'+p.phoneRaw;a.style.display='none';document.body.appendChild(a);a.click();a.remove();}catch(e){}}
 async connect(){this.setState(s=>({call:{...s.call,stage:'live',t0:Date.now(),el:0}}));
  this.callT=setInterval(()=>this.setState(s=>s.call&&s.call.stage==='live'?{call:{...s.call,el:Math.floor((Date.now()-s.call.t0)/1000)}}:null),500);
  try{const st=await navigator.mediaDevices.getUserMedia({audio:true});this.stream=st;this.chunks=[];const mr=new MediaRecorder(st);this.mr=mr;mr.ondataavailable=e=>{if(e.data&&e.data.size)this.chunks.push(e.data);};mr.start();this.setState(s=>s.call?{call:{...s.call,rec:true}}:null);}
  catch(e){this.setState(s=>s.call?{call:{...s.call,recErr:'دسترسی به میکروفون داده نشد؛ ضبط از سمت مرکز تلفن انجام می‌شود.'}}:null);}}
 endCall(ans){clearInterval(this.callT);const c=this.state.call;if(!c)return;const dur=ans?Math.max(1,c.el):0;
  const fin=url=>{const base=this.calls.find(x=>x.phoneRaw===c.phoneRaw)||{};const st=ans?'answered':'missed';
   const rec={...base,id:'CB'+Date.now(),date:TODAY,time:new Date().toTimeString().slice(0,5),name:c.name,phone:c.phone,phoneRaw:c.phoneRaw,ini:ini(c.name),dir:'out',dirLabel:'خروجی',st,status:ST[st],histTitle:ans?'تماس برگشتی برقرار شد':'تماس برگشتی بی‌پاسخ',op:OPS[0],opName:OPS[0].name,ext:OPS[0].ext,queue:'پیگیری پیام صوتی',dur,durText:dur?fmt(dur):'—',wait:0,waitText:'0 ثانیه',hasVoice:dur>0,noVoice:!dur,ai:null,hasAi:false,noAi:true,aiName:'',aiFg:'',aiBg:'',survey:null,follow:null,wave:Array.from({length:56},()=>6+Math.floor(Math.random()*34)),url:url||null,callback:true,summary:(c.note||'').trim()};
   this.calls=[rec,...this.calls];
   const vmC=c.vmId?this.calls.find(x=>x.id===c.vmId):null;const cur=vmC?(this.state.follow[vmC.id]||vmC.follow):null;
   this.setState({call:null,follow:ans&&cur==='new'?{...this.state.follow,[vmC.id]:'follow'}:this.state.follow});
   this.toast(ans?'تماس با '+c.name+' ثبت شد'+(url?' و ضبط مکالمه ذخیره شد':''):'تماس بی‌پاسخ با '+c.name+' ثبت شد');};
  const mr=this.mr;if(mr&&mr.state!=='inactive'){mr.onstop=()=>{fin(this.chunks.length?URL.createObjectURL(new Blob(this.chunks,{type:mr.mimeType||'audio/webm'})):null);};mr.stop();}else fin(null);
  if(this.stream){this.stream.getTracks().forEach(t=>t.stop());this.stream=null;}this.mr=null;}
 playSnd(x){if(this.aud){this.aud.pause();this.aud=null;}clearTimeout(this.sndT);if(this.state.sndPlay===x.id){this.setState({sndPlay:null});return;}this.setState({sndPlay:x.id,paused:true});if(x.url){this.aud=new Audio(x.url);this.aud.play();this.aud.onended=()=>this.setState({sndPlay:null});}else this.sndT=setTimeout(()=>this.setState({sndPlay:null}),Math.min(x.dur,20)*1000);}
 voip(s){
  const set=o=>this.setState(o);const fm=s.form||{};
  const upd=(k,fn)=>this.setState(st=>({[k]:fn(st[k])}));
  const setFm=Object.fromEntries(['n','name','type','q','prov','host','ch','did','num','strat'].map(k=>[k,e=>{const v=e.target.value;this.setState(st=>({form:{...st.form,[k]:v}}));}]));
  const openF=(kind,d)=>()=>set({form:{kind,...d}});const cancel=()=>set({form:null});
  const tg=on=>({bg:on?'#8DC63F':'#d9dad6',j:on?'flex-end':'flex-start'});
  const sndOpts=s.snds.map(x=>({id:x.id,name:x.name}));
  const ex=s.exts.filter(e=>!s.xq||e.n.includes(s.xq)||e.name.includes(s.xq));const cnt=k=>s.exts.filter(e=>e.st===k).length;
  const vx={q:s.xq,setQ:e=>set({xq:e.target.value}),kpis:[{label:'کل داخلی‌ها',value:s.exts.length,dot:'#2E2F31'},{label:'آنلاین',value:cnt('online'),dot:'#8DC63F'},{label:'در حال مکالمه',value:cnt('busy'),dot:'#e0a83a'},{label:'آفلاین',value:cnt('offline'),dot:'#b9bbb6'}],
   formOpen:fm.kind==='ext',f:fm,set:setFm,cancel,add:openF('ext',{n:String(Math.max(200,...s.exts.map(e=>+e.n))+1),name:'',type:'SIP',q:'پذیرش'}),
   save:()=>{if(!fm.n||!fm.name)return;upd('exts',l=>[...l,{n:fm.n,name:fm.name,type:fm.type,dev:fm.type==='WebRTC'?'مرورگر':'تعریف نشده',st:'offline',rec:true,vm:true,q:fm.q}]);set({form:null});},
   rows:ex.map(e=>({...e,stO:EXST[e.st],ini:e.name.split(' ').slice(0,2).map(w=>w[0]).join(' '),recT:tg(e.rec),vmT:tg(e.vm),
    togRec:()=>upd('exts',l=>l.map(x=>x.n===e.n?{...x,rec:!x.rec}:x)),togVm:()=>upd('exts',l=>l.map(x=>x.n===e.n?{...x,vm:!x.vm}:x)),del:()=>upd('exts',l=>l.filter(x=>x.n!==e.n))}))};
  const vt={formOpen:fm.kind==='trunk',f:fm,set:setFm,cancel,add:openF('trunk',{name:'',prov:'',host:'',ch:'8',did:''}),
   save:()=>{if(!fm.name)return;upd('trunks',l=>[...l,{id:'t'+Date.now(),name:fm.name,prov:fm.prov||'—',type:'SIP',host:fm.host||'—',did:fm.did||'—',used:0,ch:+fm.ch||8,codec:'G.711',on:true,reg:false}]);set({form:null});},
   kpis:[{label:'ترانک فعال',value:s.trunks.filter(t=>t.on).length+' از '+s.trunks.length},{label:'کانال در حال استفاده',value:s.trunks.reduce((a,t)=>a+(t.on?t.used:0),0)},{label:'ظرفیت کل کانال',value:s.trunks.reduce((a,t)=>a+(t.on?t.ch:0),0)}],
   cards:s.trunks.map(t=>({...t,stO:!t.on?{label:'غیرفعال',fg:'#55585c',bg:'#efefed'}:t.reg?{label:'ثبت‌شده',fg:'#3d6a0c',bg:'#eaf4dc'}:{label:'در انتظار ثبت',fg:'#8a5a00',bg:'#fbf1dc'},w:(t.on?t.used/t.ch*100:0)+'%',chText:(t.on?t.used:0)+' / '+t.ch,onT:tg(t.on),
    tog:()=>upd('trunks',l=>l.map(x=>x.id===t.id?{...x,on:!x.on}:x)),del:()=>upd('trunks',l=>l.filter(x=>x.id!==t.id)),testText:s.trTest[t.id]||'',hasTest:!!s.trTest[t.id],
    test:()=>{this.setState(st=>({trTest:{...st.trTest,[t.id]:'در حال تست اتصال…'}}));setTimeout(()=>this.setState(st=>({trTest:{...st.trTest,[t.id]:t.on?'✓ اتصال موفق · تأخیر '+(18+Math.floor(Math.random()*30))+'ms':'✕ ترانک غیرفعال است'},trunks:st.trunks.map(x=>x.id===t.id&&x.on?{...x,reg:true}:x)})),1200);}}))};
  const vq={formOpen:fm.kind==='queue',f:fm,set:setFm,cancel,strats:Object.keys(STRAT).map(k=>({id:k,label:STRAT[k]})),sounds:sndOpts,
   add:openF('queue',{name:'',num:String(Math.max(499,...s.vqs.map(q=>+q.num))+1),strat:'ringall'}),
   save:()=>{if(!fm.name)return;upd('vqs',l=>[...l,{id:'q'+Date.now(),name:fm.name,num:fm.num,strat:fm.strat,members:[],maxWait:120,moh:'s2',waiting:0,sla:100}]);set({form:null});},
   cards:s.vqs.map(q=>{const u=(k,v)=>upd('vqs',l=>l.map(x=>x.id===q.id?{...x,[k]:v}:x));return {...q,memCount:q.members.length,setStrat:e=>u('strat',e.target.value),setMoh:e=>u('moh',e.target.value),setWait:e=>u('maxWait',+e.target.value||0),slaW:q.sla+'%',slaFg:q.sla>=90?'#3d6a0c':q.sla>=80?'#8a5a00':'#b42318',
    chips:s.exts.map(e=>{const on=q.members.includes(e.n);return {n:e.n,name:e.name,bg:on?'#2E2F31':'#fff',fg:on?'#fff':'#55585c',bd:on?'#2E2F31':'#e1e3dc',dot:EXST[e.st].dot,toggle:()=>u('members',on?q.members.filter(x=>x!==e.n):[...q.members,e.n])}}),
    del:()=>upd('vqs',l=>l.filter(x=>x.id!==q.id))}})};
  const dests=this.mkDests(s);
  const dl=id=>(dests.find(d=>d.id===id)||{label:'—'}).label;
  const iv=s.ivrs.find(i=>i.id===s.selIvr)||s.ivrs[0];
  const ui=(k,v)=>upd('ivrs',l=>l.map(x=>x.id===iv.id?{...x,[k]:v}:x));const KEYS='1234567890*#'.split('');
  const vi={list:s.ivrs.map(i=>({...i,optCount:i.opts.length,select:()=>set({selIvr:i.id}),bg:iv&&i.id===iv.id?'#f3f8ea':'#fff',bd:iv&&i.id===iv.id?'#8DC63F':'#e7e8e3'})),
   add:()=>{const id='i'+Date.now();upd('ivrs',l=>[...l,{id,name:'منوی جدید',did:'—',greet:'s5',after:'s4',hours:'شنبه تا پنجشنبه · 09:00 تا 20:00',timeout:6,opts:[{k:'1',label:'پذیرش',dest:'q:q1'}]}]);set({selIvr:id});},
   has:!!iv,sel:iv||{},dests,sounds:sndOpts,
   setName:e=>ui('name',e.target.value),setDid:e=>ui('did',e.target.value),setGreet:e=>ui('greet',e.target.value),setAfter:e=>ui('after',e.target.value),setHours:e=>ui('hours',e.target.value),setTo:e=>ui('timeout',+e.target.value||0),
   opts:iv?iv.opts.map((o,idx)=>({...o,destLabel:dl(o.dest),setLabel:e=>ui('opts',iv.opts.map((x,j)=>j===idx?{...x,label:e.target.value}:x)),setDest:e=>ui('opts',iv.opts.map((x,j)=>j===idx?{...x,dest:e.target.value}:x)),del:()=>ui('opts',iv.opts.filter((x,j)=>j!==idx))})):[],
   addOpt:()=>{const k=KEYS.find(k=>!iv.opts.some(o=>o.k===k));if(k)ui('opts',[...iv.opts,{k,label:'گزینه جدید',dest:'hang'}]);},
   greetName:iv?(s.snds.find(x=>x.id===iv.greet)||{name:'—'}).name:'',canDel:s.ivrs.length>1,del:()=>{upd('ivrs',l=>l.filter(x=>x.id!==iv.id));set({selIvr:null});}};
  const usedIn=x=>[...s.ivrs.filter(i=>i.greet===x.id||i.after===x.id).map(i=>'IVR '+i.name),...s.vqs.filter(q=>q.moh===x.id).map(q=>'صف '+q.name)];
  const sl=s.snds.filter(x=>s.sndCat==='all'||x.cat===s.sndCat);
  const vs={tabs:[['all','همه'],...Object.entries(SCAT)].map(([id,label])=>({label,count:id==='all'?s.snds.length:s.snds.filter(x=>x.cat===id).length,onClick:()=>set({sndCat:id}),bg:s.sndCat===id?'#2E2F31':'#fff',fg:s.sndCat===id?'#fff':'#3a3b3d',bd:s.sndCat===id?'#2E2F31':'#e1e3dc'})),
   cats:Object.entries(SCAT).map(([id,label])=>({id,label})),total:fmt(s.snds.reduce((a,x)=>a+x.dur,0)),count:s.snds.length,
   upload:e=>{const file=e.target.files&&e.target.files[0];if(!file)return;const url=URL.createObjectURL(file);const id='s'+Date.now();const a=new Audio(url);a.onloadedmetadata=()=>upd('snds',l=>l.map(x=>x.id===id?{...x,dur:Math.round(a.duration)}:x));upd('snds',l=>[{id,name:file.name.replace(/\.[^.]+$/,''),cat:s.sndCat==='all'?'greet':s.sndCat,dur:0,date:'1405/07/15',file:file.name,url},...l]);e.target.value='';},
   rows:sl.map(x=>{const u=usedIn(x);const pl=s.sndPlay===x.id;return {...x,catLabel:SCAT[x.cat],durText:fmt(x.dur),usedText:u.length?u.join('، '):'استفاده نشده',usedFg:u.length?'#3a3b3d':'#8b8e89',isPlaying:pl,notPlaying:!pl,playBg:pl?'#8DC63F':'#eef5e3',
    setCat:e=>{const v=e.target.value;upd('snds',l=>l.map(y=>y.id===x.id?{...y,cat:v}:y));},onPlay:()=>this.playSnd(x),del:()=>upd('snds',l=>l.filter(y=>y.id!==x.id)),canDel:!u.length}})};
  return {vx,vt,vq,vi,vs};
 }
 renderVals(){
  const s=this.state,C=this.calls,showAi=this.props.showAiColumn??true,ps=this.props.rowsPerPage??12;
  const R=c=>{const cur=s.pid===c.id||s.recPlay===c.id,pl=(s.pid===c.id&&!s.paused)||s.recPlay===c.id;return {...c,openFile:()=>this.openFile(c),isPlaying:pl,notPlaying:!pl,onPlay:()=>this.play(c.id),playBg:cur?'#8DC63F':'#eef5e3',playFg:cur?'#1f2021':'#3d6a0c',rowBg:cur?'#f7fbf1':'transparent'}};
  const fol=c=>s.follow[c.id]||c.follow;
  const vms=C.filter(c=>c.st==='voicemail');const AI=C.filter(c=>c.ai);
  const nv=(p,count)=>({go:()=>this.setState({page:p}),bg:s.page===p?'#8DC63F':'transparent',fg:s.page===p?'#1f2021':'#d9dad6',count,cbg:s.page===p?'rgba(31,32,33,.15)':'rgba(255,255,255,.08)'});
  const nav={calls:nv('calls',C.length),inbound:nv('inbound',C.filter(c=>c.dir==='in').length),voice:nv('voice',vms.filter(c=>fol(c)==='new').length),reports:nv('reports',''),survey:nv('survey',C.filter(c=>c.survey).length),ai:nv('ai',AI.length),vext:nv('vext',s.exts.length),vtrunk:nv('vtrunk',s.trunks.length),vqueue:nv('vqueue',s.vqs.length),vivr:nv('vivr',s.ivrs.length),vsound:nv('vsound',s.snds.length),vroute:nv('vroute',s.routes.length),vtime:nv('vtime',s.tconds.length),vring:nv('vring',s.rgroups.length),vfollow:nv('vfollow',Object.values(s.fmes).filter(f=>f.on).length),vblack:nv('vblack',s.blist.length)};
  const isV=['vext','vtrunk','vqueue','vivr','vsound','vroute','vtime','vring','vfollow','vblack'].includes(s.page);nav.voipOpen=s.voipOpen||isV;nav.toggleVoip=()=>this.setState({voipOpen:!(s.voipOpen||isV)});nav.voipChev=nav.voipOpen?'rotate(180deg)':'none';nav.voipBg=isV?'rgba(141,198,63,.12)':'transparent';
  const is={};['calls','inbound','voice','reports','survey','ai','vext','vtrunk','vqueue','vivr','vsound','vroute','vtime','vring','vfollow','vblack','file'].forEach(p=>is[p]=s.page===p);
  const qm=(c,q)=>!q||c.name.includes(q)||c.phoneRaw.includes(q.replace(/\s/g,''));
  const pill=(on)=>({bg:on?'#2E2F31':'#fff',fg:on?'#fff':'#3a3b3d',bd:on?'#2E2F31':'#e1e3dc'});
  const ops=OPS.map(o=>({id:o.id,label:o.name+' ('+o.ext+')'}));
  const statuses=Object.keys(ST).map(k=>({id:k,label:ST[k].label}));
  const cats=CATS.map(c=>({id:c.id,name:c.name}));
  const today=C.filter(c=>c.date===TODAY);

  // calls
  const TF={all:()=>true,in:c=>c.dir==='in',out:c=>c.dir==='out',missed:c=>c.st==='missed',voice:c=>c.hasVoice};
  const TL=[['all','همه'],['in','ورودی'],['out','خروجی'],['missed','بی‌پاسخ'],['voice','دارای ضبط']];
  const cF=s.cF;const setC=o=>this.setState({cF:{...s.cF,...o},cPage:0});
  let cAll=C.filter(c=>qm(c,s.cQ)&&c.date>=cF.from&&c.date<=cF.to&&c.time.slice(0,2)>=cF.h1.slice(0,2)&&c.time.slice(0,2)<=cF.h2.slice(0,2)&&(cF.op==='all'||(cF.op==='ivr'?!c.op:c.op&&c.op.id===cF.op))&&(cF.queue==='all'||c.queue===cF.queue)&&(cF.st==='all'||c.st===cF.st)&&c.dur>=+cF.minDur&&(cF.cat==='all'||(c.ai&&c.ai.cat.id===cF.cat)));
  if(cF.sort==='old')cAll=[...cAll].reverse();if(cF.sort==='long')cAll=[...cAll].sort((a,b)=>b.dur-a.dur);if(cF.sort==='wait')cAll=[...cAll].sort((a,b)=>b.wait-a.wait);
  const QD=[['امروز',TODAY,TODAY],['دیروز','1405/07/14','1405/07/14'],['۷ روز اخیر','1405/07/09',TODAY],['این ماه','1405/07/01',TODAY]];
  const nAct=Object.keys(CF0).filter(k=>cF[k]!==CF0[k]).length;const cf=cAll.filter(TF[s.cTab]);const pages=Math.max(1,Math.ceil(cf.length/ps));const pg=Math.min(s.cPage,pages-1);
  const tAns=today.filter(c=>c.st==='answered'||c.st==='transferred');
  const cl={pick:{from:v=>setC({from:v}),to:v=>setC({to:v})},q:s.cQ,setQ:e=>this.setState({cQ:e.target.value,cPage:0}),f:cF,set:Object.fromEntries(Object.keys(CF0).map(k=>[k,e=>setC({[k]:e.target.value})])),
   reset:()=>this.setState({cF:{...CF0},cQ:'',cPage:0}),activeText:nAct?nAct+' فیلتر فعال · '+cAll.length+' نتیجه':cAll.length+' نتیجه',
   quick:QD.map(([label,a,b])=>({label,onClick:()=>setC({from:a,to:b}),...pill(cF.from===a&&cF.to===b)})),
   kpis:[{value:today.length,label:'تماس امروز',bg:'#eef5e3',fg:'#8DC63F'},{value:tAns.length,label:'پاسخ‌داده امروز',bg:'#eaf4dc',fg:'#3d6a0c'},{value:today.filter(c=>c.st==='missed').length,label:'بی‌پاسخ امروز',bg:'#fdeceb',fg:'#e0574a'},{value:fmt(tAns.reduce((a,c)=>a+c.dur,0)/Math.max(1,tAns.length)),label:'میانگین مدت مکالمه',bg:'#e5eff7',fg:'#5b9bd0'}],
   tabs:TL.map(([id,label])=>({label,count:cAll.filter(TF[id]).length,onClick:()=>this.setState({cTab:id,cPage:0}),...pill(s.cTab===id)})),
   rows:cf.slice(pg*ps,pg*ps+ps).map(R),total:cf.length,rangeText:cf.length?(pg*ps+1)+'–'+Math.min(cf.length,pg*ps+ps):'0',pageText:(pg+1)+' / '+pages,
   prev:()=>this.setState({cPage:Math.max(0,pg-1)}),next:()=>this.setState({cPage:Math.min(pages-1,pg+1)})};

  // inbound
  const f=s.f;const setF=k=>e=>this.setState({f:{...s.f,[k]:k==='voice'?e.target.checked:e.target.value},ibLimit:20});
  let ibl=C.filter(c=>c.dir==='in'&&qm(c,f.q)&&c.date>=f.from&&c.date<=f.to&&(f.op==='all'||(f.op==='ivr'?!c.op:c.op&&c.op.id===f.op))&&(f.queue==='all'||c.queue===f.queue)&&(f.st==='all'||c.st===f.st)&&c.dur>=+f.minDur&&(!f.voice||c.hasVoice)&&(f.cat==='all'||(c.ai&&c.ai.cat.id===f.cat)));
  if(f.sort==='old')ibl=[...ibl].reverse();if(f.sort==='long')ibl=[...ibl].sort((a,b)=>b.dur-a.dur);if(f.sort==='wait')ibl=[...ibl].sort((a,b)=>b.wait-a.wait);
  const ia=agg(ibl);const chips=[];const clr=k=>()=>this.setState({f:{...s.f,[k]:F0[k]}});
  if(f.q)chips.push({label:'جستجو: '+f.q,clear:clr('q')});
  if(f.from!==F0.from||f.to!==F0.to)chips.push({label:f.from+' تا '+f.to,clear:()=>this.setState({f:{...s.f,from:F0.from,to:F0.to}})});
  if(f.op!=='all')chips.push({label:'اپراتور: '+(f.op==='ivr'?'IVR':OPS.find(o=>o.id===f.op).name),clear:clr('op')});
  if(f.queue!=='all')chips.push({label:'صف: '+f.queue,clear:clr('queue')});
  if(f.st!=='all')chips.push({label:'وضعیت: '+ST[f.st].label,clear:clr('st')});
  if(f.minDur!=='0')chips.push({label:'مدت > '+(+f.minDur/60)+' دقیقه',clear:clr('minDur')});
  if(f.voice)chips.push({label:'دارای ضبط',clear:clr('voice')});
  if(f.cat!=='all')chips.push({label:'دسته: '+CATS.find(c=>c.id===f.cat).name,clear:clr('cat')});
  const ib={pick:{from:v=>this.setState({f:{...s.f,from:v},ibLimit:20}),to:v=>this.setState({f:{...s.f,to:v},ibLimit:20})},f,set:Object.fromEntries(Object.keys(F0).map(k=>[k,setF(k)])),reset:()=>this.setState({f:{...F0}}),chips,hasChips:chips.length>0,
   stats:[{label:'تعداد نتایج',value:ia.count},{label:'نرخ پاسخگویی',value:ia.rate+'%'},{label:'میانگین انتظار',value:Math.round(ia.wait)+' ثانیه'},{label:'میانگین مکالمه',value:fmt(ia.avg)},{label:'پیام صوتی',value:ia.voicemail}],
   rows:ibl.slice(0,s.ibLimit).map(R),empty:!ibl.length,more:ibl.length>s.ibLimit,remaining:ibl.length-s.ibLimit,showMore:()=>this.setState({ibLimit:s.ibLimit+20})};

  // voice
  const VT=[['all','همه'],['new','جدید'],['follow','پیگیری'],['done','انجام‌شده']];
  const vl=vms.filter(c=>(s.vTab==='all'||fol(c)===s.vTab)&&qm(c,s.vQ)&&(s.vDate==='all'||c.date===s.vDate));
  const sel=vms.find(c=>c.id===s.vSel)||vl[0]||vms[0];
  const sameP=sel&&sel.known?C.filter(c=>c.phone===sel.phone):[sel];
  const frac=sel&&s.pid===sel.id?s.pos/sel.dur:0;
  const setFol=v=>()=>this.setState({follow:{...s.follow,[sel.id]:v}});
  const vm={kpis:[{value:vms.filter(c=>c.date===TODAY).length,label:'پیام صوتی امروز',bg:'#e5eff7',fg:'#5b9bd0'},{value:vms.filter(c=>fol(c)!=='done').length,label:'نیازمند پیگیری',bg:'#fbf1dc',fg:'#e0a83a'},{value:vms.filter(c=>fol(c)==='done').length,label:'پیگیری انجام‌شده',bg:'#eaf4dc',fg:'#8DC63F'},{value:today.filter(c=>c.st==='missed').length,label:'تماس بی‌پاسخ امروز',bg:'#fdeceb',fg:'#e0574a'}],
   tabs:VT.map(([id,label])=>({label,count:vms.filter(c=>id==='all'||fol(c)===id).length,onClick:()=>this.setState({vTab:id}),bg:s.vTab===id?'#8DC63F':'#f4f5f1',fg:s.vTab===id?'#1f2021':'#55585c'})),
   pickDate:v=>this.setState({vDate:v||'all'}),dateV:s.vDate==='all'?'':s.vDate,q:s.vQ,setQ:e=>this.setState({vQ:e.target.value}),dateF:s.vDate,setDate:e=>this.setState({vDate:e.target.value}),empty:!vl.length,
   sugg:sel?SUGG[sel.ai.cat.id]:'',speedText:s.speed+'x',cycleSpeed:()=>this.setState({speed:[1,1.5,2][([1,1.5,2].indexOf(s.speed)+1)%3]}),
   noteText:s.noteText,setNote:e=>this.setState({noteText:e.target.value}),notes:sel?(s.notes[sel.id]||[]).map(mkNote):[],hasNotes:!!(sel&&(s.notes[sel.id]||[]).length),
   refs:REFS.map(r=>{const on=s.noteRef===r.id;return {label:r.label,onClick:()=>this.setState({noteRef:r.id}),bg:on?r.fg:'#fff',fg:on?'#fff':r.fg,bd:on?r.fg:'#e1e3dc'}}),
   addNote:()=>{if(!sel||(!s.noteText.trim()&&s.noteRef==='none'))return;const r=REFS.find(x=>x.id===s.noteRef);this.setState({noteText:'',noteRef:'none',notes:{...s.notes,[sel.id]:[...(s.notes[sel.id]||[]),{t:s.noteText.trim(),ref:s.noteRef,by:'نگار احمدی',at:TODAY+' · '+new Date().toTimeString().slice(0,5)}]},follow:fol(sel)==='new'?{...s.follow,[sel.id]:'follow'}:s.follow});this.toast(r.id==='none'?'یادداشت ثبت شد':'یادداشت ثبت شد و '+r.label.replace('ارجاع به ','به ')+' ارجاع داده شد');},
   list:vl.map(c=>{const nCb=C.filter(x=>x.callback&&x.phoneRaw===c.phoneRaw).length;return {...R(c),hasCb:nCb>0,cbText:nCb+' تماس برگشتی',fol:FOLLOW[fol(c)],isNew:fol(c)==='new',snippet:c.ai.tx.slice(0,70)+'…',when:c.date===TODAY?c.time:c.date.slice(5),select:()=>this.setState({vSel:c.id}),selBg:sel&&sel.id===c.id?'#f3f8ea':'#fff',selBd:sel&&sel.id===c.id?'#8DC63F':'transparent'}}),
   hasSel:!!sel,sel,selFol:sel?FOLLOW[fol(sel)]:FOLLOW.new,idChip:sel&&sel.known?{label:'✓ پرونده شناسایی شد',bg:'#eaf4dc',fg:'#3d6a0c'}:{label:'بیمار جدید / ناشناس',bg:'#fbf1dc',fg:'#8a5a00'},
   info:sel?[{label:'کد ملی',value:sel.nid},{label:'تاریخ جراحی',value:sel.surgery},{label:'تعداد تماس امروز',value:sameP.filter(c=>c.date===TODAY).length+' مرتبه'},{label:'تعداد تماس ۳۰ روز',value:sameP.length+' مرتبه'}]:[],
   isPlaying:sel&&s.pid===sel.id&&!s.paused,notPlaying:!(sel&&s.pid===sel.id&&!s.paused),play:()=>sel&&this.play(sel.id),
   seek:e=>{if(!sel)return;const b=e.currentTarget.getBoundingClientRect();const fr=Math.min(1,Math.max(0,(b.right-e.clientX)/b.width));this.setState({pid:sel.id,pos:fr*sel.dur,paused:false});},
   wave:sel?sel.wave.map((h,i)=>({h:h+'px',c:i/sel.wave.length<frac?'#8DC63F':'rgba(255,255,255,.3)'})):[],
   timeText:sel?fmt(frac*sel.dur)+' / '+fmt(sel.dur):'',urg:sel?URG[sel.ai.urg]:URG.low,sent:sel?SENT[sel.ai.sent]:SENT.neu,
   actCall:()=>sel&&this.startCall({...sel,vmId:sel.id}),openFile:()=>sel&&this.openFile(sel),
   isDone:!!(sel&&fol(sel)==='done'),doneAt:sel&&s.doneAt[sel.id]?' · '+s.doneAt[sel.id]:'',
   doneLabel:sel&&fol(sel)==='done'?'بازگشایی پیگیری':'علامت‌گذاری به عنوان انجام‌شده',doneBg:sel&&fol(sel)==='done'?'#f4f5f1':'#fff',doneFg:'#3a3b3d',doneBd:'#e1e3dc',
   actDone:()=>{if(!sel)return;const d=fol(sel)==='done';this.setState({follow:{...s.follow,[sel.id]:d?'follow':'done'},doneAt:{...s.doneAt,[sel.id]:d?'':'نگار احمدی · ساعت '+new Date().toTimeString().slice(0,5)}});this.toast(d?'پیگیری پیام '+sel.name+' دوباره باز شد':'پیگیری پیام '+sel.name+' انجام شد');},
   ...(()=>{const cbs=sel?C.filter(x=>x.callback&&x.phoneRaw===sel.phoneRaw):[];return {hasCallbacks:cbs.length>0,cbCount:cbs.length,callbacks:cbs.map(x=>({...R(x),hasSummary:!!x.summary,recLabel:x.url?'ضبط مکالمه':'ضبط مرکز تلفن'}))};})(),
   history:sameP.slice(0,6).map(R)};

  // patient file
  const fl=s.fileKey?C.filter(c=>c.phoneRaw===s.fileKey):[];const fp=fl[0];
  const fA=agg(fl),fvm=fl.filter(c=>c.st==='voicemail'),fsv=fl.filter(c=>c.survey),fOpen=fvm.filter(c=>fol(c)!=='done').length;
  const fNotes=fvm.flatMap(c=>(s.notes[c.id]||[]).map(mkNote));
  const pf=fp?{has:true,blockLabel:s.blist.some(b=>b.num===fp.phoneRaw)?'حذف از لیست سیاه':'افزودن به لیست سیاه',block:()=>this.toggleBl(fp.phoneRaw),p:fp,count:fl.length,back:()=>this.setState({page:s.prevPage||'calls'}),
   call:()=>this.startCall({...fp,vmId:(fvm.find(c=>fol(c)!=='done')||{}).id}),
   idChip:fp.known?{label:'✓ بیمار شناسایی‌شده',bg:'#eaf4dc',fg:'#3d6a0c'}:{label:'تماس‌گیرنده ناشناس',bg:'#fbf1dc',fg:'#8a5a00'},
   openChip:fOpen?{label:fOpen+' پیگیری باز',bg:'#fdeee4',fg:'#c2410c'}:{label:'بدون پیگیری باز',bg:'rgba(255,255,255,.1)',fg:'#d9dad6'},
   info:[{label:'کد ملی',value:fp.nid},{label:'تاریخ جراحی',value:fp.surgery},{label:'اولین تماس',value:fl[fl.length-1].date},{label:'آخرین تماس',value:fl[0].date+' · '+fl[0].time},{label:'آخرین اپراتور',value:(fl.find(c=>c.op)||{opName:'—'}).opName}],
   kpis:[{label:'کل تماس‌ها',value:fA.count},{label:'پاسخ‌داده',value:fA.answered},{label:'بی‌پاسخ',value:fA.missed},{label:'پیام صوتی',value:fvm.length},{label:'مجموع مکالمه',value:fmt(fA.total)},{label:'میانگین رضایت',value:fA.csat==null?'—':fA.csat.toFixed(1)+' / 5'}],
   rows:fl.map(R),hasVm:fvm.length>0,vmCount:fvm.length,
   vms:fvm.map(c=>({...R(c),fol:FOLLOW[fol(c)],snippet:c.ai.tx,open:()=>this.setState({page:'voice',vSel:c.id,vTab:'all',vQ:'',vDate:'all'})})),
   hasNotes:fNotes.length>0,notes:fNotes,hasSv:fsv.length>0,
   svs:fsv.map(c=>{const sc=Math.round(c.survey.score);return {...c,starsOn:'★'.repeat(sc),starsOff:'★'.repeat(5-sc),commentText:c.survey.comment||'بدون توضیح'}})}:{has:false};
  const cs=s.call;
  const call=cs?{show:true,name:cs.name,phone:cs.phone,ini:ini(cs.name),isDial:cs.stage==='dial',isLive:cs.stage==='live',rec:cs.rec,recErr:cs.recErr,hasRecErr:!!cs.recErr,elText:fmt(cs.el),
   stageLabel:cs.stage==='dial'?'در حال برقراری تماس…':'تماس برقرار است',ext:OPS[0].ext,tel:'tel:'+cs.phoneRaw,note:cs.note||'',
   setNote:e=>{const v=e.target.value;this.setState(st=>({call:{...st.call,note:v}}));},connect:()=>this.connect(),noAnswer:()=>this.endCall(false),end:()=>this.endCall(true),cancel:()=>this.setState({call:null})}:{show:false};
  const toast={show:!!s.toast,text:s.toast||''};

  // reports
  const r=s.r;const setR=o=>this.setState({r:{...s.r,drill:null,...o}});
  const rc=C.filter(c=>c.date>=r.from&&c.date<=r.to&&(r.op==='all'||(r.op==='ivr'?!c.op:c.op&&c.op.id===r.op))&&(r.dir==='all'||c.dir===r.dir)&&(r.st==='all'||c.st===r.st)&&qm(c,r.q));
  const m=new Map();rc.forEach(c=>{const k=GK[r.group](c);if(!m.has(k))m.set(k,[]);m.get(k).push(c);});
  const groups=[...m.entries()].map(([k,l])=>({k,l,a:agg(l)}));
  if(r.group==='date'||r.group==='hour')groups.sort((a,b)=>a.k<b.k?-1:1);else groups.sort((a,b)=>b.a.count-a.a.count);
  const maxC=Math.max(1,...groups.map(g=>g.a.count));const selMet=MET.filter(x=>r.metrics.includes(x.id));const ta=agg(rc);
  const dl=r.drill?rc.filter(c=>GK[r.group](c)===r.drill):rc;
  const PRE=[['عملکرد اپراتورها',{group:'operator',metrics:['count','answered','missed','rate','avg','total','csat'],op:'all',st:'all'}],['بی‌پاسخ‌های امروز',{from:TODAY,to:TODAY,st:'missed',group:'hour',metrics:['count','wait']}],['ساعات اوج تماس',{group:'hour',st:'all',metrics:['count','answered','missed','voicemail','rate','wait']}],['روند روزانه',{group:'date',st:'all',from:F0.from,to:TODAY,metrics:['count','answered','missed','rate','avg']}],['تماس‌گیرندگان پرتکرار',{group:'phone',st:'all',metrics:['count','answered','missed','total']}],['دسته‌بندی هوش مصنوعی',{group:'category',st:'all',metrics:['count','answered','voicemail','csat']}]];
  const rp={pick:{from:v=>setR({from:v}),to:v=>setR({to:v})},r,set:Object.fromEntries(['from','to','op','dir','st','q'].map(k=>[k,e=>setR({[k]:e.target.value})])),
   presets:PRE.map(([label,o])=>({label,onClick:()=>this.setState({r:{...R0,...o,drill:null}})})),
   groupOpts:Object.keys(GL).map(k=>({label:GL[k],onClick:()=>setR({group:k}),...pill(r.group===k)})),
   metricOpts:MET.map(x=>{const on=r.metrics.includes(x.id);return {label:x.label,mark:on?'✓':'+',onClick:()=>this.setState({r:{...s.r,metrics:on?r.metrics.filter(y=>y!==x.id):MET.filter(y=>r.metrics.includes(y.id)||y.id===x.id).map(y=>y.id)}}),bg:on?'#eef5e3':'#fff',fg:on?'#3d6a0c':'#6b6e72',bd:on?'#cfe4ad':'#e1e3dc'}}),
   kpis:[{label:'کل تماس‌ها',value:ta.count},{label:'نرخ پاسخگویی',value:ta.rate+'%'},{label:'بی‌پاسخ',value:ta.missed},{label:'میانگین مکالمه',value:fmt(ta.avg)},{label:'میانگین رضایت',value:ta.csat==null?'—':ta.csat.toFixed(1)+' / 5'}],
   groupLabel:GL[r.group],headers:[GL[r.group],...selMet.map(x=>x.label)],
   rows:groups.map(g=>({key:g.k,cells:selMet.map(x=>({v:x.f(g.a)})),onClick:()=>this.setState({r:{...s.r,drill:r.drill===g.k?null:g.k}}),bg:r.drill===g.k?'#f3f8ea':'transparent'})),
   totals:selMet.map(x=>({v:x.f(ta)})),
   bars:groups.slice(0,20).map(g=>({label:g.k,count:g.a.count,wAns:g.a.answered/maxC*100+'%',wMiss:g.a.missed/maxC*100+'%',wVm:g.a.voicemail/maxC*100+'%',op:r.drill&&r.drill!==g.k?.35:1,onClick:()=>this.setState({r:{...s.r,drill:r.drill===g.k?null:g.k}})})),
   drill:dl.slice(0,10).map(R),drillCount:dl.length,drillLabel:r.drill?GL[r.group]+': '+r.drill:'همه نتایج (۱۰ مورد اخیر)',
   exportCsv:()=>{const h=['شناسه','تاریخ','ساعت','نام','شماره','جهت','صف','اپراتور','داخلی','مدت','انتظار','وضعیت','دسته AI','رضایت'];
    const rows=rc.map(c=>[c.id,c.date,c.time,c.name,c.phone,c.dirLabel,c.queue,c.opName,c.ext,c.durText,c.wait,c.status.label,c.aiName,c.survey?c.survey.score:''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(','));
    const b=new Blob(['\ufeff'+[h.join(','),...rows].join('\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='report-'+r.group+'.csv';a.click();}};

  // survey
  const svAll=C.filter(c=>c.survey);const svl=svAll.filter(c=>s.sOp==='all'||c.op.id===s.sOp);
  const avg=l=>l.length?l.reduce((a,c)=>a+c.survey.score,0)/l.length:0;
  const ansIn=C.filter(c=>c.dir==='in'&&c.st==='answered'&&(s.sOp==='all'||c.op.id===s.sOp));
  const dist=[5,4,3,2,1].map(n=>svl.filter(c=>Math.round(c.survey.score)===n).length);const maxD=Math.max(1,...dist);
  const sv={op:s.sOp,setOp:e=>this.setState({sOp:e.target.value}),
   kpis:[{label:'نظرسنجی انجام‌شده',value:svl.length},{label:'میانگین امتیاز',value:avg(svl).toFixed(1)+' / 5'},{label:'رضایت (۴ و ۵)',value:Math.round(svl.filter(c=>c.survey.score>=4).length/Math.max(1,svl.length)*100)+'%'},{label:'نرخ مشارکت',value:Math.round(svl.length/Math.max(1,ansIn.length)*100)+'%'}],
   dist:dist.map((n,i)=>({label:'★'.repeat(5-i),n,w:n/maxD*100+'%'})),
   qs:QS.map((q,i)=>{const a=svl.length?svl.reduce((x,c)=>x+c.survey.answers[i],0)/svl.length:0;return {label:q,avg:a.toFixed(1),w:a/5*100+'%'}}),
   opRows:OPS.map(o=>{const l=svAll.filter(c=>c.op.id===o.id);return {name:o.name,n:l.length,a:avg(l)}}).sort((a,b)=>b.a-a.a).map((o,i)=>({...o,rank:i+1,avg:o.a.toFixed(1)})),
   list:svl.slice(0,15).map(c=>{const sc=Math.round(c.survey.score);return {...R(c),starsOn:'★'.repeat(sc),starsOff:'★'.repeat(5-sc),scoreText:c.survey.score.toFixed(1)+' از 5',commentText:c.survey.comment||'بدون توضیح',qText:QS.map((q,i)=>q+': '+c.survey.answers[i]).join(' · ')}})};

  // ai
  const fa=AI.filter(c=>(s.aiCat==='all'||c.ai.cat.id===s.aiCat)&&(s.aiSent==='all'||c.ai.sent===s.aiSent));
  const sc={pos:0,neu:0,neg:0};AI.forEach(c=>sc[c.ai.sent]++);const kw={};AI.forEach(c=>c.ai.kw.forEach(k=>kw[k]=(kw[k]||0)+1));
  const maxCat=Math.max(1,...CATS.map(cat=>AI.filter(c=>c.ai.cat.id===cat.id).length));
  const ai={kpis:[{label:'ویس تحلیل‌شده',value:AI.length},{label:'اولویت فوری',value:AI.filter(c=>c.ai.urg==='high').length},{label:'احساس منفی',value:Math.round(sc.neg/AI.length*100)+'%'},{label:'میانگین دقت تبدیل',value:Math.round(AI.reduce((a,c)=>a+c.ai.conf,0)/AI.length)+'%'}],
   cats:CATS.map(cat=>{const n=AI.filter(c=>c.ai.cat.id===cat.id).length;return {name:cat.name,fg:cat.fg,bg:cat.bg,bar:cat.bar,n,share:Math.round(n/AI.length*100)+'%',w:n/maxCat*100+'%',bd:s.aiCat===cat.id?cat.bar:'#e7e8e3',onClick:()=>this.setState({aiCat:s.aiCat===cat.id?'all':cat.id})}}),
   sent:{...sc,wPos:sc.pos/AI.length*100+'%',wNeu:sc.neu/AI.length*100+'%',wNeg:sc.neg/AI.length*100+'%'},
   kw:Object.entries(kw).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([w,n])=>({w,n})),
   catF:s.aiCat,setCat:e=>this.setState({aiCat:e.target.value}),
   sentTabs:[['all','همه احساسات'],['pos','مثبت'],['neu','خنثی'],['neg','منفی']].map(([id,label])=>({label,onClick:()=>this.setState({aiSent:id}),...pill(s.aiSent===id)})),
   count:fa.length,items:fa.slice(0,24).map(c=>({...R(c),sentO:SENT[c.ai.sent],urgO:URG[c.ai.urg],isVm:c.st==='voicemail',openVm:()=>this.setState({page:'voice',vSel:c.id,vTab:'all'})}))};

  // player
  const pc=s.pid?C.find(c=>c.id===s.pid):null;const SP=[1,1.5,2];
  const player=pc?{show:true,name:pc.name+' · '+pc.phone,opName:pc.opName,date:pc.date,time:pc.time,playing:!s.paused,notPlaying:s.paused,
   toggle:()=>this.play(pc.id),back:()=>this.setState({pos:Math.max(0,s.pos-10)}),fwd:()=>this.setState({pos:Math.min(pc.dur,s.pos+10)}),close:()=>this.setState({pid:null,paused:true}),
   seek:e=>{const b=e.currentTarget.getBoundingClientRect();this.setState({pos:Math.min(1,Math.max(0,(b.right-e.clientX)/b.width))*pc.dur});},
   pct:s.pos/pc.dur*100+'%',posText:fmt(s.pos),durText:fmt(pc.dur),speedText:s.speed+'x',cycleSpeed:()=>this.setState({speed:SP[(SP.indexOf(s.speed)+1)%SP.length]}),download:()=>{}}:{show:false};

  return {...this.voip(s),...this.voip2(s),pf,call,toast,nav,is,cl,ib,vm,rp,sv,ai,player,showAi,dates:DATES,hours:HOURS,ops,queues:QUEUES,statuses,cats};
 }
}
</script>

