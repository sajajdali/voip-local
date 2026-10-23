import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AiService } from './ai';
import { AsteriskService } from './asterisk/asterisk.service';
import { AuthController, AuthGuard } from './auth';
import { Bus } from './bus';
import { CallsController, CallsService, HooksController } from './calls';
import { ConfigController, ConfigStore } from './config';
import { LiveGateway } from './gateway';
import { MediaController } from './media';
import { PatientsService } from './patients';
import { PrismaService } from './prisma.service';
import { ReportsController } from './reports';
import { WebhookController, WebhookService } from './webhook';
import { BackupController, BackupService } from './backups';

@Module({
  controllers: [AuthController, CallsController, HooksController, ConfigController, MediaController, ReportsController, WebhookController, BackupController],
  providers: [PrismaService, Bus, AsteriskService, ConfigStore, CallsService, PatientsService, AiService, WebhookService, BackupService, LiveGateway, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
