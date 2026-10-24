// Report builder → styled Excel workbook (RTL, Persian, brand colours).
// The panel sends the table exactly as computed on screen; the server only lays it out.
import { BadRequestException, Body, Controller, Post, Res } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { CurrentUser, Me } from './auth';
import { CallsService, faDigits } from './calls';
import { hhmm, jalaliDate, jalaliToDate } from './jalali';
import { PrismaService } from './prisma.service';

const C = { ink: 'FF2E2F31', ink2: 'FF3A3B3D', green: 'FF8DC63F', greenDark: 'FF3D6A0C', greenSoft: 'FFEEF5E3', zebra: 'FFF7F8F5', line: 'FFE7E8E3', grey: 'FF6B6E72', white: 'FFFFFFFF', red: 'FFB42318', blue: 'FF1D5A85', amber: 'FF8A5A00' };
const FONT = 'Tahoma';
const WD = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
const ST: Record<string, [string, string]> = { answered: ['پاسخ‌داده', C.greenDark], missed: ['بی‌پاسخ', C.red], voicemail: ['پیام صوتی', C.blue], transferred: ['انتقال‌یافته', C.amber] };

const al = (h: 'right' | 'center' = 'right') => ({ horizontal: h, vertical: 'middle', readingOrder: 'rtl', wrapText: true }) as any;
const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } }) as any;
const font = (o: any = {}) => ({ name: FONT, size: 10, color: { argb: C.ink }, ...o });
const num = (v: any) => (typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(String(v ?? '').trim()) ? +v : typeof v === 'string' ? faDigits(v) : v);
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

interface ReportBody {
  title: string; groupLabel: string; from: string; to: string; filters: string[];
  kpis: { label: string; value: any }[]; headers: string[];
  rows: { key: string; cells: any[]; count: number }[]; totals: any[]; total: number; ids: string[];
}

