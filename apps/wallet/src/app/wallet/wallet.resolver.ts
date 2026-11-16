import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GqlAuthGuard } from '@jobber/graphql';
import { User } from '@jobber/grpc';
import { CurrentUser } from './current-user.decorator';
import { TransferInput } from './dto/transfer.input';
import { Balance, EntryPage, Transfer } from './models/wallet.models';
import { asGraphQL } from './wallet.errors';
import { WalletService } from './wallet.service';

@Resolver()
@UseGuards(GqlAuthGuard)
export class WalletResolver {
  constructor(private readonly wallet: WalletService) {}

  @Query(() => [Balance], { description: "The signed-in user's balances." })
  balances(@CurrentUser() user: User): Promise<Balance[]> {
    return this.wallet.balances(user.id);
  }

  @Query(() => EntryPage, {
    description: "The signed-in user's ledger entries, newest first.",
  })
  entries(
    @CurrentUser() user: User,
    @Args('asset', { nullable: true }) asset?: string,
    @Args('after', { type: () => ID, nullable: true }) after?: string,
    @Args('first', { type: () => Int, defaultValue: 50 }) first?: number,
  ): Promise<EntryPage> {
    return asGraphQL(() =>
      this.wallet.entries(user.id, { asset, after, first }),
    );
  }

  @Mutation(() => Transfer, {
    description:
      'Sends money to another user by email, from your available balance.',
  })
  transfer(
    @CurrentUser() user: User,
    @Args('input') input: TransferInput,
  ): Promise<Transfer> {
    return asGraphQL(() => this.wallet.transfer(user, input));
  }
}
