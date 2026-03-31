import { Request, Response } from 'express';

export interface GqlContext {
  req: Request & { user?: unknown };
  res: Response;
}
