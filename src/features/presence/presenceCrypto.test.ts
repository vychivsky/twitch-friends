import { afterEach, describe, expect, it, vi } from 'vitest';

import { decryptPresence, encryptPresence } from '@/features/presence/presenceCrypto';
import type { LocalIdentity, PublicIdentityKey } from '@/security/identity/localIdentityTypes';

function normalizePublicKey(key: JsonWebKey): PublicIdentityKey {
  if (key.crv !== 'P-256' || key.kty !== 'EC' || !key.x || !key.y) {
    throw new Error('Generated public key is incomplete.');
  }

  return {
    crv: key.crv,
    kty: key.kty,
    x: key.x,
    y: key.y,
  };
}

async function createIdentity(): Promise<LocalIdentity> {
  const encryptionKeys = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    ['deriveBits'],
  );
  return {
    createdAt: Date.now(),
    encryptionPrivateKey: encryptionKeys.privateKey,
    encryptionPublicKey: normalizePublicKey(
      await crypto.subtle.exportKey('jwk', encryptionKeys.publicKey),
    ),
    version: 1,
  };
}

describe('presence encryption', () => {
  it('shares a channel only with the intended friend', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const stranger = await createIdentity();
    const channel = {
      login: 'twitch',
      url: 'https://www.twitch.tv/twitch',
    };
    const encrypted = await encryptPresence(sender, recipient.encryptionPublicKey, channel);

    await expect(
      decryptPresence(recipient, sender.encryptionPublicKey, encrypted),
    ).resolves.toEqual(channel);
    await expect(decryptPresence(stranger, sender.encryptionPublicKey, encrypted)).resolves.toBe(
      null,
    );
  });

  it('rejects expired and modified records', async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const encrypted = await encryptPresence(sender, recipient.encryptionPublicKey, {
      login: 'twitch',
      url: 'https://www.twitch.tv/twitch',
    });

    await expect(
      decryptPresence(recipient, sender.encryptionPublicKey, {
        ...encrypted,
        ciphertext: `${encrypted.ciphertext.startsWith('A') ? 'B' : 'A'}${encrypted.ciphertext.slice(1)}`,
      }),
    ).resolves.toBe(null);
    await expect(
      decryptPresence(recipient, sender.encryptionPublicKey, {
        ...encrypted,
        expiresAt: Date.now() - 1,
      }),
    ).resolves.toBe(null);
  });
});

const channel = { login: 'stream', url: 'https://www.twitch.tv/stream' };

afterEach(() => vi.restoreAllMocks());

describe('presence key caching', () => {
  it('shares key derivation across concurrent writes while using fresh IVs', async () => {
    const [alice, bob] = await Promise.all([createIdentity(), createIdentity()]);
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    const [first, second] = await Promise.all([
      encryptPresence(alice, bob.encryptionPublicKey, channel),
      encryptPresence(alice, bob.encryptionPublicKey, channel),
    ]);

    expect(derive).toHaveBeenCalledOnce();
    expect(first.iv).not.toBe(second.iv);
    expect(await decryptPresence(bob, alice.encryptionPublicKey, first)).toEqual(channel);
    expect(await decryptPresence(bob, alice.encryptionPublicKey, second)).toEqual(channel);
  });

  it('isolates cached keys by sender private key and recipient public key', async () => {
    const [alice, bob, charlie] = await Promise.all([
      createIdentity(),
      createIdentity(),
      createIdentity(),
    ]);
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');

    await encryptPresence(alice, bob.encryptionPublicKey, channel);
    await encryptPresence(alice, charlie.encryptionPublicKey, channel);
    await encryptPresence(charlie, bob.encryptionPublicKey, channel);

    expect(derive).toHaveBeenCalledTimes(3);
  });

  it('rejects expired or tampered records even when the derived key is cached', async () => {
    const [alice, bob] = await Promise.all([createIdentity(), createIdentity()]);
    const record = await encryptPresence(alice, bob.encryptionPublicKey, channel);

    expect(await decryptPresence(bob, alice.encryptionPublicKey, record)).toEqual(channel);
    expect(
      await decryptPresence(bob, alice.encryptionPublicKey, { ...record, expiresAt: 0 }),
    ).toBeNull();
    expect(
      await decryptPresence(bob, alice.encryptionPublicKey, {
        ...record,
        ciphertext: 'a'.repeat(record.ciphertext.length),
      }),
    ).toBeNull();
  });
});
