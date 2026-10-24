import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AiController, AiService } from './ai';
import { AiAgentController, AiAgentService } from './aiagent';
import { AsteriskService } from './asterisk/asterisk.service';
import { AuthController, AuthGuard } from './auth';
import { Bus } from './bus';
import { CallsController, CallsService, HooksController } from './calls';
import { ConfigController, ConfigStore } from './config';
import { LiveGateway } from './gateway';
import { MediaController } from './media';
import { CrmController, PatientsService } from './patients';
import { LiveCallsService } from './livecalls';
import { PrismaService } from './prisma.service';
import { ReportsController } from './reports';
import { WebhookController, WebhookService } from './webhook';
import { BackupController, BackupService } from './backups';

@Module({
  controllers: [AuthController, CallsController, HooksController, ConfigController, MediaController, ReportsController, WebhookController, BackupController, AiController, CrmController, AiAgentController],
  providers: [PrismaService, Bus, AsteriskService, ConfigStore, CallsService, PatientsService, AiService, AiAgentService, LiveCallsService, WebhookService, BackupService, LiveGateway, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
