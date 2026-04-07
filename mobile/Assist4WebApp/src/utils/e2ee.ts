import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const E2EE_PREFIX = 'e2ee:v1:';

const deriveKey = (passphrase: string, userId: string | number) => {
  const source = `${passphrase}:${String(userId)}`;
  const sourceBytes = naclUtil.decodeUTF8(source);
  const hash = nacl.hash(sourceBytes);
  return hash.slice(0, nacl.secretbox.keyLength);
};

export const isE2EEPayload = (value: string) =>
  typeof value === 'string' && value.startsWith(E2EE_PREFIX);

export const encryptE2EE = (
  plainText: string,
  passphrase: string,
  userId: string | number,
) => {
  if (!passphrase) {
    return plainText;
  }

  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const key = deriveKey(passphrase, userId);
  const messageBytes = naclUtil.decodeUTF8(plainText);
  const box = nacl.secretbox(messageBytes, nonce, key);

  return `${E2EE_PREFIX}${naclUtil.encodeBase64(nonce)}:${naclUtil.encodeBase64(box)}`;
};

export const decryptE2EE = (
  payload: string,
  passphrase: string,
  userId: string | number,
) => {
  if (!isE2EEPayload(payload)) {
    return payload;
  }

  if (!passphrase) {
    return '[Encrypted message. Set E2EE key to read.]';
  }

  try {
    const body = payload.slice(E2EE_PREFIX.length);
    const [nonceBase64, boxBase64] = body.split(':');
    if (!nonceBase64 || !boxBase64) {
      return '[Encrypted message. Invalid payload.]';
    }

    const nonce = naclUtil.decodeBase64(nonceBase64);
    const box = naclUtil.decodeBase64(boxBase64);
    const key = deriveKey(passphrase, userId);
    const opened = nacl.secretbox.open(box, nonce, key);

    if (!opened) {
      return '[Encrypted message. Wrong key.]';
    }

    return naclUtil.encodeUTF8(opened);
  } catch (_error) {
    return '[Encrypted message. Unable to decrypt.]';
  }
};
