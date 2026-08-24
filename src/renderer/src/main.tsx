import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import '@/styles/main.css'
import { App } from '@/App'

/**
 * Last line of defence. A render error anywhere below would otherwise unmount
 * the whole tree and leave an empty window with no way out — in a desktop app
 * there is no URL to reload.
 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] unhandled render error', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center"
        style={{ background: 'var(--bg-app)', padding: 24, textAlign: 'center' }}
      >
        <div className="drag fixed top-0 right-0 left-0" style={{ height: 56 }} />
        <h1
          style={{
            fontSize: 'var(--fs-h1)',
            fontWeight: 550,
            color: 'var(--fg-primary)',
            letterSpacing: 'var(--ls-h1)'
          }}
        >
          Something went wrong
        </h1>
        <p
          style={{
            marginTop: 8,
            maxWidth: 420,
            fontSize: 'var(--fs-ui)',
            color: 'var(--fg-secondary)'
          }}
        >
          Your Bots and transcripts are stored locally and were not affected.
        </p>
        <pre
          className="selectable"
          style={{
            marginTop: 16,
            maxWidth: 520,
            maxHeight: 160,
            overflow: 'auto',
            padding: 12,
            background: 'var(--surface-2)',
            borderRadius: 'var(--r-4)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-micro)',
            color: 'var(--fg-tertiary)',
            textAlign: 'left',
            whiteSpace: 'pre-wrap'
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 20,
            height: 32,
            padding: '0 14px',
            borderRadius: 'var(--r-button)',
            background: 'var(--btn-filled-bg)',
            color: 'var(--btn-filled-fg)',
            fontSize: 'var(--fs-chrome)',
            fontWeight: 550
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('Renderer root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>
)
