import type { JsonValue, PluginContext } from "cursor-byok:plugin";

export const SERVER = "https://server.codeium.com";
export const SERVICE = `${SERVER}/exa.api_server_pb.ApiServerService`;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Devin's Connect endpoints use the same metadata/authentication as devin2api. */
export function metadata(token: string): Record<string, string> {
  return {
    apiKey: token,
    extensionName: "chisel",
    extensionVersion: "3000.2.17",
    ideName: "chisel",
    ideVersion: "3000.2.17",
    locale: "en",
    os: "mac",
  };
}

export class ConnectError extends Error {
  constructor(public code: string, message: string) {
    super(`Devin ${code}: ${message}`);
  }
}

/** Upstream errors can echo metadata; never return credentials to the UI/log. */
export function connectError(
  body: string,
  status: number,
  secrets: string[],
): ConnectError {
  let code = `http_${status}`;
  let message = "request failed";
  try {
    const value = JSON.parse(body);
    code = value.code ?? code;
    message = value.message ?? message;
  } catch { /* A non-JSON gateway error carries only its HTTP status. */ }
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return new ConnectError(code, message);
}

export async function unary(
  method: string,
  token: string,
  context: PluginContext,
): Promise<Record<string, unknown>> {
  const response = await context.network.fetch(`${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${token}-${token}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "user-agent": "",
    },
    body: JSON.stringify({ metadata: metadata(token) }),
  });
  if (response.status !== 200) {
    throw connectError(response.body, response.status, [token]);
  }
  return JSON.parse(response.body);
}

/** The transport envelope uses byte lengths, including for non-ASCII JSON. */
export function encodeFrame(value: JsonValue): Uint8Array {
  const payload = encoder.encode(JSON.stringify(value));
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error("Devin request exceeds the frame limit");
  }
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32 * 1024));
  }
  return btoa(binary);
}

/** Framing is independent of HTTP chunks; EOF without EndStream is a failure. */
export async function* decodeFrames(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Record<string, any>> {
  let pending = new Uint8Array(0);
  let ended = false;
  for await (const chunk of chunks) {
    if (ended && chunk.length) {
      throw new Error("Devin sent data after EndStream");
    }
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    while (pending.length >= 5) {
      const flags = pending[0];
      const length = new DataView(
        pending.buffer,
        pending.byteOffset,
        pending.byteLength,
      ).getUint32(1);
      if (flags !== 0 && flags !== 2) {
        throw new Error("Unsupported Devin Connect frame flags");
      }
      if (length > MAX_FRAME_BYTES) {
        throw new Error("Devin response exceeds the frame limit");
      }
      if (pending.length < 5 + length) break;
      const value = JSON.parse(decoder.decode(pending.subarray(5, 5 + length)));
      pending = pending.slice(5 + length);
      if (flags === 2) {
        if (value.error) {
          throw new ConnectError(value.error.code, value.error.message);
        }
        if (pending.length) throw new Error("Devin sent data after EndStream");
        ended = true;
        break;
      }
      yield value;
    }
  }
  if (pending.length || !ended) {
    throw new Error("Devin stream ended before its final Connect envelope");
  }
}
