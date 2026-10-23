import { Controller, Get, Module } from '@nestjs/common';
import { AppModule } from '../../src/app.js';
import { testApplication, httpClient } from './httpClient.js';
import type { Logger } from '../../src/lib/logger/types.js';
@Controller('__/boom')
class ProbeController {
  @Get('security-headers') security() {
    throw new Error('private-boom');
  }
  @Get('permanent') permanent() {
    throw new Error('Recipe insert returned no row');
  }
  @Get('transient') transient() {
    throw Object.assign(
      new Error('private-password CONNECT_TIMEOUT 127.0.0.1:5432'),
      { code: 'CONNECT_TIMEOUT' },
    );
  }
}
@Module({ imports: [AppModule], controllers: [ProbeController] })
class Root {}
export async function probeApplication(logger?: Logger) {
  return httpClient(await testApplication(Root, [], { logger }));
}
