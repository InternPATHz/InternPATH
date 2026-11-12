import { bootstrapService } from '@internpath/common';
import { AppModule } from './app.module';

bootstrapService({ module: AppModule, name: 'lifecycle', defaultPort: 3004 }).catch((err) => {
  console.error(err);
  process.exit(1);
});
