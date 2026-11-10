import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  createSnapshotStore,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { type Inspection, TYPERT_REMOTE } from './remote.js'

export const inject = ['remote', 'contextMenus', 'slots', 'locale']

const labels = {
  en: {
    delete: 'Delete conversation',
    cancel: 'Cancel',
    close: 'Close',
    description:
      'This permanently deletes the conversation history for “{title}”.',
    children: 'Also deletes {count} subagent conversations.',
    active: 'Running work will be stopped before deletion.',
    loading: 'Reading conversation…',
    deleting: 'Deleting conversation…',
  },
  zh: {
    delete: '删除对话',
    cancel: '取消',
    close: '关闭',
    description: '将永久删除“{title}”的对话记录。',
    children: '同时删除 {count} 个子代理对话。',
    active: '删除前会停止正在运行的工作。',
    loading: '正在读取对话…',
    deleting: '正在删除对话…',
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    deleteButton: keyof typeof labels.en
  }
}

const statusStyle = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}
const errorStyle = {
  ...statusStyle,
  marginTop: 8,
  color: 'var(--dsw-alias-state-error-primary)',
}

type Selection = { id: string; title: string }
type ViewProps = { ctx: Context; selected: SnapshotStore<Selection | null> }

function Confirmation({
  ctx,
  selected,
  request,
}: ViewProps & { request: Selection }) {
  const t = ctx.locale.bind('deleteButton')
  const [info, setInfo] = useState<Inspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let mounted = true
    ctx.remote.sessionDeletion
      .inspect(request.id)
      .then((result) => {
        if (!mounted) return
        if (result.ok) setInfo(result.value)
        else setError(result.error.message)
      })
      .catch((reason: unknown) => {
        if (mounted) setError(String(reason))
      })
    return () => {
      mounted = false
    }
  }, [ctx, request.id])
  const close = () => {
    if (!busy) selected.set(null)
  }
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await ctx.remote.sessionDeletion.delete(request.id)
      if (!result.ok) throw result.error
      selected.set(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete')}
      description={t('description', { title: request.title })}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="outline"
            style={
              busy || info === null
                ? undefined
                : { color: 'var(--dsw-alias-state-error-primary)' }
            }
            disabled={busy || info === null}
            onClick={remove}
          >
            {t('delete')}
          </Button>
        </>
      }
    >
      {info && info.descendants > 0 && (
        <div style={statusStyle}>
          {t('children', { count: info.descendants })}
        </div>
      )}
      {info?.active && <div style={statusStyle}>{t('active')}</div>}
      {busy && (
        <div style={statusStyle} role="status">
          {t('deleting')}
        </div>
      )}
      {!info && !error && (
        <div style={statusStyle} role="status">
          {t('loading')}
        </div>
      )}
      {error && (
        <div style={errorStyle} role="alert">
          {error}
        </div>
      )}
    </Modal>
  )
}

function Overlay({ ctx, selected }: ViewProps) {
  const request = useSyncExternalStore(selected.subscribe, selected.getSnapshot)
  return (
    request && (
      <Confirmation
        key={request.id}
        ctx={ctx}
        selected={selected}
        request={request}
      />
    )
  )
}

export async function apply(ctx: Context) {
  await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.inject(['remote.sessionDeletion'], (ctx) => {
    ctx.effect(() => ctx.locale.register('deleteButton', labels))
    const selected = createSnapshotStore<Selection | null>(null)
    const t = ctx.locale.bind('deleteButton')
    ctx.effect(() =>
      ctx.contextMenus.register({
        id: 'session.delete',
        target: 'session',
        order: 700,
        observe: () => [ctx.locale],
        resolve: (target) => [
          {
            id: 'delete',
            label: t('delete'),
            icon: { key: 'workspace.delete' },
            danger: true,
            afterContent: true,
            run: () => {
              selected.set({ id: target.sessionId, title: target.displayTitle })
            },
          },
        ],
      }),
    )
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'delete-button',
          locale: 'deleteButton',
        },
        () => <Overlay ctx={ctx} selected={selected} />,
      ),
    )
  })
}
