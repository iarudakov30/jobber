import {
  DynamicModule,
  InjectionToken,
  Module,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
} from '@nestjs/common';

import { RabbitConnection, RabbitOptions } from './rabbit.connection';
import { RabbitPublisher } from './rabbit.publisher';

export const RABBIT_OPTIONS = Symbol('RABBIT_OPTIONS');

export interface RabbitModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: never[]) => RabbitOptions | Promise<RabbitOptions>;
}

/**
 * Registers one `RabbitConnection` (connected on module init, closed on shutdown) and a
 * `RabbitPublisher` for the whole application. Consumers extend `RabbitConsumer` and inject the
 * connection.
 */
@Module({})
export class RabbitModule {
  static forRoot(options: RabbitOptions): DynamicModule {
    return RabbitModule.build({ provide: RABBIT_OPTIONS, useValue: options });
  }

  static forRootAsync(options: RabbitModuleAsyncOptions): DynamicModule {
    return RabbitModule.build(
      {
        provide: RABBIT_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      options.imports,
    );
  }

  private static build(
    optionsProvider: Provider,
    imports: ModuleMetadata['imports'] = [],
  ): DynamicModule {
    return {
      module: RabbitModule,
      global: true,
      imports,
      providers: [
        optionsProvider,
        {
          provide: RabbitConnection,
          useFactory: (options: RabbitOptions) => new RabbitConnection(options),
          inject: [RABBIT_OPTIONS],
        },
        RabbitPublisher,
      ],
      exports: [RabbitConnection, RabbitPublisher],
    };
  }
}
