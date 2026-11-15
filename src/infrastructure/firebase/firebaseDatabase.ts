import { type FirebaseApp } from 'firebase/app';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';

import { getFirebaseEnvironment } from '@/config/firebaseEnvironment';
import { getFirebaseApp } from '@/infrastructure/firebase/firebaseApp';

const emulatorApps = new WeakSet<FirebaseApp>();

export function getFirebaseDatabase() {
  const app = getFirebaseApp();
  const database = getDatabase(app);

  if (getFirebaseEnvironment().useEmulators && !emulatorApps.has(app)) {
    connectDatabaseEmulator(database, '127.0.0.1', 9000);
    emulatorApps.add(app);
  }

  return database;
}
