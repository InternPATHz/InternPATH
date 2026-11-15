import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Public } from '@internpath/common';
import { AuthService } from './auth.service';
import { EmailDto, LoginDto, RefreshDto, RegisterAdvisorDto, RegisterCompanyDto, RegisterStudentDto, ResetPasswordDto, TokenDto } from './auth.dto';

@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('register/student')
  registerStudent(@Body() body: RegisterStudentDto) { return this.auth.registerStudent(body); }

  @Public() @Post('register/advisor')
  registerAdvisor(@Body() body: RegisterAdvisorDto) { return this.auth.registerAdvisor(body); }

  @Public() @Post('register/company')
  registerCompany(@Body() body: RegisterCompanyDto) { return this.auth.registerCompany(body); }

  @Public() @Post('verify-email') @HttpCode(204)
  verifyEmail(@Body() body: TokenDto) { return this.auth.verifyEmail(body.token); }

  @Public() @Post('resend-verification') @HttpCode(204)
  resendVerification(@Body() body: EmailDto) { return this.auth.resendVerification(body.email); }

  @Public() @Post('login') @HttpCode(200)
  login(@Body() body: LoginDto) { return this.auth.login(body.email, body.password, body.unlock_token); }

  @Public() @Post('login/unlock/request') @HttpCode(204)
  requestLoginUnlock(@Body() body: EmailDto) { return this.auth.requestLoginUnlock(body.email); }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() body: RefreshDto) { return this.auth.refresh(body.refresh_token); }

  @Post('logout') @HttpCode(204)
  logout(@CurrentUser() user: JwtClaims, @Body() body: RefreshDto) { return this.auth.logout(user.sub, body.refresh_token); }

  @Public() @Post('password/forgot') @HttpCode(204)
  forgotPassword(@Body() body: EmailDto) { return this.auth.forgotPassword(body.email); }

  @Public() @Post('password/reset') @HttpCode(204)
  resetPassword(@Body() body: ResetPasswordDto) { return this.auth.resetPassword(body.token, body.new_password); }
}
