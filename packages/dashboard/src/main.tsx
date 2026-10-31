import { createRoot } from 'react-dom/client';
import { App } from './App.js';
export const root = createRoot(document.getElementById('root')!);
root.render(<App/>);
