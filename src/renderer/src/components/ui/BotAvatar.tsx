import type { CSSProperties, ReactElement } from 'react'
import type { Bot, BotAccent, BotShape, AvatarType } from '@shared/types'
import { cn } from '@/lib/cn'

/**
 * The Bot avatar — the product's single most distinctive visual element.
 *
 * A flat, solid-color abstract blob with two pure-white rounded-rect "eyes".
 * No photos, no gradients, no borders, no rings. Every shape is authored on a
 * 24x24 viewBox so all ten read at the same optical weight when scaled.
 *
 * The eyes are the ONLY pure #FFFFFF in the entire app (every other "white"
 * surface is #FCFCFC), which is what makes them pop against the fill.
 */

export const ACCENT_HEX: Record<BotAccent, string> = {
  violet: 'var(--av-violet)',
  blue: 'var(--av-blue)',
  cyan: 'var(--av-cyan)',
  emerald: 'var(--av-emerald)',
  amber: 'var(--av-amber)',
  orange: 'var(--av-orange)',
  rose: 'var(--av-rose)',
  pink: 'var(--av-pink)',
  lime: 'var(--av-lime)',
  indigo: 'var(--av-indigo)'
}

/**
 * Shape geometry on a 24x24 grid. Each entry renders the *fill* only; the eyes
 * are overlaid identically for every shape so a Bot stays recognizable when the
 * user swaps shapes.
 */
const SHAPES: Record<BotShape, ReactElement> = {
  circle: <circle cx="12" cy="12" r="11.5" />,

  // CSS-squircle approximation: a superellipse, noticeably squarer than a circle.
  squircle: <path d="M12 .5c8.2 0 11.5 3.3 11.5 11.5S20.2 23.5 12 23.5.5 20.2.5 12 3.8.5 12 .5Z" />,

  // A circle with one near-sharp corner, top-left. The corner radius is kept
  // tiny (1.4) on purpose — at 3.5 it reads as a plain circle at 24px.
  teardrop: <path d="M.5 1.9A1.4 1.4 0 0 1 1.9.5H12a11.5 11.5 0 1 1-11.5 11.5Z" />,

  // Narrower and higher-shouldered at the top than at the base.
  egg: <path d="M12 .5c5.4 0 9.6 5.7 9.6 11.9 0 6.3-4.3 11.1-9.6 11.1S2.4 18.7 2.4 12.4C2.4 6.2 6.6.5 12 .5Z" />,

  hexagon: (
    <path d="M10.5 1.15a3 3 0 0 1 3 0l7.4 4.28a3 3 0 0 1 1.5 2.6v8.55a3 3 0 0 1-1.5 2.6l-7.4 4.27a3 3 0 0 1-3 0l-7.4-4.27a3 3 0 0 1-1.5-2.6V8.02a3 3 0 0 1 1.5-2.6Z" />
  ),

  // Vertical pill. Deliberately narrower than `egg` so the two never collide
  // at 24px: 13.2 wide against the egg's 19.2.
  capsule: <path d="M12 .8c3.65 0 6.6 2.95 6.6 6.6v9.2a6.6 6.6 0 0 1-13.2 0V7.4C5.4 3.75 8.35.8 12 .8Z" />,

  // Tombstone: semicircular top, flat-ish bottom with softened corners.
  arch: <path d="M12 .8c6.19 0 11.2 5.01 11.2 11.2v7.5a3.5 3.5 0 0 1-3.5 3.5H4.3a3.5 3.5 0 0 1-3.5-3.5V12C.8 5.81 5.81.8 12 .8Z" />,

  // Four-lobe clover. Built from overlapping circles + a center square so the
  // union reads as one bumpy blob without fragile arc-flag math.
  clover: (
    <g>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <circle cx="12" cy="6.6" r="5.6" />
      <circle cx="12" cy="17.4" r="5.6" />
      <circle cx="6.6" cy="12" r="5.6" />
      <circle cx="17.4" cy="12" r="5.6" />
    </g>
  ),

  // Rounded equilateral triangle, apex up.
  triangle: (
    <path d="M9.42 3.34a3 3 0 0 1 5.16 0l7.9 13.62a3 3 0 0 1-2.58 4.5H4.1a3 3 0 0 1-2.58-4.5Z" />
  ),

  // Flat top edge, deeply rounded base — reads as a pennant/flag.
  flag: <path d="M1 3.5A2.5 2.5 0 0 1 3.5 1h17A2.5 2.5 0 0 1 23 3.5V14a9 9 0 0 1-9 9h-4a9 9 0 0 1-9-9Z" />
}

