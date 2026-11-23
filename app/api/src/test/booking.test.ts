// Phone booking line: speech, validation, API parsing, every call path, the FastAGI protocol and the dialplan.
import { strict as assert } from 'assert';
import * as net from 'net';
import { describe, it } from 'node:test';
import {
  Answer, BOOKING_DEFAULTS, BookingApiError, BookingApiLike, BookingSettings, FlowCtx, FlowState, FreeTimes, MSG, Tracked,
  normalizeMobile, numberFa, parseDays, reminderCallFile, runBooking, runCancelNotice, runReminder, runTracking, sayCode, sayDate, sayMobile, stagesReached, stoppedAt, validNationalCode,
} from '../booking';
import { AgiChan, AgiHangup, startFastAgi } from '../fastagi';
import { destTarget, generate } from '../asterisk/generator';

const DIR = '/snd';

describe('speech', () => {
  it('reads weekday, day, month and time the way the old IVR did', () => {
    // 2026-11-01 10:30 Tehran = Sunday 10 Aban 1405
    assert.deepEqual(sayDate(new Date(1793516400e3)), ['extra/1shanbeh', 'digits/10-me', 'digits/aban', MSG.saate, 'digits/10', 'extra/va', 'digits/30', 'digits/daghigheh']);
    // 2026-12-04 21:00 Tehran = Friday 13 Azar: no minutes part
    assert.deepEqual(sayDate(new Date(1796405400e3)), ['extra/jomeh', 'digits/13-me', 'digits/azar', MSG.saate, 'digits/20-o', 'digits/1']);
    // Dey uses its own recording
    assert.equal(sayDate(new Date(Date.UTC(2027, 0, 5, 8, 0)))[2], 'digits/dey-mah');
  });
  it('builds numbers up to 999 with «و»', () => {
    assert.deepEqual(numberFa(7), ['digits/7']);
    assert.deepEqual(numberFa(25), ['digits/20-o', 'digits/5']);
    assert.deepEqual(numberFa(40), ['digits/40']);
    assert.deepEqual(numberFa(100), ['digits/hundred']);
    assert.deepEqual(numberFa(120), ['digits/hundred-o', 'digits/20']);
    assert.deepEqual(numberFa(855), ['digits/800-o', 'digits/50-o', 'digits/5']);
    assert.deepEqual(numberFa(900), ['digits/900']);
  });
  it('reads a tracking code in groups of three', () => {
    assert.deepEqual(sayCode('85504499'), ['digits/800-o', 'digits/50-o', 'digits/5', 'digits/40-o', 'digits/4', 'digits/90-o', 'digits/9']);
  });
  it('reads a mobile number 0 / 912 / 123 / 45 / 67, leading zeros one by one', () => {
    assert.deepEqual(sayMobile('09121234567'), ['digits/0', 'digits/900-o', 'digits/12', 'digits/hundred-o', 'digits/20-o', 'digits/3', 'digits/40-o', 'digits/5', 'digits/60-o', 'digits/7']);
    assert.deepEqual(sayMobile('09010023004'), ['digits/0', 'digits/900-o', 'digits/1', 'digits/0', 'digits/0', 'digits/2', 'digits/30', 'digits/0', 'digits/4']);
  });
});

