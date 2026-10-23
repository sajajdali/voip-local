// WebSocket push: live extension/queue/trunk state, new calls, follow-up changes, click-to-call progress.
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AsteriskService } from './asterisk/asterisk.service';
import { verifyToken } from './auth';
import { Bus } from './bus';

@WebSocketGateway({ path: '/socket.io' })
export class LiveGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  constructor(private ast: AsteriskService, private bus: Bus) {
    ast.on('live', l => this.server && this.server.emit('live', l));
    bus.on('calls', x => this.server.emit('calls', x));
    bus.on('workflow', x => this.server.emit('workflow', x));
    bus.on('config', x => this.server.to('role:admin').emit('config', x));
    bus.on('cb', x => this.server.to('user:' + x.userId).emit('cb', x));
    bus.on('notify', x => (x.role === '*' ? this.server.emit('notify', x) : this.server.to('role:' + x.role).emit('notify', x)));
  }

  handleConnection(s: Socket) {
    const me = verifyToken(String(s.handshake.auth?.token || ''));
    if (!me) { s.disconnect(true); return; }
    s.join('user:' + me.id);
    s.join('role:' + me.role);
    s.emit('live', this.ast.live);
  }
}
