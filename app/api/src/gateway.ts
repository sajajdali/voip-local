// WebSocket push: live extension/queue/trunk state, new calls, follow-up changes, click-to-call progress.
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AsteriskService } from './asterisk/asterisk.service';
import { verifyToken } from './auth';
import { Bus } from './bus';
import { LiveCallsService } from './livecalls';

@WebSocketGateway({ path: '/socket.io' })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private ast: AsteriskService, private bus: Bus, private live: LiveCallsService) {
    ast.on('live', l => this.server && this.server.emit('live', l));
    bus.on('calls', x => this.server.emit('calls', x));
    bus.on('workflow', x => this.server.emit('workflow', x));
    bus.on('config', x => this.server.to('role:admin').emit('config', x));
    bus.on('cb', x => this.server.to('user:' + x.userId).emit('cb', x));
    // live calls carry patients' numbers: managers only
    bus.on('livecalls', x => this.server && this.server.to('role:admin').emit('livecalls', x));
    bus.on('notify', x => (x.role === '*' ? this.server.emit('notify', x) : this.server.to('role:' + x.role).emit('notify', x)));
  }

  handleConnection(s: Socket) {
    const me = verifyToken(String(s.handshake.auth?.token || ''));
    if (!me) { s.disconnect(true); return; }
    s.join('user:' + me.id);
    s.join('role:' + me.role);
    s.data.me = me;
    s.emit('live', this.ast.live);
    if (me.role === 'admin') s.emit('livecalls', this.live.calls);
  }

  handleDisconnect(s: Socket) { this.live.stopFor(s); }

  /** Manager starts listening to a live call (listen only; the parties cannot hear the manager). */
  @SubscribeMessage('listen')
  async listen(@ConnectedSocket() s: Socket, @MessageBody() b: { id?: string }) {
    const me = s.data.me;
    if (!me || me.role !== 'admin') return { ok: false, error: 'دسترسی به این بخش مجاز نیست' };
    try { const r = await this.live.listen(s, me, String(b?.id || '')); return { ok: true, uuid: r.uuid }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  @SubscribeMessage('unlisten')
  unlisten(@ConnectedSocket() s: Socket) { this.live.stopFor(s); return { ok: true }; }
}
