import {
  CreateProductRequest,
  CreateProductResponse,
  GrpcLoggingInterceptor,
  ProductsServiceController,
  ProductsServiceControllerMethods,
} from '@jobber/grpc';
import { Observable } from 'rxjs';
import { ProductsService } from './products.service';
import { Controller, UseInterceptors } from '@nestjs/common';

@Controller('products')
@ProductsServiceControllerMethods()
@UseInterceptors(GrpcLoggingInterceptor)
export class ProductsController implements ProductsServiceController {
  constructor(private readonly productsService: ProductsService) {}
  createProduct(
    request: CreateProductRequest,
  ):
    | CreateProductResponse
    | Promise<CreateProductResponse>
    | Observable<CreateProductResponse> {
    return this.productsService.createProduct(request);
  }
}
