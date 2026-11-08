import { createRoot } from 'react-dom/client';
import Popup from './Popup.js';
import type { ChromeApi } from './types.js';

// `chrome` exists only inside the extension; the popup page is the one place that reads it.
createRoot(document.getElementById('root')!).render(<Popup chromeApi={(globalThis as unknown as { chrome: ChromeApi }).chrome}/>);