describe('validation', () => {
  it('normalizes mobile numbers from caller ID or keys', () => {
    for (const m of ['09121234567', '9121234567', '989121234567', '+989121234567', '00989121234567']) assert.equal(normalizeMobile(m), '09121234567');
    assert.equal(normalizeMobile('1001'), null);
    assert.equal(normalizeMobile('0212345678'), null);
  });
  it('checks the national code checksum', () => {
    assert.equal(validNationalCode('1111111111'), true);
    assert.equal(validNationalCode('0013542419'), true);
    assert.equal(validNationalCode('1234567890'), false);
    assert.equal(validNationalCode('12345'), false);
  });
  it('reads list_days as returned by the booking system', () => {
    const ft = parseDays({ doctor_selected: 4, appointment_setting_id: 3, empty_times: {
      day2: { persian_day: '1405/08/11', times: [{ timestamp: 1793606400, from: '10:00' }] },
      day1: { persian_day: '1405/08/10', times: [{ timestamp: 1793520000, from: '11:30' }, { timestamp: 1793519460, from: '11:21' }] },
      day3: { times: [] },
    } });
    assert.deepEqual(ft, { doctor: '4', settingId: '3', days: [[1793519460, 1793520000], [1793606400]] });
    assert.equal(parseDays({ doctor_selected: null, appointment_setting_id: null, empty_times: null }), null);
  });
  it('writes a reminder call file for the booking system request', () => {
    const c = reminderCallFile({ mobile: '9121234567', time: '10:30', tracking_code: '85504499', appointment_id: 77 }, { ...BOOKING_DEFAULTS }, '982191090022');
    assert.equal(c.kind, 'remind');
    assert.match(c.body, /^Channel: Local\/09121234567@cc-outext$/m);
    assert.match(c.body, /^Context: cc-book-call$/m);
    assert.match(c.body, /^Extension: remind$/m);
    assert.match(c.body, /^Set: CC_BK_TIME=10:30$/m);
    assert.match(c.body, /^MaxRetries: 2$/m);
    assert.match(c.body, /^RetryTime: 3600$/m);
    const x = reminderCallFile({ kind: 'cancel', mobile: '09121234567', timestamp: 1793516400, tracking_code: '1', appointment_id: '2' }, { ...BOOKING_DEFAULTS }, '');
    assert.match(x.body, /^Extension: cancel$/m);
    assert.match(x.body, /^Set: CC_BK_TS=1793516400$/m);
    assert.throws(() => reminderCallFile({ mobile: '0212', time: '10:30', tracking_code: '1', appointment_id: '2' }, BOOKING_DEFAULTS, ''));
    assert.throws(() => reminderCallFile({ mobile: '09121234567', time: '25:00', tracking_code: '1', appointment_id: '2' }, BOOKING_DEFAULTS, ''));
  });
});

/** Scripted caller: answers GET DATA from a list, records every prompt it hears. */
class FakeChan implements AgiChan {
  heard: string[] = [];
  asked: string[] = [];
  recorded: string[] = [];
  constructor(private keys: (string | Error)[], public vars: Record<string, string> = { callerid: '09121234567' }) {}
  async streamFile(f: string) { this.heard.push(f.replace(DIR + '/', '')); }
  async getData(f: string) {
    const name = f.replace(DIR + '/', '');
    this.asked.push(name);
    this.heard.push(name);
    const k = this.keys.shift();
    if (k instanceof Error) throw k;
    return k ?? '';
  }
  async setVariable() {}
  async setMusic() {}
  async recordFile(f: string) { this.recorded.push(f); }
}

const day = 864e5;
const future = (d: number) => Math.floor((Date.now() + d * day) / 1000);
const T = [[future(1), future(1) + 600], [future(2)]];

function fakeApi(o: Partial<BookingApiLike> = {}) {
  const calls: Record<string, any[]> = { store: [], cancel: [], approve: [], mata: [] };
  const api: BookingApiLike = {
    freeTimes: o.freeTimes || (async (): Promise<FreeTimes> => ({ doctor: '4', settingId: '3', days: T })),
    store: o.store || (async (...a): Promise<Answer> => { calls.store.push(a); return { ok: true, code: '85504499' }; }),
    track: o.track || (async (): Promise<Tracked> => ({ found: true, id: '77', ts: future(3), active: true, canCancel: true })),
    cancel: o.cancel || (async (...a): Promise<Answer> => { calls.cancel.push(a); return { ok: true }; }),
    approve: o.approve || (async (...a): Promise<Answer> => { calls.approve.push(a); return { ok: true }; }),
    sendMataLink: o.sendMataLink || (async (...a): Promise<Answer> => { calls.mata.push(a); return { ok: true }; }),
  };
  return { api, calls };
}

const S = (o: Partial<BookingSettings> = {}): BookingSettings => ({ ...BOOKING_DEFAULTS, enabled: true, ...o });
const fresh = (): FlowState => ({ kind: 'none', result: 'hangup', offered: 0, steps: [] });
const ctx = (ch: AgiChan, api: BookingApiLike, s = S(), st = fresh()): FlowCtx => ({ ch, s, api, st, dir: DIR, recDir: '/mon' });

