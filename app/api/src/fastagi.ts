// Minimal FastAGI (agi://) server. Asterisk opens one TCP connection per AGI() call, sends its agi_* variables,
// then waits for commands one line at a time. Closing the socket hands the call back to the dialplan.
import * as net from 'net';

/** The caller hung up (or the channel died): stop the script, nothing more can be played. */
export class AgiHangup extends Error {
  constructor() { super('caller hung up'); }
}

export interface AgiReply { code: number; result: string; data: string }

/** What a call script needs from the channel (a fake one is used in tests). */
export interface AgiChan {
  readonly vars: Record<string, string>;
  streamFile(file: string): Promise<void>;
  /** Plays the prompt and collects up to `max` digits; '' when the caller pressed nothing. */
  getData(file: string, timeoutMs: number, max: number): Promise<string>;
  setVariable(name: string, value: string): Promise<void>;
  /** Music on hold while the script waits (e.g. for the booking system). */
  setMusic(on: boolean): Promise<void>;
  /** Records the caller into `file` (no extension, wav) after a beep; # or silence ends it. */
  recordFile(file: string, maxMs: number): Promise<void>;
}

const REPLY_TIMEOUT = 180e3;

export function parseReply(line: string): AgiReply {
  const m = /^(\d{3})(?:[ -]result=(\S*))?\s*(?:\((.*)\))?/.exec(line);
  if (!m) return { code: 0, result: '', data: line };
  return { code: +m[1], result: m[2] ?? '', data: m[3] ?? '' };
}

export class AgiChannel implements AgiChan {
  readonly vars: Record<string, string> = {};
  private buf = '';
  private lines: string[] = [];
  private waiter: ((l: string | null) => void) | null = null;
  private closed = false;
  hungUp = false;

  constructor(private sock: net.Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        // Asterisk tells a FastAGI script about the hang-up out of band
        if (line === 'HANGUP') { this.hungUp = true; continue; }
        this.deliver(line);
      }
    });
    sock.on('close', () => { this.closed = true; this.deliver(null); });
    sock.on('error', () => {});
  }

  private deliver(line: string | null) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(line); }
    else if (line !== null) this.lines.push(line);
  }

  private next(ms = REPLY_TIMEOUT): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      const t = setTimeout(() => { this.waiter = null; resolve(null); }, ms);
      this.waiter = l => { clearTimeout(t); resolve(l); };
    });
  }

  /** Reads the agi_* block that opens every session. */
  async init(): Promise<this> {
    for (;;) {
      const l = await this.next(10e3);
      if (l === null) throw new Error('AGI session closed before its variables arrived');
      if (l === '') return this;
      const m = /^agi_(\w+):\s?(.*)$/.exec(l);
      if (m) this.vars[m[1]] = m[2];
    }
  }

  async send(cmd: string): Promise<AgiReply> {
    if (this.hungUp || this.closed) throw new AgiHangup();
    this.sock.write(cmd + '\n');
    let line = await this.next();
    if (line === null) throw new AgiHangup();
    // usage errors come as a «520-…» block ending with «520 End of proper usage.»
    if (line.startsWith('520-')) while (line !== null && !line.startsWith('520 ')) line = await this.next();
    const r = parseReply(line || '');
    if (r.code === 511) throw new AgiHangup();
    if (r.code !== 200) throw new Error(`AGI «${cmd.split(' ').slice(0, 2).join(' ')}» failed: ${line}`);
    return r;
  }

  async streamFile(file: string) {
    const r = await this.send(`STREAM FILE ${file} ""`);
    if (r.result === '-1') throw new AgiHangup();
  }

  async getData(file: string, timeoutMs: number, max: number) {
    const r = await this.send(`GET DATA ${file} ${Math.round(timeoutMs)} ${max}`);
    if (r.result === '-1') throw new AgiHangup();
    return r.result.replace(/[^0-9*#]/g, '');
  }

  async setVariable(name: string, value: string) {
    await this.send(`SET VARIABLE ${name} "${String(value).replace(/["\\\r\n]/g, '')}"`);
  }

  async setMusic(on: boolean) {
    await this.send(on ? 'SET MUSIC ON default' : 'SET MUSIC OFF');
  }

  async recordFile(file: string, maxMs: number) {
    const r = await this.send(`RECORD FILE ${file} wav "#" ${Math.round(maxMs)} 0 BEEP s=5`);
    if (r.result === '-1') throw new AgiHangup();
  }

  close() { this.closed = true; this.sock.end(); }
}

/** Listens on loopback only: the dialplan is the one client (AGI(agi://127.0.0.1:<port>/<script>)). */
export function startFastAgi(port: number, onCall: (ch: AgiChannel) => Promise<void>, onError: (e: Error) => void) {
  const server = net.createServer(sock => {
    const ch = new AgiChannel(sock);
    ch.init()
      .then(() => onCall(ch))
      .catch(e => { if (!(e instanceof AgiHangup)) onError(e); })
      .finally(() => ch.close());
  });
  server.on('error', onError);
  server.listen(port, '127.0.0.1');
  return server;
}
