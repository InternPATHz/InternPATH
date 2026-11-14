import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthMailer } from './auth.mailer';
import { AuthService } from './auth.service';

@Module({ controllers: [AuthController], providers: [AuthMailer, AuthService] })
export class AuthModule {}
