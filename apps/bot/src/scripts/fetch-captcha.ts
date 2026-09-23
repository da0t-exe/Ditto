/** npm run captcha:fetch — construit (ou complète) la réserve d'images du captcha. */
import { buildPool } from '../features/captcha/build.js';

buildPool().catch((err) => {
  console.error('Échec :', err);
  process.exit(1);
});
