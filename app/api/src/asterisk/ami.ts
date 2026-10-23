// Minimal Asterisk Manager Interface client: actions with ActionID, list responses, events, auto-reconnect.
import { EventEmitter } from 'events';
import * as net from 'net';

export type Msg = Record<string, string>;

export class Ami extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = '';
  private seq = 0;
  private pending = new Map<string, { res: Msg | null; events: Msg[]; list: boolean; resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  connected = false;

  constructor(private host: string, private port: number, private user: string, private secret: string) { super(); }

  start() { this.connect(); }

  private connect() {
    const s = net.connect(this.port, this.host);
    this.sock = s;
    s.setEncoding('utf8');
    s.on('connect', async () => {
      try {
        await this.action({ Action: 'Login', Username: this.user, Secret: this.secret, Events: 'call,agent,system,user' });
        this.connected = true;
        this.emit('ready');
      } catch (e) { this.emit('error', e); s.destroy(); }
    });
    s.on('data', (d: string) => this.onData(d));
    s.on('error', () => { /* handled by close */ });
    s.on('close', () => {
      this.connected = false;
      this.buf = '';
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('AMI disconnected')); }
      this.pending.clear();
      setTimeout(() => this.connect(), 3000);
    });
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\r\n\r\n')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 4);
      const m: Msg = {};
      const out: string[] = [];
      for (const line of raw.split('\r\n')) {
        const k = line.indexOf(': ');
        if (k > 0) { const key = line.slice(0, k); if (key === 'Output') out.push(line.slice(k + 2)); else m[key] = line.slice(k + 2); }
        else if (line && !line.startsWith('Asterisk Call Manager')) out.push(line);
      }
      if (out.length) m.Output = out.join('\n');
      if (Object.keys(m).length) this.dispatch(m);
    }
  }

  private dispatch(m: Msg) {
    const id = m.ActionID;
    const p = id ? this.pending.get(id) : undefined;
    if (p) {
      if (m.Response) {
        p.res = m;
        if (m.Response === 'Error') { this.finish(id, null, new Error(m.Message || 'AMI error')); return; }
        if (p.list && m.EventList === 'start') return; // wait for the events
        this.finish(id, p.list ? { ...m, events: [] } : m);
        return;
      }
      if (m.Event) {
        if (m.EventList === 'Complete' || /Complete$/.test(m.Event)) { this.finish(id, { ...(p.res || {}), events: p.events }); return; }
        p.events.push(m);
        return;
      }
    }
    if (m.Event) this.emit('event', m);
  }

  private finish(id: string, v: any, err?: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    err ? p.reject(err) : p.resolve(v);
  }

  /** Send an action. `list` collects the event list until its *Complete event. */
  action(a: Record<string, any>, list = false, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('AMI not connected'));
      if (!this.connected && a.Action !== 'Login') return reject(new Error('AMI not connected'));
      const id = 'cc' + (++this.seq);
      const timer = setTimeout(() => this.finish(id, null, new Error('AMI timeout: ' + a.Action)), timeoutMs);
      this.pending.set(id, { res: null, events: [], list, resolve, reject, timer });
      let s = `ActionID: ${id}\r\n`;
      for (const [k, v] of Object.entries(a)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach(x => { s += `${k}: ${x}\r\n`; });
        else s += `${k}: ${v}\r\n`;
      }
      this.sock.write(s + '\r\n');
    });
  }

  async command(cmd: string) {
    const r = await this.action({ Action: 'Command', Command: cmd });
    return r.Output || '';
  }
}
