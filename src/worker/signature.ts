export async function verifySignature(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !signature ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300_000 ||
    !/^[0-9a-f]{128}$/i.test(signature) ||
    !/^[0-9a-f]{64}$/i.test(publicKey)
  )
    return false;
  try {
    const bytes = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
    const key = await crypto.subtle.importKey('raw', bytes(publicKey), { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      bytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
