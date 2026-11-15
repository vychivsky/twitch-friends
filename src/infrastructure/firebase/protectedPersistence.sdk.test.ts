import { describe, expect, it } from 'vitest';

import { isProtectedPersistenceSupported } from '@/infrastructure/firebase/protectedPersistence';

describe('installed Firebase Auth SDK', () => {
  it('exposes the persistence methods that the credential guard overrides', () => {
    expect(isProtectedPersistenceSupported()).toBe(true);
  });
});