/**
 * A few shapes carry their visual mass low (a triangle is empty at the apex) or
 * high, so the eyes are nudged to sit on the shape's optical centre rather than
 * its geometric one. Everything not listed uses 0.
 */
const EYE_OFFSET: Partial<Record<BotShape, number>> = {
  triangle: 3.4,
  arch: 0.6,
  flag: 0.4
}

/** Two vertical capsules. The 0.2 vertical delta gives the slight tilt. */
function Eyes({ dy = 0 }: { dy?: number }): ReactElement {
  return (
    <g fill="var(--av-eye)" transform={dy ? `translate(0 ${dy})` : undefined}>
      <rect x="8" y="7" width="2.4" height="5.2" rx="1.2" />
      <rect x="13.6" y="6.8" width="2.4" height="5.2" rx="1.2" />
    </g>
  )
}

export interface BotAvatarProps {
  /** Pass a whole Bot, or the three fields individually. */
  bot?: Pick<Bot, 'name' | 'avatarType' | 'avatarValue' | 'accent'> | null
  name?: string
  avatarType?: AvatarType
  avatarValue?: string
  accent?: BotAccent
  size?: number
  /** Pulsing accent ring, for a Bot that is mid-turn. */
  working?: boolean
  /**
   * Separator ring painted OUTSIDE the avatar's own silhouette, so a cluster
   * member reads as cut out of the one behind it. Only `GroupAvatar` sets it.
   * `width` is in device px; `color` must be the colour of whatever sits behind
   * the cluster (the ring is a gap, not a stroke).
   */
  ring?: { width: number; color: string } | null
  className?: string
  style?: CSSProperties
  title?: string
}

