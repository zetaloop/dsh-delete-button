import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionHandle,
  SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'

type Initialize = (
  this: AgentLoop,
  owner: Context,
  options: {
    session: Session
    stored?: { handle: SessionHandle }
  },
) => Promise<AgentHandle>
type Put = (
  this: SessionProjectionCache,
  id: SessionId,
  ...args: unknown[]
) => Promise<void>

function hook<T>(
  ctx: Context,
  target: object,
  key: string,
  wrap: (original: T) => T,
) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (!descriptor || typeof descriptor.value !== 'function') {
    throw new Error(`Unsupported DSH lifecycle: ${key}`)
  }
  ctx.effect(() => {
    Object.defineProperty(target, key, {
      ...descriptor,
      value: wrap(descriptor.value as T),
    })
    return () => {
      Object.defineProperty(target, key, descriptor)
    }
  })
}

export class Lifecycles {
  readonly blocked = new Set<SessionId>()
  private readonly handles = new Map<SessionId, AgentHandle>()
  private readonly starting = new Map<SessionId, Set<Promise<unknown>>>()
  private readonly writes = new Map<SessionId, Set<Promise<void>>>()

  constructor(ctx: Context) {
    const owner = this
    hook<AgentLoop['createAgent']>(
      ctx,
      AgentLoop.prototype,
      'createAgent',
      (original) =>
        function (this: AgentLoop, context, options) {
          return owner.start(options.sessionId, () =>
            original.call(this, context, options),
          )
        },
    )
    hook<AgentLoop['create']>(
      ctx,
      AgentLoop.prototype,
      'create',
      (original) =>
        function (this: AgentLoop, id, options, meta) {
          return owner.start(id, () => original.call(this, id, options, meta))
        },
    )
    type Resume = (
      this: AgentLoop,
      context: Context,
      persistence: SessionPersistence,
      options: Parameters<AgentLoop['resume']>[1],
    ) => Promise<AgentHandle>
    hook<Resume>(
      ctx,
      AgentLoop.prototype,
      'resumeWith',
      (original) =>
        function (context, persistence, options) {
          return owner.start(options.resumeSessionId, () =>
            original.call(this, context, persistence, options),
          )
        },
    )
    // The factory owns the complete disposer; registry removal alone cannot release its resources.
    hook<Initialize>(
      ctx,
      AgentLoop.prototype,
      'initializeAgent',
      (original) =>
        async function (context, options) {
          const { id, header } = options.session
          if (
            owner.blocked.has(id) ||
            (header.origin === 'subagent' &&
              header.parentSession &&
              owner.blocked.has(header.parentSession))
          ) {
            await options.stored?.handle.close()
            throw new Error('This conversation is being deleted.')
          }
          const handle = await original.call(this, context, options)
          owner.handles.set(id, handle)
          return handle
        },
    )
    // Both live checkpoints and cold observations can publish a cache row asynchronously.
    hook<Put>(
      ctx,
      SessionProjectionCache.prototype,
      'put',
      (original) =>
        async function (id, ...args) {
          if (owner.blocked.has(id)) return
          const pending = original.call(this, id, ...args)
          const writes = owner.writes.get(id) ?? new Set<Promise<void>>()
          owner.writes.set(id, writes)
          writes.add(pending)
          try {
            await pending
          } finally {
            writes.delete(pending)
            if (!writes.size) owner.writes.delete(id)
          }
        },
    )
    ctx.on(
      'agent/disposed',
      ({ agent }) => {
        owner.handles.delete(agent.id)
      },
      { global: true },
    )
  }

  private async start<T>(
    id: SessionId,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.blocked.has(id)) {
      throw new Error('This conversation is being deleted.')
    }
    const pending = operation()
    const tasks = this.starting.get(id) ?? new Set<Promise<unknown>>()
    this.starting.set(id, tasks)
    tasks.add(pending)
    try {
      return await pending
    } finally {
      tasks.delete(pending)
      if (!tasks.size) this.starting.delete(id)
    }
  }

  async release(id: SessionId, agent: Agent | undefined) {
    // A rejected resume still closes its acquired write handle before settling.
    await Promise.allSettled(this.starting.get(id) ?? [])
    const handle = this.handles.get(id)
    if (agent && !handle) {
      throw new Error(
        'Restart DSH before deleting conversations created before this plugin was loaded.',
      )
    }
    await handle?.dispose()
    await Promise.all(this.writes.get(id) ?? [])
  }
}
