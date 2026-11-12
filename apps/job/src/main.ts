import { bootstrapService } from '@internpath/common';
import { AppModule } from './app.module';

bootstrapService({ module: AppModule, name: 'job', defaultPort: 3002 }).catch((err) => {
  console.error(err);
  process.exit(1);
});
