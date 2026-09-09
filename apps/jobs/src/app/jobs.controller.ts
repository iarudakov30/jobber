import { Controller } from '@nestjs/common';
import {
  AcknowledgeRequest,
  AcknowledgeResponse,
  JobsServiceController,
  JobsServiceControllerMethods,
} from '@jobber/grpc';
import { JobsService } from './jobs.service';

@Controller()
@JobsServiceControllerMethods()
export class JobsController implements JobsServiceController {
  constructor(private readonly jobsService: JobsService) {}

  async acknowledge(request: AcknowledgeRequest): Promise<AcknowledgeResponse> {
    await this.jobsService.acknowledge(request.jobId);
    return {};
  }
}
