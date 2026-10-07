import './assets/main.css'
import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { markPlatform } from './platform'
import { TrayApp } from './tray/TrayApp'
import { installScrollbarVisibility } from './ui/scrollbars'

// The menu bar popover loads this same page at #tray.
const tray = window.location.hash === '#tray'
if (tray) document.documentElement.dataset.view = 'tray'
markPlatform()
installScrollbarVisibility()

createRoot(document.getElementById('root')!).render(
  <StrictMode>{tray ? <TrayApp /> : <App />}</StrictMode>
)
