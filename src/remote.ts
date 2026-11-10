import type {
  RemoteResult,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

const inspection = z.object({
  descendants: z.number().int().nonnegative(),
  active: z.boolean(),
})
export type Inspection = z.infer<typeof inspection>

function codec<T>(name: string, schema: z.ZodType<T>) {
  return {
    mode: 'strict' as const,
    typeSymbol: `dsh-delete-button#${name}`,
    create: () => schema,
  }
}

const id = codec('SessionId', z.string().min(1))
const method = {
  service: 'sessionDeletion',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'value', source: 'json', codec: id, strictCodec: id }],
} as const

export const TYPERT_REMOTE = createTypertRemoteInfo(
  {
    package: 'dsh-delete-button',
    methods: {
      'sessionDeletion/inspect': {
        ...method,
        result: codec('Inspection', inspection),
      },
      'sessionDeletion/delete': { ...method, result: codec('void', z.void()) },
    },
  },
  z,
)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'sessionDeletion/inspect': (
      value: string,
    ) => Promise<RemoteResult<Inspection>>
    'sessionDeletion/delete': (value: string) => Promise<RemoteResult<void>>
  }
  interface TypertRemoteNamespaceMap {
    sessionDeletion: TypertRemoteNamespace<'sessionDeletion'>
  }
}
