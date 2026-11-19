import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from '@jobber/grpc';
import { AuthController } from './auth.controller';
import { UsersService } from '../users/users.service';

describe('AuthController', () => {
  const findByEmail = jest.fn();
  const findById = jest.fn();
  const controller = new AuthController({
    findByEmail,
    findById,
  } as unknown as UsersService);

  beforeEach(() => {
    findByEmail.mockReset();
    findById.mockReset();
  });

  describe('findUserByEmail', () => {
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

  describe('getUser', () => {
    it('returns only the id and email of the user', async () => {
      findById.mockResolvedValue({
        id: 7,
        email: 'bob@example.com',
        createdAt: new Date(),
      });

      await expect(controller.getUser({ id: 7 })).resolves.toEqual({
        id: 7,
        email: 'bob@example.com',
      });
      expect(findById).toHaveBeenCalledWith(7);
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      findById.mockResolvedValue(null);

      await expect(controller.getUser({ id: 404 })).rejects.toMatchObject({
        error: { code: GrpcStatus.NOT_FOUND },
      });
    });

    it.each([0, -1, 1.5])(
      'answers INVALID_ARGUMENT for id %p without querying',
      async (id) => {
        await expect(controller.getUser({ id })).rejects.toMatchObject({
          error: { code: GrpcStatus.INVALID_ARGUMENT },
        });
        expect(findById).not.toHaveBeenCalled();
      },
    );
  });
});
