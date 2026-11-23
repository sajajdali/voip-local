// «شارژ دلاری»: connecting to the top-up server, and AI requests going through it with the customer key and metering headers.
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { AiService } from '../ai';
import { BillingService } from '../billing';
import { UsageService, usageCtx } from '../usage';

const KEY = 'nrn_' + 'a'.repeat(40);
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A stand-in for the central top-up server. */
function fakeServer() {
  const seen: Seen[] = [];
  let mode: 'ok' | 'broke' = 'ok';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const json = (code: number, d: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: { message: 'کلید اتصال به حساب شارژ نامعتبر است', code: 'invalid_key' } });
      if (mode === 'broke' && req.url!.includes('/openai/')) return json(402, { error: { message: 'موجودی حساب شارژ تمام شده است؛ لطفاً حساب را شارژ کنید', code: 'insufficient_balance' } });
      if (req.url === '/api/v1/account') return json(200, { name: 'کلینیک تست', balance_usd: 12.5, rate_irr: 1050000 });
      if (req.url!.startsWith('/api/v1/statement')) return json(200, { transactions: [], usage: [], invoices: [] });
      if (req.url === '/api/v1/topups') return json(201, { id: '3909499e-107f-4a62-8e5c-26a3e812fde8', status: 'pending', usd: JSON.parse(body).usd, pay_url: 'http://pay/x' });
      if (req.url === '/api/v1/openai/chat/completions') return json(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      if (req.url === '/api/v1/openai/audio/transcriptions') return json(200, { text: 'سلام' });
      json(404, { error: { message: 'not found' } });
    });
  });
  return { srv, seen, setMode: (m: 'ok' | 'broke') => (mode = m) };
}

/** Just enough of Prisma for these services. */
function fakeDb() {
  const config: Record<string, any> = { ai: { enabled: true } };
  return {
    config,
    configEntry: {
      findUnique: async ({ where }: any) => (config[where.key] ? { key: where.key, data: config[where.key] } : null),
      upsert: async ({ where, create }: any) => { config[where.key] = create.data; return create; },
    },
    auditLog: { create: async () => ({}) },
    aiUsage: { create: async () => ({}) },
  } as any;
}

describe('billing (top-up server)', () => {
  const fake = fakeServer();
  let url = '';
  const db = fakeDb();
  const billing = new BillingService(db);
  const ai = new AiService(db, { emit() {} } as any, new UsageService(db), billing);
  const me = { id: 'u1', name: 'مدیر', role: 'admin', ext: null, username: 'admin' };

  before(async () => {
    await new Promise<void>(r => fake.srv.listen(0, '127.0.0.1', () => r()));
    url = 'http://127.0.0.1:' + (fake.srv.address() as AddressInfo).port;
  });
  after(() => fake.srv.close());

  it('refuses to switch on without a working connection, and never returns the key', async () => {
    await assert.rejects(billing.save({ enabled: true, url, key: '' }, me), /آدرس سرور شارژ و کلید اتصال/);
    await assert.rejects(billing.save({ enabled: true, url, key: 'nrn_' + 'b'.repeat(40) }, me), /کلید اتصال به حساب شارژ نامعتبر است/);
    await assert.rejects(billing.save({ enabled: true, url: 'http://127.0.0.1:1', key: KEY }, me), /ارتباط با سرور شارژ برقرار نشد/);
    assert.equal(await billing.route(), null);

    const r = await billing.save({ enabled: true, url: url + '/', key: KEY }, me);
    assert.equal(r.account.balance_usd, 12.5);
    assert.equal(JSON.stringify(r.settings).includes(KEY), false);
    assert.deepEqual(await billing.route(), { base: url + '/api/v1/openai', key: KEY });
  });

  it('analysis goes to the top-up server with the customer key, feature and call id', async () => {
    const s = await (ai as any).effectiveLlm();
    assert.equal(s.llmUrl, url + '/api/v1/openai');
    assert.equal(s.llmModel, 'gpt-6-luna');
    const out = await usageCtx.run({ feature: 'call', callId: 'C42' }, () => ai.llmJson('sys', 'user', { type: 'object' }, s));
    assert.deepEqual(out, { ok: true });
    const req = fake.seen.find(x => x.url === '/api/v1/openai/chat/completions')!;
    assert.equal(req.headers.authorization, 'Bearer ' + KEY);
    assert.equal(req.headers['x-feature'], 'call');
    assert.equal(req.headers['x-call-id'], 'C42');
    assert.match(String(req.headers['x-request-id']), /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(req.body).model, 'gpt-6-luna');
  });

  it('speech-to-text goes there too', async () => {
    const wav = path.join(os.tmpdir(), 'billing-test.wav');
    fs.writeFileSync(wav, Buffer.alloc(16044));
    const s = await (ai as any).effectiveStt();
    const r = await usageCtx.run({ feature: 'voicemail' }, () => ai.transcribe(wav, s));
    assert.equal(r.text, 'سلام');
    const req = fake.seen.find(x => x.url === '/api/v1/openai/audio/transcriptions')!;
    assert.equal(req.headers.authorization, 'Bearer ' + KEY);
    assert.equal(req.headers['x-feature'], 'voicemail');
    assert.match(req.body, /name="model"\r\n\r\ngpt-transcribe/);
    fs.unlinkSync(wav);
  });

  it('an empty balance shows the server’s Persian message', async () => {
    fake.setMode('broke');
    const s = await (ai as any).effectiveLlm();
    await assert.rejects(ai.llmJson('sys', 'user', {}, s), /سرویس تحلیل: موجودی حساب شارژ تمام شده است/);
    fake.setMode('ok');
  });

  it('overview and top-up', async () => {
    const o = await billing.overview();
    assert.equal(o.configured, true);
    assert.equal(o.account.name, 'کلینیک تست');
    const t = await billing.topup(19.999, 'https://voip.example.ir/');
    assert.equal(t.usd, 20);
    assert.equal(JSON.parse(fake.seen.at(-1)!.body).return_url, 'https://voip.example.ir/');
  });

  it('switching off sends AI back to the panel’s own settings', async () => {
    await billing.save({ enabled: false }, me);
    assert.equal(await billing.route(), null);
    const s = await (ai as any).effectiveLlm();
    assert.notEqual(s.llmUrl, url + '/api/v1/openai');
    assert.equal(s.billed, undefined);
  });
});
