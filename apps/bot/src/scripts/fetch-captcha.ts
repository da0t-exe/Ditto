/**
 * npm run captcha:fetch [photos per category] — adds more photos from Open Images to
 * data/captcha, on top of the database shipped with Ditto. Then run /captcha reload.
 */
import path from 'node:path';
import { buildPool } from '../features/captcha/build.js';
import { BUNDLED_DIR, EXTRA_DIR, readManifest } from '../features/captcha/pool.js';

const perClass = Number(process.argv[2] ?? 40);
const skip = new Set((readManifest(BUNDLED_DIR)?.images ?? []).map((im) => im.id));

buildPool({ outDir: EXTRA_DIR, cacheDir: path.join(EXTRA_DIR, 'cache'), perClass, skip }).catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