describe('booking (key 2)', () => {
  it('books the second time offered with the caller\'s mobile, reads the code and takes the survey', async () => {
    const ch = new FakeChan(['2', '2', '1', '1111111111', '1', '5']);
    const { api, calls } = fakeApi();
    const c = ctx(ch, api);
    await runBooking(c);
    assert.equal(c.st.result, 'booked');
    assert.equal(c.st.code, '85504499');
    assert.equal(c.st.offered, 2);
    assert.equal(c.st.natMasked, '******1111');
    assert.equal(c.st.survey, 5);
    assert.deepEqual(calls.store[0], ['09121234567', '4', T[0][1], '1111111111']);
    assert.deepEqual(ch.asked, [MSG.treated, MSG.chooseTime, MSG.chooseTime, MSG.codeMeli, MSG.mobileConfirm, MSG.survey]);
    assert.ok(ch.heard.includes(MSG.firstVisit));
    assert.ok(ch.heard.includes(MSG.mobileAuto));
    const yc = ch.heard.indexOf(MSG.yourCode);
    assert.deepEqual(ch.heard.slice(yc, yc + 9), [MSG.yourCode, ...sayCode('85504499'), MSG.forDay]);
    assert.equal(ch.recorded.length, 1);
    assert.match(ch.recorded[0], /^\/mon\/cc-svc\/booking-\d+-85504499$/);
    assert.deepEqual(ch.heard.slice(-2), [MSG.surveyRecord, MSG.surveyBye]);
  });

  it('records the path for the timeline, with the national code the caller keyed', async () => {
    const ch = new FakeChan(['2', '2', '1', '0013542419', '1', '4']);
    const c = ctx(ch, fakeApi().api, S(), { ...fresh(), t0: Date.now() });
    await runBooking(c);
    const st = c.st.steps;
    assert.deepEqual(st.map(x => x.s), ['treated', 'apiTimes', 'chooseTime', 'chooseTime', 'codeMeli', 'mobileConfirm', 'mobile', 'apiStore', 'survey', 'surveyScore', 'surveyRec']);
    assert.equal(st[1].v, '3 times · doctor 4');
    assert.deepEqual([st[2].k, st[2].v], ['2', String(T[0][0])]);
    assert.deepEqual([st[3].k, st[3].v], ['1', String(T[0][1])]);
    assert.equal(st[4].k, '0013542419');
    assert.equal(c.st.nationalCode, '0013542419');
    assert.equal(c.st.natMasked, '******2419');
    assert.equal(st[6].v, '09121234567');
    assert.equal(st[7].v, 'ok 85504499');
    assert.ok(st.every(x => typeof x.t === 'number' && x.t >= 0));
  });

  it('an API failure is on the timeline too', async () => {
    const c = ctx(new FakeChan(['2']), fakeApi({ freeTimes: async () => { throw new BookingApiError('HTTP 500', 500); } }).api);
    await runBooking(c);
    assert.equal(c.st.steps[1].s, 'apiTimes');
    assert.equal(c.st.steps[1].v, 'error: HTTP 500');
  });

  it('3 skips to the next day; without a mobile caller ID the number is keyed and read back', async () => {
    const ch = new FakeChan(['2', '3', '1', '1111111111', '09351234567', '1', '4'], { callerid: '1001' });
    const { api, calls } = fakeApi();
    const c = ctx(ch, api);
    await runBooking(c);
    assert.equal(c.st.result, 'booked');
    assert.equal(calls.store[0][2], T[1][0]);
    assert.equal(calls.store[0][0], '09351234567');
    assert.ok(ch.heard.includes(MSG.mobileIs));
    assert.ok(ch.asked.includes(MSG.enterMobile));
  });

  it('2 on the mobile question asks for another number', async () => {
    const ch = new FakeChan(['2', '1', '1111111111', '2', '09351234567', '1', '3']);
    const { api, calls } = fakeApi();
    await runBooking(ctx(ch, api));
    assert.equal(calls.store[0][0], '09351234567');
  });

  it('returning patient (1): the Mata app link goes by SMS to the caller\'s mobile', async () => {
    const ch = new FakeChan(['1', '1']);
    const { api, calls } = fakeApi();
    const c = ctx(ch, api);
    await runBooking(c);
    assert.equal(c.st.kind, 'mata');
    assert.equal(c.st.result, 'link_sent');
    assert.deepEqual(calls.mata[0], ['09121234567']);
    assert.deepEqual(ch.heard.slice(-1), [MSG.mataSent]);
  });

  it('a wrong national code is asked again; a duplicate booking is announced', async () => {
    const ch = new FakeChan(['2', '1', '1234567890', '1111111111', '1']);
    const c = ctx(ch, fakeApi({ store: async () => ({ ok: false, errorCode: 1, message: 'dup' }) }).api);
    await runBooking(c);
    assert.ok(ch.heard.includes(MSG.wrongCodeMeli));
    assert.equal(c.st.result, 'duplicate');
    assert.deepEqual(ch.heard.slice(-2), [MSG.duplicate, MSG.arezoo]);
  });

  it('* while choosing the time goes back to the menu (no goodbye)', async () => {
    const ch = new FakeChan(['2', '*']);
    const c = ctx(ch, fakeApi().api);
    await runBooking(c);
    assert.equal(c.st.result, 'back');
    assert.notEqual(ch.heard[ch.heard.length - 1], MSG.arezoo);
  });

  it('silence: «عددی وارد نشد» and the question again, then goodbye', async () => {
    const ch = new FakeChan(['', '', '', '']);
    const c = ctx(ch, fakeApi().api, S({ retries: 3 }));
    await runBooking(c);
    assert.equal(c.st.result, 'invalid');
    assert.equal(ch.heard.filter(f => f === MSG.noInput).length, 3);
    assert.equal(ch.heard[ch.heard.length - 1], MSG.arezoo);
  });

  it('no free time: «نوبتی یافت نشد» of the old line', async () => {
    const ch = new FakeChan(['2']);
    const c = ctx(ch, fakeApi({ freeTimes: async () => ({ doctor: '4', settingId: '3', days: [] }) }).api);
    await runBooking(c);
    assert.equal(c.st.result, 'no_slots');
    assert.deepEqual(ch.heard.slice(-1), [MSG.noTimes]);
  });

  it('booking system down: «نوبتی یافت نشد», goodbye only without a fallback', async () => {
    const down = fakeApi({ freeTimes: async () => { throw new BookingApiError('HTTP 500', 500); } }).api;
    let ch = new FakeChan(['2']);
    let c = ctx(ch, down);
    await runBooking(c);
    assert.equal(c.st.result, 'error');
    assert.equal(c.st.error, 'HTTP 500');
    assert.deepEqual(ch.heard.slice(-2), [MSG.notFound, MSG.arezoo]);
    ch = new FakeChan(['2']);
    c = ctx(ch, down, S({ fallback: 'q:1' }));
    await runBooking(c);
    assert.deepEqual(ch.heard.slice(-1), [MSG.notFound]);
  });

  it('without the «treated before» question it starts at the first free time', async () => {
    const ch = new FakeChan(['*']);
    await runBooking(ctx(ch, fakeApi().api, S({ askTreated: false })));
    assert.deepEqual(ch.asked, [MSG.chooseTime]);
  });

  it('keeps what is known when the caller hangs up half-way', async () => {
    const ch = new FakeChan(['2', '1', new AgiHangup()]);
    const c = ctx(ch, fakeApi().api);
    await assert.rejects(runBooking(c), AgiHangup);
    assert.equal(c.st.result, 'hangup');
    assert.ok(c.st.slotAt);
  });
});

