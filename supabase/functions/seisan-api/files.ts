// 添付ファイルの名前と形式の決まり（今のGASの sd_uploadAttachment と同じ名前の付け方）
export const MAX_BYTES = 25 * 1024 * 1024;

export function attachmentName(kind: unknown, month: string, store: string, fileName: unknown, revised: boolean, existing: string[]) {
  const k = String(kind ?? '').trim().replace(/[\\/\u0000-\u001f]/g, '_');
  const ext = String(fileName ?? '').match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? '';
  const base = `${k}_${month.replace('-', '.')}_${store}`;
  let name = base + ext;
  if (revised && existing.includes(name)) {
    let prefix = '【再】';
    for (let n = 2; existing.includes(prefix + base + ext); n++) prefix = `【再${n}】`;
    name = prefix + base + ext;
  }
  return { kind: k, name, ext };
}

// 開いたときにブラウザで実行される形式（HTMLなど）は、ただのファイルとして保存する
const SAFE = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'text/csv', 'text/plain'];
export const safeMime = (m: unknown) => (SAFE.includes(String(m)) || /^application\/vnd\./.test(String(m)) || String(m) === 'application/zip' ? String(m) : 'application/octet-stream');

export function decodeB64(b64: unknown) {
  const s = String(b64 ?? '');
  if (!s || s.length > Math.ceil(MAX_BYTES / 3) * 4) return null;
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
}
export function encodeB64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
