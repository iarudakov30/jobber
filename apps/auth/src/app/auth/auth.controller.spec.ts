import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from '@jobber/grpc';
import { AuthController } from './auth.controller';
import { UsersService } from '../users/users.service';

describe('AuthController.findUserByEmail', () => {
  const findByEmail = jest.fn();
  const controller = new AuthController({
    findByEmail,
  } as unknown as UsersService);

  beforeEach(() => findByEmail.mockReset());

  it('returns only the id and email of the matching user', async () => {
    findByEmail.mockResolvedValue({
      id: 7,
      email: 'bob@example.com',
      createdAt: new Date(),
    });

    await expect(
      controller.findUserByEmail({ email: ' bob@example.com ' }),
    ).resolves.toEqual({ id: 7, email: 'bob@example.com' });
    expect(findByEmail).toHaveBeenCalledWith('bob@example.com');
  });

  it('answers NOT_FOUND for an unknown email', async () => {
    findByEmail.mockResolvedValue(null);

    const call = controller.findUserByEmail({ email: 'nobody@example.com' });

    await expect(call).rejects.toBeInstanceOf(RpcException);
    await expect(call).rejects.toMatchObject({
      error: { code: GrpcStatus.NOT_FOUND },
    });
  });
});
