import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<p>WebRTC Blocker</p>);
}
