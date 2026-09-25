import {statSync} from 'node:fs';
import path from 'node:path';

export const effectNames = Object.freeze(['shot', 'hit', 'defeat', 'revive', 'match-end']);

export function availableEffects(dir) {
  const found = {};
  for (const kind of effectNames) {
    for (const extension of ['mp3', 'wav']) {
      const file = path.join(dir, `${kind}.${extension}`);
      try {
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        found[kind] = {file, url: `/effects/${kind}.${extension}?v=${stat.mtimeMs}-${stat.size}`};
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return found;
}
