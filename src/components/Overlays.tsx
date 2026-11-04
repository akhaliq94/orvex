import { AnimatePresence, motion } from 'framer-motion'

export function Toast({ message }: { message: string | null }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          className="toast"
          role="status"
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          transition={{ duration: 0.22 }}
        >
          <span className="toast-dot" />
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
