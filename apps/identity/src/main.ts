import { bootstrapService } from '@internpath/common';
import { AppModule } from './app.module';

bootstrapService({ module: AppModule, name: 'identity', defaultPort: 3001 }).catch((err) => {
  console.error(err);
  process.exit(1);
});
