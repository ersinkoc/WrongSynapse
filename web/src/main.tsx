import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@radix-ui/themes';

import App from './App';
import './index.css';
import '@radix-ui/themes/styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    {/* Radix UI's <Theme> handles its own dark surface (accentColor="cyan"
       matches the dark-pro primary). We set appearance="dark" to lock the
       palette regardless of host OS preference. */}
    <Theme accentColor="cyan" grayColor="slate" radius="medium" appearance="dark" panelBackground="solid">
      <App />
    </Theme>
  </StrictMode>,
);
