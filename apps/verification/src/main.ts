import { bootstrapService } from '@internpath/common';
import { AppModule } from './app.module';

bootstrapService({ module: AppModule, name: 'verification', defaultPort: 3003 }).catch((err) => {
  console.error(err);
  process.exit(1);
});
