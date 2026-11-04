import { useMemo } from 'react'
import { motion, useTransform } from 'framer-motion'
import OrvexMark from './OrvexMark'
import { useLevelMotion } from '../hooks/useLevelMotion'

type LevelRef = { current: number }
type Props = { listening: boolean; levelRef: LevelRef }

const rand = (min: number, max: number) => Math.random() * (max - min) + min

export default function AICore({ listening, levelRef }: Props) {
  const particles = useMemo(
    () =>
      Array.from({ length: 46 }, (_, i) => {
        const a = Math.random() * Math.PI * 2
        const r = rand(28, 49)
        return {
          id: i,
          left: 50 + Math.cos(a) * r,
          top: 50 + Math.sin(a) * r * 0.92,
          delay: rand(0, 3.6),
          dur: rand(2.4, 5),
          size: Math.random() > 0.82 ? 3 : 2,
        }
      }),
    [],
  )

  // live audio level → motion values (read every frame, no react re-render)
  const lv = useLevelMotion(levelRef)

  const logoScale = useTransform(lv, [0, 0.35, 1], [1, 1.14, 1.32])
  const glowScale = useTransform(lv, [0, 1], [1, 1.22])
  const glowOpacity = useTransform(lv, [0, 1], [0.85, 1])
  const sphereFilter = useTransform(
    lv,
    (v) => `brightness(${1 + v * 0.75}) saturate(${1 + v * 0.4})`,
  )
  const ringScale = useTransform(lv, [0, 1], [1, 1.045])
  const ringFilter = useTransform(
    lv,
    (v) => `brightness(${1 + v * 0.9}) drop-shadow(0 0 ${6 + v * 26}px rgba(var(--accent-rgb), ${0.35 + v * 0.5}))`,
  )
  const particlesOpacity = useTransform(lv, [0, 0.4, 1], [0.8, 1, 1])
  const rippleScale = useTransform(lv, [0, 1], [0.62, 1.05])
  const rippleOpacity = useTransform(lv, [0.04, 0.45], [0, 0.55])

  return (
    <div className="aicore" aria-hidden>
      <motion.div className="aicore-glow-wrap" style={{ scale: glowScale, opacity: glowOpacity }}>
        <div className="aicore-glow" />
      </motion.div>
      <div className="aicore-beam" />
      <div className="aicore-platform" />

      {/* voice ripples that expand with speech */}
      <motion.div
        className="voice-ripple"
        style={{ scale: rippleScale, opacity: rippleOpacity }}
      />
      <motion.div
        className="voice-ripple r2"
        style={{ scale: rippleScale, opacity: rippleOpacity }}
      />

      {/* orbit / ring system */}
      <motion.svg className="aicore-ring" viewBox="0 0 500 500" style={{ scale: ringScale, filter: ringFilter }}>
        <defs>
          <linearGradient id="ring-a" x1="40" y1="60" x2="460" y2="440" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.95" />
            <stop offset="0.45" stopColor="var(--accent)" stopOpacity="0.12" />
            <stop offset="1" stopColor="var(--accent2)" stopOpacity="0.85" />
          </linearGradient>
          <linearGradient id="ring-b" x1="80" y1="420" x2="440" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--accent2)" stopOpacity="0.8" />
            <stop offset="0.5" stopColor="var(--accent)" stopOpacity="0.15" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0.95" />
          </linearGradient>
          <radialGradient id="dot-glow">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.5" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <filter id="ring-blur" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g style={{ transformOrigin: '250px 250px', animation: 'spin 64s linear infinite' }} opacity="0.5">
          <circle cx="250" cy="250" r="228" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 9" fill="none" />
        </g>

        <g style={{ transformOrigin: '250px 250px', animation: 'spin-rev 92s linear infinite' }} opacity="0.4">
          <circle cx="250" cy="250" r="212" stroke="url(#ring-a)" strokeWidth="1.2" strokeDasharray="46 26 8 30" fill="none" />
        </g>

        <g filter="url(#ring-blur)">
          <g style={{ transformOrigin: '250px 250px', animation: 'spin 34s linear infinite' }}>
            <ellipse cx="250" cy="250" rx="234" ry="82" stroke="url(#ring-a)" strokeWidth="2" strokeDasharray="3 12" fill="none" transform="rotate(-16 250 250)" />
            <circle cx="484" cy="250" r="9" fill="url(#dot-glow)" transform="rotate(-16 250 250)" />
            <circle cx="484" cy="250" r="3" fill="#ffffff" transform="rotate(-16 250 250)" />
          </g>
          <g style={{ transformOrigin: '250px 250px', animation: 'spin-rev 46s linear infinite' }}>
            <ellipse cx="250" cy="250" rx="242" ry="64" stroke="url(#ring-b)" strokeWidth="1.6" strokeDasharray="2 10" fill="none" transform="rotate(28 250 250)" />
            <circle cx="492" cy="250" r="6" fill="url(#dot-glow)" transform="rotate(28 250 250)" />
          </g>
          <g style={{ transformOrigin: '250px 250px', animation: 'spin 54s linear infinite' }} opacity="0.75">
            <ellipse cx="250" cy="250" rx="206" ry="122" stroke="var(--accent)" strokeOpacity="0.3" strokeWidth="0.9" strokeDasharray="1 7" fill="none" transform="rotate(74 250 250)" />
          </g>
        </g>

        {/* sparkles */}
        {[
          [96, 176, 7],
          [402, 128, 5],
          [430, 340, 6],
          [92, 352, 4.5],
          [318, 74, 4],
          [186, 424, 4],
        ].map(([x, y, s], i) => (
          <path
            key={i}
            d={`M${x} ${y - s} L${x + s * 0.22} ${y - s * 0.22} L${x + s} ${y} L${x + s * 0.22} ${y + s * 0.22} L${x} ${y + s} L${x - s * 0.22} ${y + s * 0.22} L${x - s} ${y} L${x - s * 0.22} ${y - s * 0.22} Z`}
            fill="#dff6ff"
            opacity="0.9"
            style={{ animation: `twinkle ${3 + i * 0.7}s ease-in-out ${i * 0.4}s infinite` }}
          />
        ))}
      </motion.svg>

      {/* sphere */}
      <motion.div className="aicore-sphere" style={{ filter: sphereFilter }} />
      <motion.svg className="aicore-wire" viewBox="0 0 320 320" style={{ opacity: particlesOpacity }}>
        <defs>
          <clipPath id="sphere-clip">
            <circle cx="160" cy="160" r="149" />
          </clipPath>
          <radialGradient id="wire-fade" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0.35" stopColor="var(--accent)" stopOpacity="0.6" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0.1" />
          </radialGradient>
        </defs>
        <g clipPath="url(#sphere-clip)" stroke="url(#wire-fade)" fill="none" strokeWidth="1">
          {[-120, -90, -60, -30, 0, 30, 60, 90, 120].map((y) => {
            const rx = Math.sqrt(Math.max(1, 149 * 149 - y * y))
            return <ellipse key={y} cx="160" cy={160 + y} rx={rx} ry={rx * 0.16} />
          })}
          {[16, 46, 76, 104, 126, 144].map((rx) => (
            <ellipse key={rx} cx="160" cy="160" rx={rx} ry="149" />
          ))}
          <ellipse cx="160" cy="160" rx="149" ry="149" stroke="rgba(180,236,255,0.5)" />
        </g>
        <g style={{ transformOrigin: '160px 160px', animation: 'spin 26s linear infinite' }}>
          <ellipse cx="160" cy="160" rx="149" ry="42" stroke="rgba(190,242,255,0.75)" strokeWidth="1.4" strokeDasharray="48 18 6 30" fill="none" transform="rotate(-18 160 160)" />
          <circle cx="309" cy="160" r="5" fill="url(#dot-glow)" transform="rotate(-18 160 160)" />
          <circle cx="309" cy="160" r="2" fill="#fff" transform="rotate(-18 160 160)" />
        </g>
        <g style={{ transformOrigin: '160px 160px', animation: 'spin 38s linear infinite' }} opacity="0.6">
          <ellipse cx="160" cy="160" rx="172" ry="54" stroke="var(--accent)" strokeWidth="1.3" strokeDasharray="86 30 10 26" fill="none" transform="rotate(26 160 160)" />
          <circle cx="332" cy="160" r="3" fill="#dff8ff" transform="rotate(26 160 160)" />
        </g>
        <g style={{ transformOrigin: '160px 160px', animation: 'spin-rev 44s linear infinite' }} opacity="0.4">
          <ellipse cx="160" cy="160" rx="176" ry="62" stroke="var(--accent)" strokeWidth="1" strokeDasharray="4 14" fill="none" transform="rotate(-48 160 160)" />
        </g>
      </motion.svg>

      <motion.div
        className="aicore-logo"
        style={{ width: '22.5%', scale: logoScale }}
        animate={{ opacity: listening ? [0.85, 1, 0.85] : [0.9, 1, 0.9] }}
        transition={{ duration: listening ? 1.4 : 4, repeat: Infinity, ease: 'easeInOut' }}
      >
        <div className="aicore-logo-inner">
          <OrvexMark size={1000} className="w-full h-auto" />
        </div>
      </motion.div>

      <motion.div className="particles" style={{ opacity: particlesOpacity }}>
        {particles.map((p) => (
          <span
            key={p.id}
            className="particle"
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
            }}
          />
        ))}
      </motion.div>
    </div>
  )
}
