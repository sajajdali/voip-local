import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { ConfigStore } from './config';
import { env } from './env';

async function main() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new IoAdapter(app));
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  await app.listen(env.port, '127.0.0.1');
  const r = await app.get(ConfigStore).applyAll().catch(e => ({ applied: false, error: e.message }));
  new Logger('Boot').log(`API on :${env.port}, initial Asterisk apply: ${JSON.stringify(r)}`);
}
main();
