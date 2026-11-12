import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ShopGuard } from '../identity/shop.guard.js';
import { IdentityService } from '../identity/identity.service.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { SyncEvents, SyncEventSource } from './sync-events.js';

@Controller('api/v1/sync')
@UseGuards(ShopGuard)
export class SyncEventsController {
  constructor(
    @Inject(SyncEvents) private readonly events: SyncEvents,
    @Inject(SyncEventSource) private readonly source: SyncEventSource,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @Get('events')
  async stream(
    @CurrentActor() actor: ActorContext,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    let closed = false;
    let pending = false;
    let sending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let detach = () => {};
    const stop = () => {
      if (closed) return;
      closed = true;
      detach();
      clearTimeout(timer);
      clearInterval(heartbeat);
      response.end();
    };
    response.once('close', stop);
    const send = async () => {
      if (closed || sending) return;
      sending = true;
      pending = false; // Hints arriving during authorization need a trailing send.
      try {
        // Recheck membership/session before forwarding any hint, including recovery.
        await this.identity.resolve({
          request,
          shopId: actor.shop.id,
        });
        if (closed) return;
        if (!response.write('event: reconcile\ndata: {}\n\n')) stop(); // Bound slow-client buffering; reconnect will compare.
      } catch {
        stop();
      } finally {
        sending = false;
        if (pending && !closed) schedule();
      }
    };
    const schedule = () => {
      if (closed || timer || sending) return;
      timer = setTimeout(() => {
        timer = undefined;
        void send();
      }, 250 + Math.random() * 4000);
    };
    try {
      await this.source.ready();
      if (closed) return;
      response.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      detach = this.events.subscribe(actor.shop.id, (event) => {
        if (event === 'unavailable' || event === 'removed') {
          stop();
          return;
        }
        pending = true;
        schedule();
      });
      pending = true;
      await send(); // Initial reconciliation starts only after LISTEN and subscription are active.
      if (!closed)
        heartbeat = setInterval(async () => {
          if (closed) return;
          try {
            await this.identity.resolve({ request, shopId: actor.shop.id });
            if (closed) return;
            if (!response.write(': heartbeat\n\n')) stop();
          } catch {
            stop();
          }
        }, 15000);
    } catch {
      actor.log.error(
        { event: 'sync_listener_unavailable' },
        'Sync listener unavailable',
      );
      if (!response.headersSent) response.status(503);
      stop();
    }
  }
}
