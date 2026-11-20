import { readLocalIdentity, writeLocalIdentity } from '@/security/identity/identityDatabase';
import { type LocalIdentity, type PublicIdentityKey } from '@/security/identity/localIdentityTypes';

let identityPromise: Promise<LocalIdentity> | null = null;

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

async function createLocalIdentity(): Promise<LocalIdentity> {
  const encryptionKeyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    ['deriveBits'],
  );
  const encryptionPublicKey = normalizePublicKey(
    await crypto.subtle.exportKey('jwk', encryptionKeyPair.publicKey),
  );

  return {
    createdAt: Date.now(),
    encryptionPrivateKey: encryptionKeyPair.privateKey,
    encryptionPublicKey,
    version: 1,
  };
}

function isBase64UrlCoordinate(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isUsableLocalIdentity(value: unknown): value is LocalIdentity {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const identity = value as Record<string, unknown>;
  const privateKey = identity.encryptionPrivateKey;
  const publicKey =
    identity.encryptionPublicKey && typeof identity.encryptionPublicKey === 'object'
      ? (identity.encryptionPublicKey as Record<string, unknown>)
      : null;

  return (
    identity.version === 1 &&
    typeof identity.createdAt === 'number' &&
    privateKey instanceof CryptoKey &&
    privateKey.type === 'private' &&
    privateKey.algorithm.name === 'ECDH' &&
    (privateKey.algorithm as EcKeyAlgorithm).namedCurve === 'P-256' &&
    privateKey.usages.includes('deriveBits') &&
    publicKey?.crv === 'P-256' &&
    publicKey.kty === 'EC' &&
    isBase64UrlCoordinate(publicKey.x) &&
    isBase64UrlCoordinate(publicKey.y)
  );
}

async function loadOrCreateLocalIdentity() {
  const existingIdentity: unknown = await readLocalIdentity();

  if (isUsableLocalIdentity(existingIdentity)) {
    return existingIdentity;
  }

  const identity = await createLocalIdentity();

  await writeLocalIdentity(identity);

  return identity;
}

export function getOrCreateLocalIdentity() {
  identityPromise ??= loadOrCreateLocalIdentity().catch((cause: unknown) => {
    identityPromise = null;
    throw cause;
  });

  return identityPromise;
}
