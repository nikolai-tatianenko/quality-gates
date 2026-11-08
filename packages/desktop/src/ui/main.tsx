import { createRoot } from 'react-dom/client';
import Launcher from './Launcher.js';
import { tauriTransport, type TauriGlobal } from './transport.js';

createRoot(document.getElementById('root')!).render(<Launcher transport={tauriTransport((globalThis as unknown as { __TAURI__: TauriGlobal }).__TAURI__)} />);
