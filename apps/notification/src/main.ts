import { bootstrapService } from '@internpath/common';
import { AppModule } from './app.module';

bootstrapService({ module: AppModule, name: 'notification', defaultPort: 3005 }).catch((err) => {
  console.error(err);
  process.exit(1);
});