describe('stages (report funnel)', () => {
  const run = async (keys: string[], api = fakeApi().api) => { const c = ctx(new FakeChan(keys), api); await runBooking(c).catch(() => {}); return { kind: c.st.kind, result: c.st.result, steps: c.st.steps }; };
  it('a caller who hangs up at the national code stopped at «کد ملی»', async () => {
    const r = await run(['2', '1', new AgiHangup() as any]);
    assert.deepEqual([...stagesReached(r)], ['enter', 'treated', 'times', 'chosen']);
    assert.equal(stoppedAt(r), 'nat');
  });
  it('declining every time offered stops at «انتخاب زمان»; silence at the first question at «سؤال اول»', async () => {
    assert.equal(stoppedAt(await run(['2', '', '', ''])), 'chosen');
    assert.equal(stoppedAt(await run(['', '', '', ''])), 'treated');
  });
  it('a booking reaches every stage and has no stop; the survey is counted when answered', async () => {
    const r = await run(['2', '1', '1111111111', '1', '4']);
    assert.equal(r.result, 'booked');
    assert.equal(stoppedAt(r), null);
    assert.ok(stagesReached(r).has('survey'));
  });
  it('a store failure stops at «ثبت نوبت»; a Mata-link call is not a booking', async () => {
    assert.equal(stoppedAt(await run(['2', '1', '1111111111', '1'], fakeApi({ store: async () => ({ ok: false, message: 'x' }) }).api)), 'booked');
    assert.equal(stoppedAt(await run(['1', '1'])), null);
  });
});

