import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../util/logger.js';

const log = createLogger('store:blobs');

export interface StoredBlob {
  /** Relative path recorded in SQLite; resolve through `path()`. */
  ref: string;
  size: number;
  sha256: string;
}

/**
 * Content-addressed payload store. Response bodies repeat heavily across a
 * session (same bundle on every reload), so addressing by hash keeps the disk
 * cost proportional to distinct content rather than request count.
 */
export class BlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  put(data: Buffer): StoredBlob {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const ref = join(sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.bin`).replace(/\\/g, '/');
    const full = this.path(ref);
    if (!existsSync(full)) {
      mkdirSync(join(this.root, sha256.slice(0, 2), sha256.slice(2, 4)), { recursive: true });
      writeFileSync(full, data);
    }
    return { ref, size: data.length, sha256 };
  }

  putText(text: string): StoredBlob {
    return this.put(Buffer.from(text, 'utf8'));
  }

  path(ref: string): string {
    return join(this.root, ref);
  }

  get(ref: string): Buffer | null {
    const full = this.path(ref);
    try {
      return readFileSync(full);
    } catch (err) {
      log.debug(`blob missing ${ref}`, err);
      return null;
    }
  }

  size(ref: string): number | null {
    try {
      return statSync(this.path(ref)).size;
    } catch {
      return null;
    }
  }
}
