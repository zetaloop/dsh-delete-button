import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
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
    const root = snapshots.find((snapshot) => snapshot.header.id === id)
    if (!root) throw new Error('Conversation not found.')
    const family: SessionPersistenceSnapshot[] = [root]
    const visited = new Set([id])
    for (const parent of family) {
      for (const child of snapshots) {
        if (
          child.header.origin === 'subagent' &&
          child.header.parentSession === parent.header.id &&
          !visited.has(child.header.id)
        ) {
          visited.add(child.header.id)
          family.push(child)
        }
      }
    }
    return family
  }

  @Remote
  async inspect(value: string) {
    const family = await this.family(SessionId(value))
    const activity = await Promise.all(
      family.map(({ header }) =>
        this.ctx.waterfall(
          'workspace/session-activity',
          { sessionId: header.id },
          () => Promise.resolve([]),
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
    for (const snapshot of targets) {
      if (snapshot.location && snapshot.location.kind !== 'jsonl') {
        throw new Error('Unsupported session storage.')
      }
      if (!snapshot.location && !this.ctx.sessions.get(snapshot.header.id)) {
        throw new Error(
          'Session storage does not expose a conversation directory.',
        )
      }
    }
    const removed = new Set<SessionId>()
    for (const { header } of targets) this.lifecycle.blocked.add(header.id)
    try {
      // The owner's disposer also joins child creation and releases agent-scoped PTC and terminals.
      for (const { header } of targets) {
        await this.ctx.parallel('workspace/session-stop', {
          sessionId: header.id,
        })
        await this.lifecycle.release(header.id, this.ctx.agents.get(header.id))
      }
      const settled = await this.family(id)
      for (const snapshot of settled) {
        if (targets.some((target) => target.header.id === snapshot.header.id))
          continue
        targets.push(snapshot)
        this.lifecycle.blocked.add(snapshot.header.id)
        await this.ctx.parallel('workspace/session-stop', {
          sessionId: snapshot.header.id,
        })
        await this.lifecycle.release(
          snapshot.header.id,
          this.ctx.agents.get(snapshot.header.id),
        )
      }
      for (const { header } of targets.toReversed()) {
        const snapshot = await this.ctx.sessionPersistence.stat(header.id)
        if (this.ctx.sessions.get(header.id))
          throw new Error('Conversation is still open.')
        if (snapshot) {
          if (snapshot.location?.kind !== 'jsonl')
            throw new Error(
              'Session storage does not expose a conversation directory.',
            )
          await rm(dirname(snapshot.location.path), { recursive: true })
        }
        removed.add(header.id)
        for (const workspace of this.ctx.workspaceRegistry.list())
          await workspace.detachSession(header.id)
        await this.ctx.workspaceRegistry.unpinSession(header.id)
        await this.ctx.workspaceRegistry.unarchiveSession(header.id)
        await this.ctx.storageDomain
          .get('session_projcache')
          ?.table('sessions')
          .delete(header.id)
        this.ctx.emit('api-session/removed', header.id)
      }
    } finally {
      for (const { header } of targets) {
        if (!removed.has(header.id)) this.lifecycle.blocked.delete(header.id)
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
