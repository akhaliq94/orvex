import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MiniWindow from './MiniWindow'
import './index.css'
import './research.css'
import './memory.css'
import './files.css'
import './media.css'
import './control.css'
import './security.css'
import './monitoring.css'
import './mini.css'
import './productivity.css'
import './advanced.css'
import './training.css'
import './workforce.css'

const isMini = window.location.hash === '#mini'
if (isMini) document.documentElement.classList.add('mini-window')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isMini ? <MiniWindow /> : <App />}</StrictMode>,
)
