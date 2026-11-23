// Sounds (System Recordings / Music on Hold) upload + conversion, and trunk connectivity test.
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { execFile } from 'child_process';
import type { Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { AsteriskService } from './asterisk/asterisk.service';
import { CurrentUser, Me, Roles, Perm } from './auth';
import { ConfigStore } from './config';
import { env } from './env';
import { todayJ } from './jalali';
import { PrismaService } from './prisma.service';
import { assertTenantStorageRoom } from './tenant-storage';

const run = promisify(execFile);

@Controller()
export class MediaController {
  constructor(private store: ConfigStore, private ast: AsteriskService, private db: PrismaService) {}

  @Perm('vsound', 'add')
  @Post('sounds')
  @UseInterceptors(FileInterceptor('file', { dest: os.tmpdir(), limits: { fileSize: 40 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File, @Body() b: { cat?: string }, @CurrentUser() me: Me) {
    if (!file) throw new BadRequestException('فایلی ارسال نشد');
    // Check quota before converting (use upload size as lower bound)
    if (me.tenantId) {
      await assertTenantStorageRoom(this.db, me.tenantId, file.size || 0);
    }
    const id = 's' + Date.now();
    const out = path.join(env.soundsDir, id + '.wav');
    fs.mkdirSync(env.soundsDir, { recursive: true });
    try {
      // Asterisk-native format: 8 kHz, mono, 16-bit PCM
      await run('ffmpeg', ['-y', '-v', 'error', '-i', file.path, '-ac', '1', '-ar', '8000', '-sample_fmt', 's16', out]);
    } catch (e) {
      throw new BadRequestException('فایل صوتی قابل تبدیل نیست (wav یا mp3 بارگذاری کنید)');
    } finally { fs.rmSync(file.path, { force: true }); }
    // Re-check with actual converted size
    if (me.tenantId) {
      try {
        const sz = fs.existsSync(out) ? fs.statSync(out).size : 0;
        await assertTenantStorageRoom(this.db, me.tenantId, sz);
      } catch (e) {
        fs.rmSync(out, { force: true });
        throw e;
      }
    }
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/\.[^.]+$/, '');
    const sound = { id, name, cat: ['greet', 'moh', 'queue', 'after', 'ivr'].includes(b.cat || '') ? b.cat : 'greet', dur: Math.round(+stdout || 0), date: todayJ(), file: name + '.wav' };
    const cfg = await this.store.forUser(me);
    const r = await this.store.save('snds', [sound, ...(cfg.snds || [])], me);
    return { sound, snds: r.data };
  }

  @Get('sounds/:id/file')
  sound(@Param('id') id: string, @Res() res: Response) {
    const f = path.join(env.soundsDir, id.replace(/[^A-Za-z0-9_-]/g, '') + '.wav');
    if (!fs.existsSync(f)) throw new NotFoundException('فایل صوتی پیدا نشد');
    res.sendFile(f);
  }

  @Perm('vtrunk', 'view')
  @Post('trunks/:id/test')
  test(@Param('id') id: string) { return this.ast.testTrunk(id.replace(/[^A-Za-z0-9_-]/g, '')); }
}
