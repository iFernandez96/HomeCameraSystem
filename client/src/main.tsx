import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './lib/theme'
import './index.css'

// Dual-theme wiring: the index.html inline script already resolved the
// pre-paint theme; initTheme re-applies + follows OS/cross-tab changes
// and keeps the theme-color metas in step for the tab's lifetime.
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
