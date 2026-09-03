import { Module } from '@nestjs/common';
import { PulsarModule } from '@jobber/pulsar';
import { FibonacciConsumer } from './fibonacci/fibonacci.consumer';
import { LoadProductsModule } from './products/load-products.module';

@Module({
  imports: [PulsarModule, LoadProductsModule],
  providers: [FibonacciConsumer],
})
export class JobsModule {}
