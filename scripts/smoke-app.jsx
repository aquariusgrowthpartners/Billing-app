/**
 * Test entry — bundled by scripts/smoke.mjs and mounted into a jsdom document.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import App from '../client/src/App.jsx';

export { React, createRoot, act, App };
