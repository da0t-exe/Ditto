/** npm run captcha:fetch — builds (or tops up) the captcha image pool. */
import { buildPool } from '../features/captcha/build.js';

buildPool().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
