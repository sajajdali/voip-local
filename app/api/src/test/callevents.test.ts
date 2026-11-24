// «ارسال تماس‌ها (API)»: the outbox (order, retries, signature, event choice) and AMI → call events.
import { strict as assert } from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { after, before, describe, it } from 'node:test';
import { CallEventsService, dialTarget } from '../callevents';
import { evText, generate } from '../asterisk/generator';
import { EVENTS, WebhookService, signature } from '../webhook';

const me = { id: 'u', name: 'مدیر', role: 'admin', ext: null, username: 'admin' };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** In-memory stand-in for the Prisma tables the outbox uses. */
function fakeDb() {
  const config: Record<string, any> = {};
  const events: any[] = [];
  const logs: any[] = [];
  const match = (row: any, where: any = {}) => Object.entries(where).every(([k, v]: [string, any]) =>
    v && typeof v === 'object' && !(v instanceof Date) ? ('not' in v ? row[k] !== v.not : 'gte' in v ? row[k] >= v.gte : 'lt' in v ? row[k] < v.lt : true) : row[k] === v);
  return {
    events, logs,
    configEntry: { findUnique: async ({ where }: any) => (config[where.key] ? { data: config[where.key] } : null), upsert: async ({ where, create }: any) => { config[where.key] = create.data; } },
    auditLog: { create: async () => ({}) },
    callEvent: {
      aggregate: async ({ where }: any) => ({ _max: { seq: Math.max(0, ...events.filter(e => match(e, where)).map(e => e.seq)) || null } }),
      create: async ({ data }: any) => { const row = { id: events.length + 1, state: 'pending', attempts: 0, nextAt: new Date(), createdAt: new Date(), httpCode: null, error: null, ...data }; events.push(row); return row; },
      findMany: async ({ where, take }: any) => events.filter(e => match(e, where)).sort((a, b) => a.id - b.id).slice(0, take || 999),
      findUnique: async ({ where }: any) => events.find(e => e.id === where.id) || null,
      update: async ({ where, data }: any) => Object.assign(events.find(e => e.id === where.id), data),
      updateMany: async ({ where, data }: any) => { for (const e of events.filter(x => match(x, where))) Object.assign(e, data); },
      count: async ({ where }: any) => events.filter(e => match(e, where)).length,
      deleteMany: async () => ({}),
    },
    webhookLog: { create: async ({ data }: any) => { logs.push(data); }, findMany: async () => logs, count: async () => 0, deleteMany: async () => ({}) },
    call: { findUnique: async () => null, findMany: async () => [] },
    tenantConfig: { findUnique: async () => null, upsert: async () => ({}) },
  } as any;
}

