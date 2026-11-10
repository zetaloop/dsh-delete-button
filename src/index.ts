import { readdir, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import { Lifecycles } from './lifecycle.js'
import { TYPERT_REMOTE } from './remote.js'

export const name = 'delete-button'
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'workspaceRegistry',
  'storageDomain',
  'typert',
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionDeletion: SessionDeletion
  }
}

class SessionDeletion extends TypertRemoteService {
  private readonly lifecycle: Lifecycles
  private mutation = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'sessionDeletion')
    this.lifecycle = new Lifecycles(ctx)
    ctx.effect(() => () => this.mutation)
  }

  private async family(id: SessionId) {
    const snapshots = await this.ctx.sessionPersistence.list()
    const family = [id]
    const visited = new Set([id])
    for (const parent of family) {
      for (const child of snapshots) {
        if (
          child.header.origin === 'subagent' &&
          child.header.parentSession === parent &&
          !visited.has(child.header.id)
        ) {
          visited.add(child.header.id)
          family.push(child.header.id)
        }
      }
    }
    return family
  }

  @Remote
  async inspect(value: string) {
    const family = await this.family(SessionId(value))
    const activity = await Promise.all(
      family.map((sessionId) =>
        this.ctx.waterfall('workspace/session-activity', { sessionId }, () =>
          Promise.resolve([]),
        ),
      ),
    )
    return {
      descendants: family.length - 1,
      active: activity.some((entries) => entries.length > 0),
    }
  }

  @Remote
  delete(value: string): Promise<void> {
    const operation = this.mutation.then(() => this.remove(SessionId(value)))
    this.mutation = operation.then(
      () => {},
      () => {},
    )
    return operation
  }

  private async remove(id: SessionId) {
    const targets = await this.family(id)
    for (const target of targets) {
      const snapshot = await this.ctx.sessionPersistence.stat(target)
      if (snapshot?.location && snapshot.location.kind !== 'jsonl') {
        throw new Error('Unsupported session storage.')
      }
      if (snapshot && !snapshot.location && !this.ctx.sessions.get(target)) {
        throw new Error(
          'Session storage does not expose a conversation directory.',
        )
      }
    }
    const removed = new Set<SessionId>()
    for (const target of targets) this.lifecycle.blocked.add(target)
    try {
      // The owner's disposer also joins child creation and releases agent-scoped PTC and terminals.
      for (const target of targets) {
        await this.ctx.parallel('workspace/session-stop', {
          sessionId: target,
        })
        await this.lifecycle.release(target, this.ctx.agents.get(target))
      }
      const settled = await this.family(id)
      for (const target of settled) {
        if (targets.includes(target)) continue
        targets.push(target)
        this.lifecycle.blocked.add(target)
        await this.ctx.parallel('workspace/session-stop', {
          sessionId: target,
        })
        await this.lifecycle.release(target, this.ctx.agents.get(target))
      }
      await using handles = new AsyncDisposableStack()
      const locations = new Map<SessionId, string>()
      for (const target of targets) {
        if (this.ctx.sessions.get(target))
          throw new Error('Conversation is still open.')
        const handle = await this.ctx.sessionPersistence
          .open(target, 'write')
          .catch((error: unknown) => {
            if (error instanceof SessionPersistenceNotFoundError)
              return undefined
            throw error
          })
        if (!handle) continue
        handles.use(handle)
        const snapshot = await this.ctx.sessionPersistence.stat(target)
        if (!snapshot)
          throw new Error('Conversation storage could not be inspected.')
        if (snapshot.location?.kind !== 'jsonl')
          throw new Error(
            'Session storage does not expose a conversation directory.',
          )
        locations.set(target, snapshot.location.path)
      }
      for (const target of targets.toReversed()) {
        // Retain the logs until accounting succeeds so a retry can rediscover every child.
        const results = await Promise.allSettled([
          ...this.ctx.workspaceRegistry
            .list()
            .map((workspace) => workspace.detachSession(target)),
          this.ctx.workspaceRegistry.unpinSession(target),
          this.ctx.workspaceRegistry.unarchiveSession(target),
          this.ctx.storageDomain
            .get('session_projcache')
            ?.table('sessions')
            .delete(target),
        ])
        const failures: unknown[] = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (failures.length) {
          throw new AggregateError(
            failures,
            failures
              .map((error) =>
                error instanceof Error ? error.message : String(error),
              )
              .join('\n'),
          )
        }
        const location = locations.get(target)
        if (location) {
          const directory = dirname(location)
          const current = basename(location)
          const entries = await readdir(directory)
          // Keep the current generation discoverable until every older log is gone.
          entries.sort((a, b) => Number(a === current) - Number(b === current))
          for (const entry of entries) {
            // POSIX leases require the lock file's inode to survive deletion.
            if (entry !== 'session.lock')
              await rm(join(directory, entry), { recursive: true })
          }
          if (!entries.includes('session.lock')) await rmdir(directory)
        }
        removed.add(target)
        this.ctx.emit('api-session/removed', target, name)
      }
    } finally {
      for (const target of targets) {
        if (!removed.has(target)) this.lifecycle.blocked.delete(target)
      }
    }
  }
}

export function apply(ctx: Context) {
  new SessionDeletion(ctx)
  ctx.typert.register({
    package: 'dsh-delete-button',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: TYPERT_REMOTE.descriptors,
  })
}
