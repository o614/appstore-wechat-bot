export class ResponseBodyTooLargeError extends Error {
  override name = "ResponseBodyTooLargeError";
}

export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const announcedLength = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    if (response.body !== null) await response.body.cancel("response_too_large");
    throw new ResponseBodyTooLargeError("response_too_large");
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("response_too_large");
        throw new ResponseBodyTooLargeError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