export function BotAvatar({
  bot,
  name,
  avatarType,
  avatarValue,
  accent,
  size = 40,
  working = false,
  ring = null,
  className,
  style,
  title
}: BotAvatarProps): ReactElement {
  const type: AvatarType = avatarType ?? bot?.avatarType ?? 'shape'
  const value = avatarValue ?? bot?.avatarValue ?? 'circle'
  const color = ACCENT_HEX[accent ?? bot?.accent ?? 'violet']
  const displayName = name ?? bot?.name ?? ''

  // `inline-block` is load-bearing: a bare <span> is display:inline and ignores
  // width/height, which collapses any avatar whose children are absolutely
  // positioned (see GroupAvatar) to a 0x0 box.
  const wrapper = cn('relative inline-block shrink-0 select-none align-middle', working && 'working-ring', className)
  const ringWidth = ring && ring.width > 0 ? ring.width : 0
  const ringPaint = ringWidth > 0 && ring ? ring.color : null
  const wrapperStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    // Honest ONLY for the three branches below, whose avatars really are
    // circular boxes. The shape branch draws its own ring and clears this —
    // see the long comment there.
    boxShadow: ringPaint ? `0 0 0 ${ringWidth}px ${ringPaint}` : undefined,
    ...style
  }

  if (type === 'emoji') {
    return (
      <span
        className={cn(wrapper, 'grid place-items-center')}
        style={{
          ...wrapperStyle,
          background: 'var(--surface-2)',
          fontSize: Math.round(size * 0.56),
          fontFamily: 'var(--font-emoji)',
          lineHeight: 1
        }}
        title={title ?? displayName}
        aria-label={displayName}
        role="img"
      >
        {value || '🤖'}
      </span>
    )
  }

  if (type === 'initials') {
    return (
      <span
        className={cn(wrapper, 'grid place-items-center')}
        style={{
          ...wrapperStyle,
          background: color,
          color: '#fff',
          fontSize: Math.round(size * 0.38),
          fontWeight: 550,
          letterSpacing: '-0.02em'
        }}
        title={title ?? displayName}
        aria-label={displayName}
        role="img"
      >
        {initialsOf(value || displayName)}
      </span>
    )
  }

  if (type === 'image' && value) {
    return (
      <span className={wrapper} style={wrapperStyle} title={title ?? displayName}>
        <img
          src={value}
          alt={displayName}
          className="h-full w-full rounded-full object-cover"
          draggable={false}
        />
      </span>
    )
  }

  const shapeKey = (value in SHAPES ? value : 'circle') as BotShape
  const shape = SHAPES[shapeKey]

  /**
   * THE RING, for a shape avatar.
   *
   * It used to be the same `box-shadow` as the branches above, on a wrapper with
   * `border-radius: 50%`. That draws a perfect CIRCLE, and eight of the ten
   * shapes are not circles — so in a group cluster the ring traced a circle that
   * had nothing to do with the blob inside it and painted black arcs straight
   * across the neighbouring members (an arch's flat bottom left a floating
   * crescent below it; a hexagon got sliced through the middle). The ring has to
   * follow the silhouette, and a box-shadow cannot do that.
   *
   * So it is a STROKE, drawn as a second copy of the shape sitting BEHIND the
   * filled one. Stroking the front copy instead would break `clover`, which is a
   * <g> of five overlapping sub-shapes: each sub-shape's stroke would paint a
   * seam across its already-filled siblings. Behind the fill those seams are
   * covered, and because dilating a union is the same as unioning the dilations,
   * the back copy's outline is exactly the silhouette offset outward.
   *
   * A stroke straddles its path, so only half of it lands outside — hence the
   * doubling. `ring.width` is device px while the stroke is authored in the
   * 24-unit viewBox, so it is converted here. `overflow: visible` on the <svg>
   * (already required by the shapes themselves) keeps the outward half unclipped,
   * and GroupAvatar reserves exactly one ring width of padding on every side.
   */
  const ringStroke = (2 * ringWidth * 24) / size

  return (
    <span
      className={wrapper}
      style={{ ...wrapperStyle, boxShadow: style?.boxShadow }}
      title={title ?? displayName}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role="img"
        aria-label={displayName}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {ringPaint ? (
          <g
            fill={ringPaint}
            stroke={ringPaint}
            strokeWidth={ringStroke}
            // Round joins: a mitred corner on the hexagon, triangle or flag
            // would spike far past `ring.width` and out of the cluster's box.
            strokeLinejoin="round"
          >
            {shape}
          </g>
        ) : null}
        <g fill={color}>{shape}</g>
        <Eyes dy={EYE_OFFSET[shapeKey] ?? 0} />
      </svg>
    </span>
  )
}

/**
 * Avatar for a group conversation: a cluster of up to three member avatars.
 *
 * Every layout is computed so the cluster's INK — the member blobs plus their
 * separator rings — fits exactly inside `size`. A group avatar that overflows
 * its box shunts the sidebar row's text sideways, spills past the chat header's
 * identity pill and, in the horizontal pinned strip, collides with the
 * neighbouring item.
 */
