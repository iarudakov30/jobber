import { Controller, Get } from '@nestjs/common';
import { GatewayStats, RealtimeGateway } from './realtime.gateway';

/**
 * `GET /realtime/stats`: sockets, users, channels, counters and memory of this instance. No
 * user data; for the load test ("memory flat") and for watching a running gateway.
 */
@Controller()
export class StatsController {
  constructor(private readonly gateway: RealtimeGateway) {}

  @Get('stats')
  stats(): GatewayStats {
    return this.gateway.stats();
  }
}
