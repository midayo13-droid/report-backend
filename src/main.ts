import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

// 로컬에서는 backend/.env 를 읽어요. (배포 서버에서는 파일 없이 환경 변수를 쓰므로 없어도 괜찮아요)
try {
  process.loadEnvFile('.env');
} catch {
  /* .env 가 없으면 이미 설정된 환경 변수를 써요 */
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const origins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim());
  app.enableCors({ origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'], exposedHeaders: ['Content-Disposition'] });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  new Logger('Main').log(`서버가 켜졌어요: http://localhost:${port}/api/health`);
}
await bootstrap();
