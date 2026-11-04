import { useEffect } from 'react'
import { useMotionValue, type MotionValue } from 'framer-motion'

/** Mirrors a live-updated ref (mic amplitude 0..1) into a framer MotionValue each frame. */
export function useLevelMotion(levelRef: { current: number }): MotionValue<number> {
  const mv = useMotionValue(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      mv.set(levelRef.current)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [mv, levelRef])
  return mv
}