describe('follow-up (key 3)', () => {
  it('reads the appointment and cancels it with 1', async () => {
    const ch = new FakeChan(['1111111111', '85504499', '1']);
    const { api, calls } = fakeApi();
    const c = ctx(ch, api);
    await runTracking(c);
    assert.equal(c.st.result, 'cancelled');
    assert.deepEqual(calls.cancel[0], ['85504499', '77']);
    assert.deepEqual(ch.asked, [MSG.codeMeli, MSG.trackingCode, MSG.askCancel]);
    assert.deepEqual(ch.heard.slice(-2), [MSG.cancelled, MSG.arezoo]);
  });

  it('2 keeps the appointment and goes back to the menu', async () => {
    const ch = new FakeChan(['1111111111', '85504499', '2']);
    const c = ctx(ch, fakeApi().api);
    await runTracking(c);
    assert.equal(c.st.result, 'back');
  });

  it('an unknown code is asked again from the national code, then goodbye', async () => {
    const ch = new FakeChan(['1111111111', '1', '1111111111', '2', '1111111111', '3']);
    const c = ctx(ch, fakeApi({ track: async () => ({ found: false, id: '', ts: 0, active: false, canCancel: false }) }).api);
    await runTracking(c);
    assert.equal(c.st.result, 'not_found');
    assert.equal(ch.heard.filter(f => f === MSG.trackNotFound).length, 3);
  });

  it('a cancelled / inactive appointment is «not found»', async () => {
    const ch = new FakeChan(['1111111111', '85504499']);
    const c = ctx(ch, fakeApi({ track: async () => ({ found: true, id: '77', ts: future(3), active: false, canCancel: true }) }).api);
    await runTracking(c);
    assert.equal(c.st.result, 'inactive');
  });
});

describe('reminder and cancellation calls', () => {
  it('reminder: reads the time, 1 confirms', async () => {
    const ch = new FakeChan(['1']);
    const { api, calls } = fakeApi();
    const c = ctx(ch, api);
    await runReminder(c, { time: '10:30', code: '85504499', id: '77', mobile: '09121234567' });
    assert.equal(c.st.result, 'confirmed');
    assert.deepEqual(calls.approve[0], ['85504499', '77']);
    assert.deepEqual(ch.heard.slice(0, 5), [MSG.remindStart, 'digits/10', 'extra/va', 'digits/30', 'digits/daghigheh']);
  });

  it('reminder: 5 cancels the appointment', async () => {
    const ch = new FakeChan(['5']);
    const { api, calls } = fakeApi();
    const c = ctx(ch, api);
    await runReminder(c, { time: '09:00', code: '1', id: '2' });
    assert.equal(c.st.result, 'cancelled');
    assert.equal(calls.cancel.length, 1);
    assert.deepEqual(ch.heard.slice(0, 2), [MSG.remindStart, 'digits/9']);
  });

  it('cancellation notice reads the cancelled time', async () => {
    const ch = new FakeChan([]);
    const c = ctx(ch, fakeApi().api);
    await runCancelNotice(c, { ts: 1793516400, code: '1', id: '2' });
    assert.equal(c.st.result, 'notified');
    assert.deepEqual(ch.heard, [MSG.cancelNoticeStart, ...sayDate(new Date(1793516400e3)), MSG.cancelNoticeEnd, MSG.arezoo]);
  });
});