describe('outbox delivery', () => {
  const got: { headers: http.IncomingHttpHeaders; body: any; raw: string }[] = [];
  let failNext = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      if (failNext > 0) { failNext--; res.writeHead(500); return res.end('busy'); }
      got.push({ headers: req.headers, body: JSON.parse(raw), raw });
      res.writeHead(200); res.end('ok');
    });
  });
  let url = '';
  before(async () => { await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r())); url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`; });
  after(() => srv.close());

  it('records only chosen events while sending is on', async () => {
    const db = fakeDb();
    const w = new WebhookService(db);
    await w.record('call.started', 'C1', {});
    assert.equal(db.events.length, 0, 'off: nothing is stored');
    await w.save({ enabled: true, url, events: ['call.started', 'call.ended'] }, me);
    await w.record('call.started', 'C1', {});
    await w.record('call.queued', 'C1', {});
    assert.deepEqual(db.events.map((e: any) => e.event), ['call.started']);
    await assert.rejects(w.save({ enabled: true, url, events: [] }, me), /حداقل یک رویداد/);
  });

  it('delivers each call in order with seq, envelope, token and a verifiable signature', async () => {
    got.length = 0;
    const db = fakeDb();
    const w = new WebhookService(db);
    await w.save({ enabled: true, url, token: 'Bearer abc', secret: 's3cret' }, me);
    for (const e of ['call.started', 'call.queued', 'call.ringing', 'call.answered']) await w.record(e, 'C9', { n: e });
    await w.record('call.started', 'C10', {});
    for (let i = 0; i < 20 && got.length < 5; i++) { await w.pump(); await wait(30); }
    const c9 = got.filter(g => g.body.callId === 'C9');
    assert.deepEqual(c9.map(g => g.body.event), ['call.started', 'call.queued', 'call.ringing', 'call.answered']);
    assert.deepEqual(c9.map(g => g.body.seq), [1, 2, 3, 4]);
    const g = c9[0];
    assert.equal(g.headers.authorization, 'Bearer abc');
    assert.equal(g.headers['x-event'], 'call.started');
    assert.equal(g.headers['x-event-id'], g.body.eventId);
    assert.equal(g.headers['x-signature'], signature('s3cret', String(g.headers['x-timestamp']), g.raw));
    assert.deepEqual(g.body.data, { n: 'call.started' });
    assert.ok(db.events.every((e: any) => e.state === 'sent'));
  });

  it('retries a failed delivery and keeps the later events of that call waiting', async () => {
    got.length = 0;
    const db = fakeDb();
    const w = new WebhookService(db);
    w.retryDelays = [50, 50, 50];
    await w.save({ enabled: true, url }, me);
    failNext = 2;
    await w.record('call.started', 'C7', {});
    await w.record('call.ended', 'C7', {});
    for (let i = 0; i < 40 && got.length < 2; i++) { await w.pump(); await wait(40); }
    assert.deepEqual(got.map(x => x.body.event), ['call.started', 'call.ended']);
    assert.equal(db.events[0].attempts, 3);
    assert.equal(db.logs.filter((l: any) => !l.ok).length, 2);
  });

  it('gives up after the last retry and moves on', async () => {
    got.length = 0;
    const db = fakeDb();
    const w = new WebhookService(db);
    w.retryDelays = [20];
    await w.save({ enabled: true, url }, me);
    failNext = 2;
    await w.record('call.started', 'C8', {});
    await w.record('call.ended', 'C8', {});
    for (let i = 0; i < 40 && got.length < 1; i++) { await w.pump(); await wait(30); }
    assert.equal(db.events[0].state, 'failed');
    assert.deepEqual(got.map(x => x.body.event), ['call.ended']);
  });

  it('switching off cancels what is still waiting', async () => {
    const db = fakeDb();
    const w = new WebhookService(db);
    await w.save({ enabled: true, url: 'http://127.0.0.1:1/x' }, me);
    await w.record('call.started', 'C5', {});
    await w.save({ enabled: false }, me);
    assert.equal(db.events[0].state, 'cancelled');
  });

  it('the end of a call sends survey and voicemail before call.ended', async () => {
    const db = fakeDb();
    const w = new WebhookService(db);
    await w.save({ enabled: true, url: 'http://127.0.0.1:1/x' }, me);
    (w as any).endedData = async () => ({ phone: '09120000000', status: 'voicemail', survey: { answers: [5, 4], score: 4.5, hasRec: true }, connectedSeconds: 12, endedAt: new Date().toISOString() });
    await w.finished('C3');
    assert.deepEqual(db.events.map((e: any) => [e.event, e.seq]), [['survey.completed', 1], ['voicemail.left', 2], ['call.ended', 3]]);
    assert.deepEqual(db.events[0].payload.data.answers, [5, 4]);
  });

  it('has a sample for every event', async () => {
    const db = fakeDb();
    db.call = { findFirst: async () => null };
    const w = new WebhookService(db);
    const s = await w.samples();
    assert.deepEqual(Object.keys(s), EVENTS.map(e => e.key));
    assert.equal(s['call.answered'].data.extension, '101');
  });
});

describe('AMI → call events', () => {
  const recorded: [string, string, any][] = [];
  const hooks = { record: async (e: string, c: string, d: any) => { recorded.push([e, c, d]); } } as any;
  // this caller: 4 earlier calls (3 inbound), one of them (inbound) today
  const counts = (w: any) => (w.dir === 'in' ? (w.date ? 1 : 3) : w.date ? 1 : 4);
  const db = {
    user: { findMany: async () => [{ ext: '101', name: 'خانم احمدی' }] }, patient: { findUnique: async () => ({ name: 'علی رضایی' }) },
    call: { count: async ({ where }: any) => counts(where), findFirst: async () => ({ startedAt: new Date('2026-10-30T09:00:00Z') }) },
  } as any;
  const store = { all: async () => ({ exts: [{ n: '102', name: 'پذیرش ۲' }] }) } as any;
  const ev = new CallEventsService({ on() {} } as any, hooks, db, store);
  const L = '1730371234.552';
  const send = (m: any) => ev.onAmi({ Linkedid: L, ...m });

  it('follows one inbound call from start to transfer', async () => {
    await send({ Event: 'DialBegin', DestChannel: 'PJSIP/101-0001' }); // before call.started: ignored
    await send({ Event: 'UserEvent', UserEvent: 'CCEvent', Type: 'call.started', Uid: L, Dir: 'in', Num: '9121234567', Did: '02112345678' });
    await send({ Event: 'UserEvent', UserEvent: 'CCEvent', Type: 'call.ivr', Menu: evText('منوی اصلی'), Key: '1', Label: evText('پذیرش (شیفت صبح)') });
    await send({ Event: 'UserEvent', UserEvent: 'CCEvent', Type: 'call.queued', Queue: evText('پذیرش') });
    await send({ Event: 'DialBegin', DestChannel: 'PJSIP/101-0002' });
    await send({ Event: 'DialBegin', DestChannel: 'PJSIP/102-0003' });
    await send({ Event: 'DialBegin', DestChannel: 'PJSIP/101-0004' }); // queue re-ring: deduped
    await send({ Event: 'DialEnd', DestChannel: 'PJSIP/102-0003', DialStatus: 'NOANSWER' });
    await send({ Event: 'DialEnd', DestChannel: 'PJSIP/101-0002', DialStatus: 'ANSWER' });
    await send({ Event: 'BlindTransfer', Result: 'Success', TransfererChannel: 'PJSIP/101-0002', Extension: '102' });
    await send({ Event: 'DialEnd', DestChannel: 'PJSIP/102-0005', DialStatus: 'ANSWER' });
    await send({ Event: 'UserEvent', UserEvent: 'CCEvent', Type: 'survey.started', Ansext: '102' });
    await ev.onAmi({ Linkedid: 'other', Event: 'DialBegin', DestChannel: 'PJSIP/103-0009' }); // an internal call: ignored

    assert.deepEqual(recorded.map(r => r[0]), ['call.started', 'call.ivr', 'call.queued', 'call.ringing', 'call.ringing', 'call.answered', 'call.transferred', 'call.answered', 'survey.started']);
    assert.ok(recorded.every(r => r[1] === 'C' + L));
    const d = Object.fromEntries(recorded.map(r => [r[0], r[2]]));
    assert.deepEqual(d['call.started'], {
      direction: 'inbound', phone: '09121234567', callerNumber: '09121234567', calledNumber: '02112345678', patientName: 'علی رضایی', isCallback: false,
      calls: { total: 5, today: 2, inboundTotal: 4, inboundToday: 2, lastCallAt: '2026-10-30T09:00:00.000Z', firstCall: false },
    });
    assert.deepEqual(d['call.ivr'], { menu: 'منوی اصلی', key: '1', label: 'پذیرش (شیفت صبح)' });
    assert.equal(recorded[3][2].operator, 'خانم احمدی');
    assert.equal(recorded[4][2].operator, 'پذیرش ۲');
    assert.equal(recorded[5][2].extension, '101');
    assert.equal(typeof recorded[5][2].waitSeconds, 'number');
    assert.deepEqual(d['call.transferred'], { kind: 'blind', from: { extension: '101', name: 'خانم احمدی' }, to: { extension: '102', name: 'پذیرش ۲' } });
    assert.equal(recorded[7][2].extension, '102');
    assert.deepEqual(d['survey.started'].operator, { extension: '102', name: 'پذیرش ۲' });
  });

  it('reads dialled channels', () => {
    assert.deepEqual(dialTarget('PJSIP/trunk-t1-00000a'), { target: 'external' });
    assert.deepEqual(dialTarget('PJSIP/105-00000b'), { target: 'extension', extension: '105' });
    assert.deepEqual(dialTarget('PJSIP/tnabc12345_105-00000c'), { target: 'extension', extension: '105' });
    assert.deepEqual(dialTarget('Local/09121234567@cc-outext-0001;1'), { target: 'mobile', number: '09121234567' });
    assert.deepEqual(dialTarget('Local/ai@cc-ai-session-01;1'), { target: 'ai' });
  });
});

describe('dialplan markers', () => {
  it('marks call start, IVR keys, queues and the survey', () => {
    const cfg: any = {
      exts: [{ n: '101', name: 'a', pass: 'x' }], trunks: [{ id: 't1', on: true, host: 'h', user: 'u', pass: 'p' }], vqs: [{ id: 'q1', name: 'پذیرش, صبح', members: ['101'] }],
      ivrs: [{ id: 'i1', name: 'منوی (اصلی)', opts: [{ k: '1', label: 'صف', dest: 'q:q1' }] }], snds: [{ id: 's1', name: 'x' }],
      routes: [{ id: 'r1', on: true, dest: 'ivr:i1' }], oroutes: [{ id: 'o1', on: true, trunk: 't1', pats: '09XXXXXXXXX' }], tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {},
      survey: { on: true, qs: [{ snd: 's1' }] }, vmbox: {},
    };
    const ext = generate(cfg, { hookUrl: 'http://h', hookSecret: 's', mohDir: '/m' }).files['extensions.conf'];
    assert.match(ext, /UserEvent\(CCEvent,Type: call\.started,Uid: \$\{UNIQUEID\},Dir: in,/);
    assert.match(ext, /UserEvent\(CCEvent,Type: call\.started,Uid: \$\{UNIQUEID\},Dir: out,/);
    assert.ok(ext.includes(`UserEvent(CCEvent,Type: call.ivr,Menu: ${evText('منوی (اصلی)')},Key: 1,Label: ${evText('صف')})`));
    assert.ok(ext.includes(`UserEvent(CCEvent,Type: call.queued,Queue: ${evText('پذیرش, صبح')})`));
    assert.match(ext, /UserEvent\(CCEvent,Type: survey\.started,Ansext: \$\{CC_ANSEXT\}\)/);
    assert.ok(!/[(),]/.test(evText('منوی (اصلی), دوم')));
  });

  it('trunk registrations retry every minute and never give up', () => {
    const cfg: any = { exts: [], trunks: [{ id: 't1', on: true, host: '10.0.0.1', user: '2100', pass: 'p', did: '2100' }], vqs: [], ivrs: [], snds: [], routes: [], tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {} };
    const pj = generate(cfg, { hookUrl: 'http://h', hookSecret: 's', mohDir: '/m' }).files['pjsip.conf'];
    const reg = pj.slice(pj.indexOf('[trunk-t1-reg]'), pj.indexOf('\n\n', pj.indexOf('[trunk-t1-reg]')));
    for (const line of ['retry_interval=60', 'forbidden_retry_interval=60', 'fatal_retry_interval=60', 'auth_rejection_permanent=no', 'max_retries=1000000']) assert.ok(reg.includes(line), line);
  });
});
