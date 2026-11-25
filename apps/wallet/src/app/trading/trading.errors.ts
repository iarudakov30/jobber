/** No hold has this id: PlaceHold never succeeded for it. Answered as gRPC `NOT_FOUND`. */
export class HoldNotFoundError extends Error {
  override readonly name = 'HoldNotFoundError';

  constructor(readonly holdId: string) {
    super(`hold ${holdId} does not exist`);
  }
}

/**
 * The hold exists but can't do what was asked: it was already captured or released by
 * something else. Nothing was written. Answered as gRPC `FAILED_PRECONDITION`.
 */
export class HoldStateError extends Error {
  override readonly name = 'HoldStateError';
}
