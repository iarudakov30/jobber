// Real job traces from Jaeger's /api/v3/traces/{id}, trimmed to the fields the replay reads.
// Regenerate by running jobs with tracing on and fetching their traces.
import { OtlpTraceResponse } from '../trace';

export const fibonacciWithRetries: OtlpTraceResponse = {
  result: {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: {
                stringValue: 'jobs',
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'd4de29f714de1f71',
                parentSpanId: '59479a4f5f00589d',
                name: 'graphql.parse',
                kind: 1,
                startTimeUnixNano: '1793912383793000000',
                endTimeUnixNano: '1793912383793998400',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '20c270420f0b7ff6',
                parentSpanId: '59479a4f5f00589d',
                name: 'graphql.validate',
                kind: 1,
                startTimeUnixNano: '1793912383795000000',
                endTimeUnixNano: '1793912383796776000',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'd543a2aba409da93',
                parentSpanId: '6bd92705f57964ce',
                name: 'graphql.resolve executeJob.id',
                kind: 1,
                startTimeUnixNano: '1793912383901000000',
                endTimeUnixNano: '1793912383901110200',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '1e2032a14f7a4bdc',
                parentSpanId: '6bd92705f57964ce',
                name: 'graphql.resolve executeJob.name',
                kind: 1,
                startTimeUnixNano: '1793912383901000000',
                endTimeUnixNano: '1793912383901019900',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'adc2e309bdd822c1',
                parentSpanId: '6bd92705f57964ce',
                name: 'graphql.resolve executeJob.size',
                kind: 1,
                startTimeUnixNano: '1793912383901000000',
                endTimeUnixNano: '1793912383901010900',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '5ffd5e608045dfc3',
                parentSpanId: '6bd92705f57964ce',
                name: 'graphql.resolve executeJob.traceId',
                kind: 1,
                startTimeUnixNano: '1793912383901000000',
                endTimeUnixNano: '1793912383901010500',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '6bd92705f57964ce',
                parentSpanId: '59479a4f5f00589d',
                name: 'mutation',
                kind: 1,
                startTimeUnixNano: '1793912383799000000',
                endTimeUnixNano: '1793912383901448700',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '174bc8dbac605c48',
                parentSpanId: '6bd92705f57964ce',
                name: 'grpc.auth.AuthService/Authenticate',
                kind: 3,
                startTimeUnixNano: '1793912383801000000',
                endTimeUnixNano: '1793912383835395900',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Authenticate',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '6c35f0607203e999',
                parentSpanId: '541235acbf9b1449',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 2,
                startTimeUnixNano: '1793912384066000000',
                endTimeUnixNano: '1793912384079734900',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '3765f8e982ce3df0',
                parentSpanId: '6bd92705f57964ce',
                name: 'pg-pool.connect',
                kind: 3,
                startTimeUnixNano: '1793912383841000000',
                endTimeUnixNano: '1793912383841742800',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '9b663b5fbf723844',
                parentSpanId: '6bd92705f57964ce',
                name: 'pg.query:BEGIN jobber',
                kind: 3,
                startTimeUnixNano: '1793912383843000000',
                endTimeUnixNano: '1793912383846380900',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '04563f3f44c01200',
                parentSpanId: '6bd92705f57964ce',
                name: 'pg.query:INSERT jobber',
                kind: 3,
                startTimeUnixNano: '1793912383882000000',
                endTimeUnixNano: '1793912383886079700',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'dd955132618135ed',
                parentSpanId: '6bd92705f57964ce',
                name: 'pg.query:INSERT jobber',
                kind: 3,
                startTimeUnixNano: '1793912383891000000',
                endTimeUnixNano: '1793912383896641600',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'af4390a7daa78526',
                parentSpanId: '6bd92705f57964ce',
                name: 'pg.query:COMMIT jobber',
                kind: 3,
                startTimeUnixNano: '1793912383897000000',
                endTimeUnixNano: '1793912383899491100',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'db6df22c5707d01b',
                parentSpanId: '6c35f0607203e999',
                name: 'pg-pool.connect',
                kind: 3,
                startTimeUnixNano: '1793912384067000000',
                endTimeUnixNano: '1793912384067125000',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'd84b28c66a8abd8e',
                parentSpanId: '6c35f0607203e999',
                name: 'pg.query:WITH jobber',
                kind: 3,
                startTimeUnixNano: '1793912384067000000',
                endTimeUnixNano: '1793912384075827100',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '59479a4f5f00589d',
                name: 'POST',
                kind: 2,
                startTimeUnixNano: '1793912383774000000',
                endTimeUnixNano: '1793912383903980800',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'cac6feb77466ee18',
                parentSpanId: '6bd92705f57964ce',
                name: 'Fibonacci publish',
                kind: 4,
                startTimeUnixNano: '1793912383917000000',
                endTimeUnixNano: '1793912383968635000',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'e496ac75c4eaaf60',
                parentSpanId: '6bd92705f57964ce',
                name: 'Fibonacci publish',
                kind: 4,
                startTimeUnixNano: '1793912383969000000',
                endTimeUnixNano: '1793912383999212500',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '54c64d267e5555fa',
                parentSpanId: '6bd92705f57964ce',
                name: 'Fibonacci publish',
                kind: 4,
                startTimeUnixNano: '1793912383999000000',
                endTimeUnixNano: '1793912384030203400',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: {
                stringValue: 'executor',
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '6b23662aa828aa36',
                parentSpanId: 'cac6feb77466ee18',
                name: 'Fibonacci process',
                kind: 5,
                startTimeUnixNano: '1793912383972000000',
                endTimeUnixNano: '1793912383979206800',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                  {
                    key: 'messaging.outcome',
                    value: {
                      stringValue: 'nacked',
                    },
                  },
                  {
                    key: 'messaging.pulsar.redelivery_count',
                    value: {
                      intValue: '0',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '8d9e6b9ff0a1222a',
                parentSpanId: 'e496ac75c4eaaf60',
                name: 'Fibonacci process',
                kind: 5,
                startTimeUnixNano: '1793912384000000000',
                endTimeUnixNano: '1793912384000389500',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                  {
                    key: 'messaging.outcome',
                    value: {
                      stringValue: 'nacked',
                    },
                  },
                  {
                    key: 'messaging.pulsar.redelivery_count',
                    value: {
                      intValue: '0',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '0d956f55c7e09ea9',
                parentSpanId: '54c64d267e5555fa',
                name: 'Fibonacci process',
                kind: 5,
                startTimeUnixNano: '1793912384031000000',
                endTimeUnixNano: '1793912384088812600',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                  {
                    key: 'messaging.outcome',
                    value: {
                      stringValue: 'acked',
                    },
                  },
                  {
                    key: 'messaging.pulsar.redelivery_count',
                    value: {
                      intValue: '0',
                    },
                  },
                ],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '541235acbf9b1449',
                parentSpanId: '0d956f55c7e09ea9',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 3,
                startTimeUnixNano: '1793912384032000000',
                endTimeUnixNano: '1793912384086623800',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: {
                stringValue: 'jobs',
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'dd4825b04e80f04b',
                parentSpanId: '372c03bbac8cacac',
                name: 'pg-pool.connect',
                kind: 3,
                startTimeUnixNano: '1793912389057000000',
                endTimeUnixNano: '1793912389057072700',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'd274fcfbc6ac2886',
                parentSpanId: '372c03bbac8cacac',
                name: 'pg.query:WITH jobber',
                kind: 3,
                startTimeUnixNano: '1793912389057000000',
                endTimeUnixNano: '1793912389060638900',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '4b633dc06b17750d',
                parentSpanId: '08d20bb36713a5c9',
                name: 'pg-pool.connect',
                kind: 3,
                startTimeUnixNano: '1793912389063000000',
                endTimeUnixNano: '1793912389063074300',
                attributes: [],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'cb82055700659dc0',
                parentSpanId: '08d20bb36713a5c9',
                name: 'pg.query:WITH jobber',
                kind: 3,
                startTimeUnixNano: '1793912389064000000',
                endTimeUnixNano: '1793912389065746500',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '372c03bbac8cacac',
                parentSpanId: '272a23aa23ddbbf4',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 2,
                startTimeUnixNano: '1793912389057000000',
                endTimeUnixNano: '1793912389061472800',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '08d20bb36713a5c9',
                parentSpanId: '6068fc9b7e7e82cc',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 2,
                startTimeUnixNano: '1793912389063000000',
                endTimeUnixNano: '1793912389065335800',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: {
                stringValue: 'executor',
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '272a23aa23ddbbf4',
                parentSpanId: 'e724182af893dcf6',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 3,
                startTimeUnixNano: '1793912389055000000',
                endTimeUnixNano: '1793912389061348400',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '6068fc9b7e7e82cc',
                parentSpanId: '860ec71d3cce6832',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 3,
                startTimeUnixNano: '1793912389062000000',
                endTimeUnixNano: '1793912389065874900',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: 'e724182af893dcf6',
                parentSpanId: 'cac6feb77466ee18',
                name: 'Fibonacci process',
                kind: 5,
                startTimeUnixNano: '1793912389055000000',
                endTimeUnixNano: '1793912389061820900',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                  {
                    key: 'messaging.outcome',
                    value: {
                      stringValue: 'acked',
                    },
                  },
                  {
                    key: 'messaging.pulsar.redelivery_count',
                    value: {
                      intValue: '1',
                    },
                  },
                ],
              },
              {
                traceId: 'bbd8e3137063dfe7d7e6a035b935849c',
                spanId: '860ec71d3cce6832',
                parentSpanId: 'e496ac75c4eaaf60',
                name: 'Fibonacci process',
                kind: 5,
                startTimeUnixNano: '1793912389062000000',
                endTimeUnixNano: '1793912389066302500',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'Fibonacci',
                    },
                  },
                  {
                    key: 'messaging.outcome',
                    value: {
                      stringValue: 'acked',
                    },
                  },
                  {
                    key: 'messaging.pulsar.redelivery_count',
                    value: {
                      intValue: '1',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

export const loadProducts: OtlpTraceResponse = {
  result: {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: {
                stringValue: 'jobs',
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'd23badb720debaa9',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'graphql.resolve executeJob.id',
                kind: 1,
                startTimeUnixNano: '1793912383963000000',
                endTimeUnixNano: '1793912383963158300',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '90de1e7be1df56db',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'graphql.resolve executeJob.name',
                kind: 1,
                startTimeUnixNano: '1793912383963000000',
                endTimeUnixNano: '1793912383963035600',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '0172d69f8b3a6d18',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'graphql.resolve executeJob.size',
                kind: 1,
                startTimeUnixNano: '1793912383963000000',
                endTimeUnixNano: '1793912383963025000',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '32794c5d6e478796',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'graphql.resolve executeJob.traceId',
                kind: 1,
                startTimeUnixNano: '1793912383963000000',
                endTimeUnixNano: '1793912383963025200',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '4f817d01dfe3a7d6',
                parentSpanId: 'd78198fba1ab15cd',
                name: 'mutation',
                kind: 1,
                startTimeUnixNano: '1793912383915000000',
                endTimeUnixNano: '1793912383963415300',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'f407e6b7629c8aa3',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'grpc.auth.AuthService/Authenticate',
                kind: 3,
                startTimeUnixNano: '1793912383915000000',
                endTimeUnixNano: '1793912383922139200',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Authenticate',
                    },
                  },
                ],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '05fbf0d87be1123f',
                parentSpanId: '4f71b664719dc471',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 2,
                startTimeUnixNano: '1793912384151000000',
                endTimeUnixNano: '1793912384161934100',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '7c37b942c66f438c',
                parentSpanId: '112e0352eeddf754',
                name: 'pg.connect',
                kind: 3,
                startTimeUnixNano: '1793912383926000000',
                endTimeUnixNano: '1793912383948511000',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '112e0352eeddf754',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'pg-pool.connect',
                kind: 3,
                startTimeUnixNano: '1793912383925000000',
                endTimeUnixNano: '1793912383948407400',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'e9b76cbe847fe8be',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'pg.query:BEGIN jobber',
                kind: 3,
                startTimeUnixNano: '1793912383948000000',
                endTimeUnixNano: '1793912383948856800',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '8a13d21fb4b402da',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'pg.query:INSERT jobber',
                kind: 3,
                startTimeUnixNano: '1793912383950000000',
                endTimeUnixNano: '1793912383951511600',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'd95ece6173d31c9e',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'pg.query:INSERT jobber',
                kind: 3,
                startTimeUnixNano: '1793912383952000000',
                endTimeUnixNano: '1793912383953773000',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'a9b45412c7f44cf3',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'pg.query:COMMIT jobber',
                kind: 3,
                startTimeUnixNano: '1793912383955000000',
                endTimeUnixNano: '1793912383961845400',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '4ed26e2d0767f85a',
                parentSpanId: '05fbf0d87be1123f',
                name: 'pg-pool.connect',
                kind: 3,
                startTimeUnixNano: '1793912384151000000',
                endTimeUnixNano: '1793912384151099200',
                attributes: [],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '0ae6659d605e33ba',
                parentSpanId: '05fbf0d87be1123f',
                name: 'pg.query:WITH jobber',
                kind: 3,
                startTimeUnixNano: '1793912384151000000',
                endTimeUnixNano: '1793912384158945700',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'd78198fba1ab15cd',
                name: 'POST',
                kind: 2,
                startTimeUnixNano: '1793912383913000000',
                endTimeUnixNano: '1793912383965279800',
                attributes: [],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '528e5fd50ef6a48a',
                parentSpanId: '4f817d01dfe3a7d6',
                name: 'LoadProducts publish',
                kind: 4,
                startTimeUnixNano: '1793912384045000000',
                endTimeUnixNano: '1793912384083185100',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'LoadProducts',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: {
                stringValue: 'executor',
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'e854ae6fa2a3fc9f',
                parentSpanId: '528e5fd50ef6a48a',
                name: 'LoadProducts process',
                kind: 5,
                startTimeUnixNano: '1793912384090000000',
                endTimeUnixNano: '1793912384165916700',
                attributes: [
                  {
                    key: 'messaging.destination.name',
                    value: {
                      stringValue: 'LoadProducts',
                    },
                  },
                  {
                    key: 'messaging.outcome',
                    value: {
                      stringValue: 'acked',
                    },
                  },
                  {
                    key: 'messaging.pulsar.redelivery_count',
                    value: {
                      intValue: '0',
                    },
                  },
                ],
              },
            ],
          },
          {
            spans: [
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: 'c7d5b01d5b4130b2',
                parentSpanId: 'e854ae6fa2a3fc9f',
                name: 'grpc.products.ProductsService/CreateProduct',
                kind: 3,
                startTimeUnixNano: '1793912384092000000',
                endTimeUnixNano: '1793912384149200300',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'CreateProduct',
                    },
                  },
                ],
              },
              {
                traceId: 'e53c65c25788b3c7934fd9c1638243cf',
                spanId: '4f71b664719dc471',
                parentSpanId: 'e854ae6fa2a3fc9f',
                name: 'grpc.jobs.JobsService/Acknowledge',
                kind: 3,
                startTimeUnixNano: '1793912384149000000',
                endTimeUnixNano: '1793912384165547200',
                attributes: [
                  {
                    key: 'rpc.method',
                    value: {
                      stringValue: 'Acknowledge',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};