describe('FastAGI', () => {
  it('reads the session variables and talks the AGI protocol', async () => {
    const seen: string[] = [];
    let result = '';
    let vars: Record<string, string> = {};
    const done = new Promise<void>(resolve => {
      const server = startFastAgi(0, async ch => {
        vars = { ...ch.vars };
        await ch.streamFile('/snd/a');
        result = await ch.getData('/snd/b', 9000, 5);
        assert.equal(await ch.getData('/snd/c', 9000, 1), '');
        await ch.setMusic(true);
        await ch.recordFile('/mon/x', 30000);
        await ch.setVariable('BOOK_RESULT', 'booked');
        await assert.rejects(ch.streamFile('/snd/d'), AgiHangup);
      }, e => { throw e; });
      server.on('listening', () => {
        const port = (server.address() as net.AddressInfo).port;
        const replies = ['200 result=0 endpos=1200', '200 result=14560', '200 result= (timeout)', '200 result=0', '200 result=35 (dtmf) endpos=8000', '200 result=1', '511 Command Not Permitted on a dead channel or intercept routine'];
        const c = net.connect(port, '127.0.0.1', () => c.write('agi_network: yes\nagi_network_script: booking\nagi_uniqueid: 1730000000.12\nagi_callerid: 09121234567\n\n'));
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d: string) => {
          buf += d;
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) { seen.push(buf.slice(0, i)); buf = buf.slice(i + 1); c.write(replies.shift() + '\n'); }
        });
        c.on('close', () => { server.close(); resolve(); });
      });
    });
    await done;
    assert.equal(vars.network_script, 'booking');
    assert.equal(vars.callerid, '09121234567');
    assert.equal(result, '14560');
    assert.deepEqual(seen, ['STREAM FILE /snd/a ""', 'GET DATA /snd/b 9000 5', 'GET DATA /snd/c 9000 1', 'SET MUSIC ON default', 'RECORD FILE /mon/x wav "#" 30000 0 BEEP s=5', 'SET VARIABLE BOOK_RESULT "booked"', 'STREAM FILE /snd/d ""']);
  });
});

describe('dialplan', () => {
  const base = () => ({
    exts: [{ n: '1001', name: 'Reception' }], trunks: [], vqs: [{ id: 'q1', name: 'Main', num: '600', members: [] }],
    ivrs: [{ id: 'main', name: 'Main', opts: [{ k: '2', label: 'booking', dest: 'book' }, { k: '3', label: 'follow-up', dest: 'booktrack' }] }],
    snds: [], routes: [], tgroups: [], tconds: [], holidays: [], rgroups: [], fmes: {}, blist: [], bset: {},
  } as any);
  const ext = (cfg: any) => generate(cfg, { hookUrl: 'http://127.0.0.1:3000/api/hooks', hookSecret: 'x', mohDir: '/m' }).files['extensions.conf'];

  it('routes keys 2 / 3 and the test codes to the booking line; * goes back to the menu', () => {
    const e = ext({ ...base(), booking: { enabled: true, code: '*643', trackCode: '*644', fallback: 'q:q1', backDest: 'ivr:main' } });
    assert.match(e, /exten => 2,1,NoOp\(booking\)\n same => n,UserEvent\(CCEvent,Type: call\.ivr,[^\n]*\)\n same => n,Goto\(cc-book,s,1\)/);
    assert.match(e, /exten => 3,1,NoOp\(follow-up\)\n same => n,UserEvent\(CCEvent,Type: call\.ivr,[^\n]*\)\n same => n,Goto\(cc-book,track,1\)/);
    assert.match(e, /exten => \*643,1,Goto\(cc-book,s,1\)/);
    assert.match(e, /exten => \*644,1,Goto\(cc-book,track,1\)/);
    assert.match(e, /AGI\(agi:\/\/127\.0\.0\.1:4573\/booking\)/);
    assert.match(e, /AGI\(agi:\/\/127\.0\.0\.1:4573\/track\)/);
    assert.match(e, /"\$\{BOOK_RESULT\}"="back"\]\?cc-ivr-main,s,1\)/);
    assert.match(e, /n\(fail\),Goto\(cc-queue-q1,s,1\)/);
    assert.match(e, /\[cc-book-call\]\nexten => remind,1,Answer\(\)/);
  });

  it('sends calls to the fallback while the line is off, and drops the codes', () => {
    const cfg = { ...base(), booking: { enabled: false, code: '*643', trackCode: '*644', fallback: 'vm' } };
    assert.equal(destTarget('book', cfg), 'cc-vm,s,1');
    assert.equal(destTarget('booktrack', cfg), 'cc-vm,s,1');
    assert.doesNotMatch(ext(cfg), /exten => \*64[34]/);
    assert.equal(destTarget('book', { ...base(), booking: { enabled: false } }), 'cc-hang,s,1');
  });
});
