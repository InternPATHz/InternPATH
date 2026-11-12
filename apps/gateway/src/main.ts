import { bootstrapService } from '@internpath/common';
import { AppModule } from './app.module';

bootstrapService({ module: AppModule, name: 'gateway', defaultPort: 3000 }).catch((err) => {
  console.error(err);
  process.exit(1);
});
