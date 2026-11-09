import type { ProviderSupport } from "cursor-byok:provider";
import {
  base64,
  ConnectError,
  connectError,
  decodeFrames,
  encodeFrame,
  SERVICE,
} from "./connect.ts";
import { devinModels, requestModelId } from "./models.ts";
import { buildRequest, ResponseDecoder } from "./request.ts";
import {
  accountData,
  isDevinQuotaError,
  mintSession,
  quotaExhaustedPatch,
  RESOURCE_TYPE,
} from "./resources.ts";

export const devinProvider: ProviderSupport = {
  id: "devin",
  displayName: "Devin",
  description:
    "Connect directly to Devin with an imported account. Model discovery and streaming run inside Cursor BYOK.",
  providerType: "devin",
  resourceType: RESOURCE_TYPE,
  models: devinModels,
  async invoke(input, output, context) {
    if (!input.resource) {
      return {
        status: "request-error",
        message: "Import a Devin account first",
      };
    }
    const data = { ...accountData(input.resource) };
    const model = requestModelId(input.model, input.request.latency);
    let emitted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { body, originalNames } = await buildRequest(
          input.request,
          model,
          data.token,
        );
        const response = await context.network.streamBytes(
          `${SERVICE}/GetChatMessage`,
          {
            method: "POST",
            headers: {
              authorization: `Basic ${data.token}-${data.token}`,
              "content-type": "application/connect+json",
              "connect-protocol-version": "1",
              "connect-accept-encoding": "identity",
              "user-agent": "",
            },
            bodyBase64: base64(encodeFrame(body)),
          },
        );
        if (response.status !== 200) {
          const chunks = [];
          let size = 0;
          for await (const chunk of response.chunks) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              throw new Error(`Devin HTTP ${response.status}`);
            }
            chunks.push(chunk);
          }
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.length;
          }
          throw connectError(
            new TextDecoder().decode(joined),
            response.status,
            [data.token, data.apiKey ?? ""],
          );
        }
        const decoder = new ResponseDecoder(
          model,
          originalNames,
          (event) => {
            emitted = true;
            output.emit(event);
          },
        );
        for await (const frame of decodeFrames(response.chunks)) {
          decoder.push(frame);
        }
        decoder.finish();
        return {
          status: "completed",
          ...(attempt ? { patch: { privateData: data } } : {}),
        };
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        for (const secret of [data.token, data.apiKey]) {
          if (secret) message = message.replaceAll(secret, "[redacted]");
        }
        if (error instanceof ConnectError && error.code === "unauthenticated") {
          if (!emitted && attempt === 0 && data.apiKey) {
            try {
              data.token = await mintSession(data.apiKey, context);
              continue;
            } catch (refreshError) {
              message = refreshError instanceof Error
                ? refreshError.message
                : "Devin credential renewal failed";
            }
          }
          return {
            status: "resource-error",
            message,
            patch: {
              state: {
                status: "invalid",
                message:
                  "Devin session expired; import fresh credentials or a renewable API key",
              },
            },
          };
        }
        if (isDevinQuotaError(error)) {
          return {
            status: "resource-error",
            message,
            patch: await quotaExhaustedPatch(data, message, context),
          };
        }
        return { status: "request-error", message };
      }
    }
    return {
      status: "request-error",
      message: "Devin credential renewal failed",
    };
  },
};