function sheetBase(wb: ExcelJS.Workbook, name: string, cols: number, tab: string) {
  const ws = wb.addWorksheet(name, {
    views: [{ rightToLeft: true, showGridLines: false }], properties: { tabColor: { argb: tab }, defaultRowHeight: 22 },
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  ws.headerFooter.oddFooter = '&L&8مرکز تماس دکتر افلاکی&R&8صفحه &P از &N';
  return ws;
}

function titleBlock(ws: ExcelJS.Worksheet, cols: number, title: string, sub: string, extra?: string) {
  ws.mergeCells(1, 1, 1, cols);
  Object.assign(ws.getCell(1, 1), { value: faDigits(title), font: font({ size: 16, bold: true, color: { argb: C.white } }), fill: fill(C.ink), alignment: al() });
  ws.getRow(1).height = 38;
  ws.mergeCells(2, 1, 2, cols);
  Object.assign(ws.getCell(2, 1), { value: faDigits(sub), font: font({ size: 10, color: { argb: 'FFD9DAD6' } }), fill: fill(C.ink2), alignment: al() });
  ws.getRow(2).height = 24;
  ws.mergeCells(3, 1, 3, cols);
  Object.assign(ws.getCell(3, 1), { value: faDigits(extra || ''), font: font({ size: 9, color: { argb: C.grey } }), fill: fill(C.green), alignment: al() });
  ws.getRow(3).height = extra ? 20 : 4;
}

function headerRow(ws: ExcelJS.Worksheet, r: number, labels: string[]) {
  const row = ws.getRow(r);
  labels.forEach((h, i) => Object.assign(row.getCell(i + 1), {
    value: h, font: font({ bold: true, color: { argb: C.white } }), fill: fill(C.ink), alignment: al('center'),
    border: { bottom: { style: 'medium', color: { argb: C.green } } },
  }));
  row.height = 30;
}

@Controller('reports')
export class ReportsController {
  constructor(private calls: CallsService, private db: PrismaService) {}

  @Post('export')
  async export(@Body() b: ReportBody, @CurrentUser() me: Me, @Res() res: Response) {
    if (!b || !Array.isArray(b.headers) || !Array.isArray(b.rows)) throw new BadRequestException('داده گزارش نامعتبر است');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'مرکز تماس دکتر افلاکی';
    wb.created = new Date();
    const made = `تهیه: ${me.name} · ${jalaliDate(new Date())} ساعت ${hhmm(new Date())}`;
    const sub = `مرکز تماس دکتر افلاکی  ·  بازه ${b.from} تا ${b.to}  ·  ${made}`;
    const filters = (b.filters || []).filter(Boolean);

    // ---------------- sheet 1: report
    const metricCols = b.headers.length - 1;
    const cols = 1 + metricCols + 1; // group, metrics, share
    const ws = sheetBase(wb, 'گزارش', cols, C.green);
    ws.columns = [{ width: 30 }, ...Array.from({ length: metricCols }, () => ({ width: 17 })), { width: 22 }];
    titleBlock(ws, cols, b.title, sub, filters.length ? 'فیلترها: ' + filters.join('  ·  ') : '');

    // summary box
    let r = 5;
    ws.mergeCells(r, 1, r, Math.min(cols, 3));
    Object.assign(ws.getCell(r, 1), { value: 'خلاصه گزارش', font: font({ bold: true, size: 12, color: { argb: C.greenDark } }), alignment: al() });
    r++;
    for (const k of b.kpis || []) {
      Object.assign(ws.getCell(r, 1), { value: k.label, font: font({ color: { argb: C.grey } }), fill: fill(C.greenSoft), alignment: al(), border: { bottom: { style: 'thin', color: { argb: C.white } } } });
      if (cols >= 3) ws.mergeCells(r, 2, r, Math.min(cols, 3));
      Object.assign(ws.getCell(r, 2), { value: num(k.value), font: font({ bold: true, size: 12 }), fill: fill(C.greenSoft), alignment: al('center'), border: { bottom: { style: 'thin', color: { argb: C.white } } } });
      ws.getRow(r).height = 24;
      r++;
    }

    // main table
    r += 1;
    ws.mergeCells(r, 1, r, cols);
    Object.assign(ws.getCell(r, 1), { value: `جدول گزارش بر اساس ${b.groupLabel}`, font: font({ bold: true, size: 12, color: { argb: C.greenDark } }), alignment: al() });
    r++;
    const headR = r;
    headerRow(ws, r, [...b.headers, 'سهم از کل تماس‌ها']);
    r++;
    const first = r;
    b.rows.forEach((row, i) => {
      const x = ws.getRow(r);
      const bg = i % 2 ? C.zebra : C.white;
      Object.assign(x.getCell(1), { value: faDigits(String(row.key)), font: font({ bold: true }), fill: fill(bg), alignment: al() });
      row.cells.forEach((v, k) => Object.assign(x.getCell(k + 2), { value: num(v), font: font(), fill: fill(bg), alignment: al('center') }));
      Object.assign(x.getCell(cols), { value: b.total ? row.count / b.total : 0, numFmt: '0%', font: font({ color: { argb: C.greenDark }, bold: true }), fill: fill(bg), alignment: al('center') });
      for (let k = 1; k <= cols; k++) x.getCell(k).border = { bottom: { style: 'hair', color: { argb: C.line } } };
      x.height = 24;
      r++;
    });
    if (b.rows.length) {
      ws.addConditionalFormatting({ ref: `${ws.getColumn(cols).letter}${first}:${ws.getColumn(cols).letter}${r - 1}`, rules: [{ type: 'dataBar', priority: 1, minLength: 0, maxLength: 100, gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: C.green } } as any] });
    }
    // totals
    const t = ws.getRow(r);
    const tb = { top: { style: 'medium', color: { argb: C.green } }, bottom: { style: 'medium', color: { argb: C.green } } } as any;
    Object.assign(t.getCell(1), { value: 'جمع کل', font: font({ bold: true, color: { argb: C.greenDark }, size: 11 }), fill: fill(C.greenSoft), alignment: al(), border: tb });
    (b.totals || []).forEach((v, k) => Object.assign(t.getCell(k + 2), { value: num(v), font: font({ bold: true, size: 11 }), fill: fill(C.greenSoft), alignment: al('center'), border: tb }));
    Object.assign(t.getCell(cols), { value: b.total ? 1 : 0, numFmt: '0%', font: font({ bold: true, size: 11 }), fill: fill(C.greenSoft), alignment: al('center'), border: tb });
    t.height = 28;
    ws.views = [{ rightToLeft: true, showGridLines: false, state: 'frozen', ySplit: headR }];
    if (!b.rows.length) {
      ws.mergeCells(r + 2, 1, r + 2, cols);
      Object.assign(ws.getCell(r + 2, 1), { value: 'در این بازه و با این فیلترها تماسی پیدا نشد.', font: font({ color: { argb: C.grey } }), alignment: al('center') });
    }

    // ---------------- sheet 2: calls in the report
    const ids = new Set((b.ids || []).map(String));
    const list = (await this.calls.list('1300/01/01')).filter(c => ids.has(c.id)).sort((a, z) => `${a.date} ${a.time}`.localeCompare(`${z.date} ${z.time}`));
    const dh = ['ردیف', 'تاریخ', 'روز', 'ساعت', 'شماره', 'جهت', 'وضعیت', 'صف / مسیر', 'پاسخ‌دهنده', 'انتظار (ثانیه)', 'مدت مکالمه', 'ضبط', 'تاریخ جراحی (سامانه بیماران)'];
    const ws2 = sheetBase(wb, 'جزئیات تماس‌ها', dh.length, C.ink);
    ws2.columns = [7, 12, 11, 8, 15, 9, 13, 30, 18, 12, 12, 9, 24].map(width => ({ width }));
    titleBlock(ws2, dh.length, 'جزئیات تماس‌های این گزارش', `${list.length} تماس  ·  ${sub}`);
    headerRow(ws2, 5, dh);
    list.forEach((c, i) => {
      const x = ws2.getRow(6 + i);
      const bg = i % 2 ? C.zebra : C.white;
      const [stl, stc] = ST[c.st] || [c.st, C.ink];
      const vals = [i + 1, c.date, WD[jalaliToDate(c.date).getUTCDay()], c.time, c.phoneRaw, c.dir === 'in' ? 'ورودی' : 'خروجی', stl, c.queue,
        c.op ? `${c.op.name} (${c.op.ext})` : '—', c.wait, c.dur ? mmss(c.dur) : '—', c.hasRec ? 'دارد' : '—', c.surgery || '—'];
      vals.forEach((v, k) => {
        const cell = x.getCell(k + 1);
        Object.assign(cell, { value: typeof v === 'string' && k !== 4 ? faDigits(v) : v, font: font(k === 6 ? { bold: true, color: { argb: stc } } : {}), fill: fill(bg), alignment: al(k === 7 || k === 8 ? 'right' : 'center'), border: { bottom: { style: 'hair', color: { argb: C.line } } } });
        if (k === 4) cell.numFmt = '@';
      });
      x.height = 22;
    });
    ws2.views = [{ rightToLeft: true, showGridLines: false, state: 'frozen', ySplit: 5 }];
    if (list.length) ws2.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: dh.length } };

    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'report.export', target: b.title, detail: { from: b.from, to: b.to, rows: b.rows.length, calls: list.length } } });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(b.title)}.xlsx`);
    res.send(Buffer.from(buf as ArrayBuffer));
  }

  /** «گزارش روزها»: summary sheet plus one sheet per table, each exactly as shown in the panel. */
  @Post('days')
  async days(@Body() b: { title: string; from: string; to: string; filters: string[]; kpis: { label: string; value: any }[]; sheets: { name: string; headers: string[]; rows: any[][] }[] }, @CurrentUser() me: Me, @Res() res: Response) {
    if (!b || !Array.isArray(b.sheets) || !b.sheets.length) throw new BadRequestException('داده گزارش نامعتبر است');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'مرکز تماس دکتر افلاکی';
    wb.created = new Date();
    const sub = `مرکز تماس دکتر افلاکی  ·  بازه ${b.from} تا ${b.to}  ·  تهیه: ${me.name} · ${jalaliDate(new Date())} ساعت ${hhmm(new Date())}`;
    const filters = 'فیلترها: ' + (b.filters || []).filter(Boolean).join('  ·  ');
    const tabs = [C.green, C.blue, C.ink, C.greenDark, C.amber, C.ink2];

    b.sheets.slice(0, 12).forEach((sh, si) => {
      const cols = Math.max(2, sh.headers.length);
      const ws = sheetBase(wb, String(sh.name).slice(0, 30) || 'برگه ' + (si + 1), cols, tabs[si % tabs.length]);
      ws.columns = sh.headers.map((h, i) => ({ width: i === 0 ? 30 : Math.max(12, Math.min(22, h.length + 4)) }));
      titleBlock(ws, cols, `${b.title} — ${sh.name}`, sub, filters);
      let r = 5;
      // the first sheet also carries the headline numbers
      if (si === 0 && b.kpis?.length) {
        ws.mergeCells(r, 1, r, Math.min(cols, 3));
        Object.assign(ws.getCell(r, 1), { value: 'خلاصه', font: font({ bold: true, size: 12, color: { argb: C.greenDark } }), alignment: al() });
        r++;
        for (const k of b.kpis) {
          Object.assign(ws.getCell(r, 1), { value: faDigits(k.label), font: font({ color: { argb: C.grey } }), fill: fill(C.greenSoft), alignment: al() });
          ws.mergeCells(r, 2, r, Math.min(cols, 4));
          Object.assign(ws.getCell(r, 2), { value: num(k.value), font: font({ bold: true, size: 11 }), fill: fill(C.greenSoft), alignment: al() });
          ws.getRow(r).height = 22;
          r++;
        }
        r++;
      }
      const headR = r;
      headerRow(ws, r, sh.headers);
      r++;
      (sh.rows || []).forEach((row, i) => {
        const x = ws.getRow(r);
        const bg = i % 2 ? C.zebra : C.white;
        row.forEach((v, k) => Object.assign(x.getCell(k + 1), { value: num(v), font: font(k === 0 ? { bold: true } : {}), fill: fill(bg), alignment: al(k === 0 ? 'right' : 'center'), border: { bottom: { style: 'hair', color: { argb: C.line } } } }));
        x.height = 22;
        r++;
      });
      if (!sh.rows?.length) {
        ws.mergeCells(r + 1, 1, r + 1, cols);
        Object.assign(ws.getCell(r + 1, 1), { value: 'در این بازه و با این فیلترها داده‌ای نیست.', font: font({ color: { argb: C.grey } }), alignment: al('center') });
      }
      ws.views = [{ rightToLeft: true, showGridLines: false, state: 'frozen', ySplit: headR }];
    });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'report.days', target: b.title, detail: { from: b.from, to: b.to } } });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="days.xlsx"; filename*=UTF-8''${encodeURIComponent(b.title)}.xlsx`);
    res.send(Buffer.from(buf as ArrayBuffer));
  }
}
