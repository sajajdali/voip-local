// WebSocket push: live extension/queue/trunk state, new calls, follow-up changes, click-to-call progress.
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AsteriskService } from './asterisk/asterisk.service';
import { currentUser, verifyToken } from './auth';
import { CONFIG_SECTION, can } from './perms';
import { PrismaService } from './prisma.service';
import { Bus } from './bus';
import { LiveCallsService } from './livecalls';

@WebSocketGateway({ path: '/socket.io' })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private ast: AsteriskService, private bus: Bus, private live: LiveCallsService, private db: PrismaService) {
    ast.on('live', l => this.server && this.server.emit('live', l));
    bus.on('calls', x => this.server.emit('calls', x));
    bus.on('workflow', x => this.server.emit('workflow', x));
    bus.on('config', x => this.server.to('cfg').emit('config', x));
    bus.on('cb', x => this.server.to('user:' + x.userId).emit('cb', x));
    // live calls carry patients' numbers: managers only
    bus.on('livecalls', x => this.server && this.server.to('perm:live').emit('livecalls', x));
    bus.on('notify', x => (x.role === '*' ? this.server.emit('notify', x) : this.server.to('role:' + x.role).emit('notify', x)));
  }

  async handleConnection(s: Socket) {
    const tok = verifyToken(String(s.handshake.auth?.token || ''));
    const me = tok && (await currentUser(this.db, tok.id));
    if (!me) { s.disconnect(true); return; }
    s.join('user:' + me.id);
    s.join('role:' + me.role);
    // live calls and VoIP setting changes only reach users allowed to see them
    if (Object.values(CONFIG_SECTION).some(sec => can(me, sec))) s.join('cfg');
    s.data.me = me;
    s.emit('live', this.ast.live);
    if (can(me, 'live')) { s.join('perm:live'); s.emit('livecalls', this.live.calls); }
  }

  handleDisconnect(s: Socket) { this.live.stopFor(s); }

  /** Manager starts listening to a live call (listen only; the parties cannot hear the manager). */
  @SubscribeMessage('listen')
  async listen(@ConnectedSocket() s: Socket, @MessageBody() b: { id?: string }) {
    const me = s.data.me && (await currentUser(this.db, s.data.me.id));
    if (!me || !can(me, 'live', 'edit')) return { ok: false, error: 'اجازه گوش دادن به تماس‌ها را ندارید' };
    try { const r = await this.live.listen(s, me, String(b?.id || '')); return { ok: true, uuid: r.uuid }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  @SubscribeMessage('unlisten')
  unlisten(@ConnectedSocket() s: Socket) { this.live.stopFor(s); return { ok: true }; }
}
