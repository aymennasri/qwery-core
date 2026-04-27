import { TransformStream } from 'node:stream/web';

import '@testing-library/jest-dom/vitest';

globalThis.TransformStream ??=
  TransformStream as typeof globalThis.TransformStream;
