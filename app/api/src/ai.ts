// AI pipeline: speech-to-text (pluggable HTTP service) + keyword analysis of the Persian transcript.
// Without STT_URL the calls stay "pending" and the UI shows «در انتظار تحلیل».
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { Bus } from './bus';
import { env } from './env';
import { PrismaService } from './prisma.service';

const RULES: { cat: string; kw: string[] }[] = [
  { cat: 'postop', kw: ['جراحی', 'عمل', 'بخیه', 'چسب', 'ورم', 'درد', 'کبودی', 'پانسمان'] },
  { cat: 'book', kw: ['نوبت', 'وقت', 'ویزیت', 'رزرو'] },
  { cat: 'cost', kw: ['هزینه', 'قیمت', 'اقساط', 'پرداخت', 'تعرفه', 'بیمه'] },
  { cat: 'consult', kw: ['مشاوره', 'انحراف', 'تنفس', 'سوال', 'سؤال'] },
  { cat: 'complaint', kw: ['شکایت', 'نارضایتی', 'جواب ندادید', 'کسی جواب', 'بد'] },
  { cat: 'cancel', kw: ['لغو', 'کنسل', 'جابه‌جا', 'جابجا', 'تغییر نوبت', 'نمی‌تونم بیام'] },
];
const NEG = ['درد', 'شکایت', 'ناراضی', 'بد', 'عصبانی', 'فوری', 'خونریزی', 'تب'];
const POS = ['ممنون', 'عالی', 'راضی', 'سپاس', 'خوب'];
const URGENT = ['فوری', 'خونریزی', 'تب', 'اورژانس', 'درد شدید', 'هرچه زودتر'];

export function analyze(text: string, conf: number) {
  const t = text || '';
  const scored = RULES.map(r => ({ cat: r.cat, n: r.kw.filter(k => t.includes(k)).length, kw: r.kw.filter(k => t.includes(k)) })).sort((a, b) => b.n - a.n);
  const top = scored[0].n ? scored[0] : { cat: 'consult', n: 0, kw: [] as string[] };
  const neg = NEG.filter(k => t.includes(k)).length, pos = POS.filter(k => t.includes(k)).length;
  const sent = top.cat === 'complaint' || neg > pos + 1 ? 'neg' : pos > neg ? 'pos' : 'neu';
  const urg = URGENT.some(k => t.includes(k)) || top.cat === 'complaint' ? 'high' : top.cat === 'postop' || top.cat === 'cancel' ? 'mid' : 'low';
  const sum = t.split(/[.!؟?\n]+/).map(s => s.trim()).filter(s => s.length > 8).slice(0, 3);
  return { cat: top.cat, tx: t, sum: sum.length ? sum : [t.slice(0, 120)], kw: top.kw.slice(0, 5), urg, sent, conf };
}

@Injectable()
export class AiService {
  private log = new Logger('AI');
  private q: string[] = [];
  private busy = false;
  constructor(private db: PrismaService, private bus: Bus) {}

  enqueue(id: string) { this.q.push(id); this.next(); }

  private async next() {
    if (this.busy || !this.q.length) return;
    this.busy = true;
    const id = this.q.shift()!;
    try { await this.process(id); } catch (e) { this.log.warn(id + ': ' + (e as Error).message); await this.db.call.update({ where: { id }, data: { aiState: 'failed' } }).catch(() => {}); }
    this.busy = false;
    this.next();
  }

  private async process(id: string) {
    const c = await this.db.call.findUnique({ where: { id } });
    if (!c || !c.recPath || !env.sttUrl) return; // no speech-to-text service configured yet
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(c.recPath)], { type: 'audio/wav' }), id + '.wav');
    fd.append('language', 'fa');
    const r = await fetch(env.sttUrl, { method: 'POST', body: fd, signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error('STT ' + r.status);
    const d: any = await r.json();
    const ai = analyze(String(d.text || ''), Math.round((d.confidence ?? 0.9) * 100));
    await this.db.call.update({ where: { id }, data: { ai: ai as any, aiState: 'done' } });
    this.bus.emit('calls', { id });
    if (ai.urg === 'high') this.bus.emit('notify', { role: '*', text: 'پیام فوری جدید: ' + ai.sum[0] });
  }
}
