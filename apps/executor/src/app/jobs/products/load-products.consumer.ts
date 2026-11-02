import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { LoadProductsMessage, PulsarClient } from '@jobber/pulsar';
import { Jobs } from '@jobber/nestjs';
import {
  Packages,
  PRODUCTS_SERVICE_NAME,
  ProductsServiceClient,
} from '@jobber/grpc';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { JobsConsumer } from '../jobs.consumer';

@Injectable()
export class LoadProductsConsumer
  extends JobsConsumer<LoadProductsMessage>
  implements OnModuleInit
{
  private productsService: ProductsServiceClient;

  constructor(
    pulsarClient: PulsarClient,
    @Inject(Packages.JOBS) private clientJobs: ClientGrpc,
    @Inject(Packages.PRODUCTS) private clientProducts: ClientGrpc,
  ) {
    super(Jobs.LOAD_PRODUCTS, pulsarClient, clientJobs);
  }

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.productsService =
      this.clientProducts.getService<ProductsServiceClient>(
        PRODUCTS_SERVICE_NAME,
      );
  }

  protected async execute(data: LoadProductsMessage): Promise<void> {
    this.logger.log(`LoadProductsConsumer: ${JSON.stringify(data)}`);
    // The job item's identity makes a redelivered message insert nothing the second time.
    await firstValueFrom(
      this.productsService.createProduct({
        name: data.name,
        category: data.category,
        price: data.price,
        stock: data.stock,
        rating: data.rating,
        description: data.description,
        sourceRef: `job:${data.jobId}:${data.index}`,
      }),
    );
  }
}
