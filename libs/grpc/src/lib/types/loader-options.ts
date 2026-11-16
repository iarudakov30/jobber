/**
 * proto-loader options for every gRPC client and server. The generated types use
 * `forceLong=string`, so int64 fields (wallet amounts) must arrive as decimal strings, not
 * `Long` objects or lossy numbers.
 */
export const GRPC_LOADER_OPTIONS = { longs: String };
