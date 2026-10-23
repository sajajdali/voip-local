import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/** In-process event bus between services and the websocket gateway. */
@Injectable()
export class Bus extends EventEmitter {}
