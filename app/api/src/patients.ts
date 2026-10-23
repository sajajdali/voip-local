// Patient directory: local table, refreshed from the clinic booking system's API when configured.
import { Injectable, Logger } from '@nestjs/common';
import { env } from './env';
import { PrismaService } from './prisma.service';

@Injectable()
export class PatientsService {
  private log = new Logger('Patients');
  constructor(private db: PrismaService) {}

  /** Look the caller up in the clinic system (by mobile number) and cache the result locally. */
  async ensure(phone: string) {
    if (!env.clinicApiUrl || !/^\d{6,}$/.test(phone)) return;
    const cur = await this.db.patient.findUnique({ where: { phone } });
    if (cur && cur.source === 'clinic' && Date.now() - cur.updatedAt.getTime() < 86400e3) return;
    try {
      const url = env.clinicApiUrl.replace(/\/$/, '') + env.clinicLookupPath.replace('{phone}', encodeURIComponent(phone));
      const r = await fetch(url, { headers: env.clinicApiToken ? { Authorization: 'Bearer ' + env.clinicApiToken } : {}, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return;
      let d: any = await r.json();
      if (Array.isArray(d)) d = d[0];
      if (d && d.data) d = Array.isArray(d.data) ? d.data[0] : d.data;
      if (!d) return;
      const name = d.name || d.fullName || d.full_name || [d.firstName || d.first_name, d.lastName || d.last_name].filter(Boolean).join(' ');
      if (!name) return;
      const nidRaw = String(d.nationalCode || d.national_code || d.nid || '');
      const nid = nidRaw.length >= 6 ? nidRaw.slice(0, 3) + '•••••' + nidRaw.slice(-2) : nidRaw || null;
      const surgery = d.surgeryDate || d.surgery_date || d.lastSurgery || null;
      await this.db.patient.upsert({ where: { phone }, create: { phone, name, nid, surgery, source: 'clinic' }, update: { name, nid, surgery, source: 'clinic' } });
    } catch (e) { this.log.warn('clinic lookup failed: ' + (e as Error).message); }
  }
}
