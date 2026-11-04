type Props = { className?: string; size?: number }

export default function OrvexMark({ className, size = 34 }: Props) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
      <defs>
        <linearGradient id="mark-face" x1="50" y1="10" x2="50" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#eafaff" />
          <stop offset="0.42" stopColor="#8fdcff" />
          <stop offset="1" stopColor="#2f7dff" />
        </linearGradient>
        <linearGradient id="mark-edge" x1="16" y1="20" x2="84" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#d9f6ff" />
          <stop offset="1" stopColor="#1b5cff" />
        </linearGradient>
      </defs>
      <path
        fillRule="evenodd"
        d="M50 6c2.6 0 5 1.4 6.4 3.8l37 64.7c2.8 5-1 11.2-6.8 11.2H13.4c-5.8 0-9.6-6.2-6.8-11.2l37-64.7C45 7.4 47.4 6 50 6ZM50 60 68.5 88h-37L50 60Z"
        fill="url(#mark-face)"
        stroke="url(#mark-edge)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M50 47v11" stroke="rgba(235,250,255,0.7)" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
