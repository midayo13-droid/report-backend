import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// 연결 키는 원문으로 저장하지 않고 암호화한 값만 저장해요. (화면에는 끝 4자리만 보여 줘요)
function key(): Buffer {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY 는 64자리 16진수여야 해요. backend/.env 를 확인해 주세요.');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptText(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptText(payload: string): string {
  const [iv, tag, enc] = payload.split('.');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

export function maskKey(plain: string): string {
  const tail = plain.slice(-4);
  return `••••••••${tail}`;
}