export function GroupAvatar({
  members,
  size = 40,
  ringColor = 'var(--avatar-ring, var(--surface-1))',
  className
}: {
  members: Array<Pick<Bot, 'name' | 'avatarType' | 'avatarValue' | 'accent'>>
  size?: number
  /**
   * The separator ring is a CUT-OUT in whatever sits behind the cluster, so it
   * has to be painted in that surface's colour — in the wrong colour it reads as
   * a dark halo instead of a gap. The default lets a surface declare itself by
   * setting `--avatar-ring`; pass this explicitly from anything that paints its
   * own background (a popover on --surface-3, say).
   */
  ringColor?: string
  className?: string
}): ReactElement {
  // Below 28px a third member is ~14px of ink with 2px eyes: it reads as clutter,
  // not as a member. Two blobs at that scale are each 4px bigger and legible.
  const shown = members.slice(0, size >= 28 ? 3 : 2)

  if (shown.length <= 1) {
    return <BotAvatar bot={shown[0]} size={size} className={className} />
  }

  // Ring width scales with the avatar, and drops to nothing below 28px: a 1.5px
  // ring eats a fifth of a 14px blob and, at that scale, its arc cuts straight
  // through the neighbouring blob's eyes. Small clusters separate by overlap
  // order alone.
  //
  // The 2px step starts at 56 (the pinned tile), not at 40 (the sidebar row).
  // Every ring is a CUT-OUT, so its width is ink the cluster does not have: at
  // 40px, dropping 2px to 1.5px measured 851 -> 904 ink pixels inside the box
  // (counted off a real screenshot), which is the cheapest weight a group row
  // can gain against the 1080-1308 of the 1:1 rows above it, and it costs
  // nothing — the members stay the same size and the gaps still read.
  const ring = size >= 56 ? 2 : size >= 28 ? 1.5 : 0

  // The ring paints OUTSIDE the member box, so the members get `size` minus a
  // ring on each side and the whole cluster is nudged in by one ring width.
  //
  // Do NOT raise these ratios to chase weight parity with a 1:1 avatar. It was
  // measured: 3 members at 0.58 -> 848 ink, 0.66 -> 891, 0.70 -> 902, against
  // 1085-1312 for a single blob, and 2 members at 0.78 -> 909 with the back
  // member collapsed to a crescent. Three separated silhouettes inside a 40px
  // box cannot fill it the way one blob does, and every step up occludes more
  // of the back member (at 0.66 its bottom HALF disappears behind the front
  // two). A group avatar reads lighter than a 1:1 avatar; that is the
  // convention, not a defect worth trading identity for.
  const span = size - 2 * ring
  const inner = shown.length === 2 ? Math.round(span * 0.66) : Math.round(span * 0.58)
  const far = span - inner // right/bottom-aligned coordinate; guarantees containment

  const positions =
    shown.length === 2
      ? [
          { left: ring, top: ring },
          { left: ring + far, top: ring + far }
        ]
      : [
          { left: ring + Math.round(far / 2), top: ring },
          { left: ring, top: ring + far },
          { left: ring + far, top: ring + far }
        ]

  return (
    <span
      // `isolate` contains the members' z-indexes. Without it they escape into
      // the nearest ancestor stacking context and paint OVER anything a caller
      // layers on top of the avatar — which silently swallowed the pinned
      // strip's unread badge the moment it moved onto the blob.
      className={cn('relative isolate inline-block shrink-0 align-middle', className)}
      style={{ width: size, height: size }}
      aria-label={members.map((m) => m.name).join(', ')}
      role="img"
    >
      {shown.map((m, i) => (
        <span
          key={`${m.name}-${i}`}
          className="absolute"
          style={{
            left: positions[i]!.left,
            top: positions[i]!.top,
            // `display:block` + `lineHeight:0` are load-bearing. Without them the
            // positioning span is a shrink-to-fit box whose height comes from the
            // inherited line-height strut, not from the avatar: at size 24 that
            // made each member a 14x22 box rather than a square, which throws off
            // every containment sum below.
            display: 'block',
            width: inner,
            height: inner,
            lineHeight: 0,
            // Later avatars sit on top, so the cluster reads front-to-back.
            zIndex: i + 1
          }}
        >
          {/* The ring belongs to the AVATAR, not to this box. As a box-shadow on
              a `border-radius: 50%` span it was a circle drawn around a hexagon,
              an arch or a clover — see the ring comment in BotAvatar. */}
          <BotAvatar
            bot={m}
            size={inner}
            ring={ring ? { width: ring, color: ringColor } : null}
          />
        </span>
      ))}
    </span>
  )
}

function initialsOf(source: string): string {
  const parts = source.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
