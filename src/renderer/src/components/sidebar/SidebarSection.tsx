import type { ReactElement, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { useUiStore } from '@/stores/uiStore'

/**
 * A collapsible sidebar section (DESIGN §2.2): 28px header, 12px/510 tertiary
 * label in sentence case, a 12px chevron that rotates 90° over `--dur-fast`,
 * and 12px of margin above every section but the first.
 */
export interface SidebarSectionProps {
  /** Stable key for the persisted collapsed state. */
  id: string
  label: string
  count?: number
  children: ReactNode
  /** Suppresses the 12px top margin on the first section in the list. */
  first?: boolean
  /** Rendered instead of the children when the section has no rows. */
  empty?: ReactNode
  isEmpty?: boolean
}

export function SidebarSection({
  id,
  label,
  count,
  children,
  first = false,
  empty,
  isEmpty = false
}: SidebarSectionProps): ReactElement {
  const collapsed = useUiStore((s) => Boolean(s.collapsedSections[id]))
  const toggleSection = useUiStore((s) => s.toggleSection)
  const contentId = `sidebar-section-${id}`

  return (
    <section style={{ marginTop: first ? 4 : 12 }}>
      <h2>
        <button
          type="button"
          onClick={() => toggleSection(id)}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          className="flex w-full items-center gap-[8px] text-left text-[var(--fg-tertiary)] hover:text-[var(--fg-secondary)] transition-[color] duration-[var(--dur-fast)] ease-[var(--ease-out-quad)]"
          style={{ height: 28, paddingInline: 12 }}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            aria-hidden
            style={{
              transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform var(--dur-fast) var(--ease-out-quad)'
            }}
          />
          <span
            className="flex-1 truncate"
            style={{ fontSize: 'var(--fs-micro)', lineHeight: '16px', fontWeight: 510 }}
          >
            {label}
          </span>
          {count !== undefined && count > 0 ? (
            <span
              style={{ fontSize: 'var(--fs-micro)', fontWeight: 510, fontVariantNumeric: 'tabular-nums' }}
            >
              {count}
            </span>
          ) : null}
        </button>
      </h2>
      {collapsed ? null : (
        <div id={contentId} role="list">
          {isEmpty ? empty : children}
        </div>
      )}
    </section>
  )
}
