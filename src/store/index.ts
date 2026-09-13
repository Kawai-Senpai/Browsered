import { join } from 'node:path';
import { paths } from '../util/paths.js';
import { ArtifactStore } from './artifact-store.js';
import { BlobStore } from './blobs.js';
import { ConsoleStore } from './console-store.js';
import { openDatabase, type Db } from './db.js';
import { DocumentStore } from './document-store.js';
import { NetworkStore } from './network-store.js';
import { TargetStore } from './target-store.js';
import { WebSocketStore } from './websocket-store.js';

export interface Stores {
  db: Db;
  network: NetworkStore;
  console: ConsoleStore;
  websockets: WebSocketStore;
  targets: TargetStore;
  blobs: BlobStore;
  artifacts: ArtifactStore;
  documents: DocumentStore;
  close(): void;
}

export function createStores(dbFile = paths.db(), blobDir = paths.blobs()): Stores {
  const db = openDatabase(dbFile);
  return {
    db,
    network: new NetworkStore(db),
    console: new ConsoleStore(db),
    websockets: new WebSocketStore(db),
    targets: new TargetStore(db),
    blobs: new BlobStore(blobDir),
    artifacts: new ArtifactStore(db, join(paths.home(), 'artifacts')),
    documents: new DocumentStore(db),
    close: () => db.close(),
  };
}

export { ArtifactStore } from './artifact-store.js';
export { BlobStore } from './blobs.js';
export { ConsoleStore } from './console-store.js';
export { DocumentStore } from './document-store.js';
export { NetworkStore } from './network-store.js';
export { TargetStore } from './target-store.js';
export { WebSocketStore } from './websocket-store.js';
