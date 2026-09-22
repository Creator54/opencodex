import type { AdapterFetchContext, AdapterRequest, ProviderAdapter } from "./base";
import type {
  AdapterEvent,
  OcxParsedRequest,
  OcxMessage,
  OcxTool,
  OcxContentPart,
  OcxProviderConfig,
} from "../types";
import { decodeEventStream } from "../lib/eventstream-decoder";

// --- SigV4 Helpers ---
async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyData = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return new Uint8Array(signature);
}

async function sha256(data: string | Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const buffer = await crypto.subtle.digest("SHA-256", (typeof data === "string" ? enc.encode(data) : data) as BufferSource);
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function getDateStamp(date: Date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

async function signV4(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string
) {
  const service = "bedrock";
  const now = new Date();
  const amzDate = getAmzDate(now);
  const dateStamp = getDateStamp(now);

  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname;

  headers["host"] = host;
  headers["x-amz-date"] = amzDate;
  if (sessionToken) {
    headers["x-amz-security-token"] = sessionToken;
  }

  const sortedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => {
    const originalKey = Object.keys(headers).find(K => K.toLowerCase() === k) as string;
    return `${k}:${headers[originalKey].trim()}`;
  }).join("\n") + "\n";
  const signedHeaders = sortedHeaderKeys.join(";");

  const payloadHash = await sha256(body);
  const canonicalRequest = [
    method,
    path,
    "", // No query strings used for this endpoint
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest)
  ].join("\n");

  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signatureBytes = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  headers["Authorization"] = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// --- Adapter Implementation ---

function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);

  const cleaned = { ...schema };

  if (cleaned.anyOf) {
    const valid = cleaned.anyOf.filter((x: any) => x && x.type && x.type !== "null");
    if (valid.length > 0) Object.assign(cleaned, sanitizeSchema(valid[0]));
    delete cleaned.anyOf;
  }
  if (cleaned.allOf) {
    const valid = cleaned.allOf.filter((x: any) => x && x.type && x.type !== "null");
    if (valid.length > 0) Object.assign(cleaned, sanitizeSchema(valid[0]));
    delete cleaned.allOf;
  }
  if (cleaned.oneOf) {
    const valid = cleaned.oneOf.filter((x: any) => x && x.type && x.type !== "null");
    if (valid.length > 0) Object.assign(cleaned, sanitizeSchema(valid[0]));
    delete cleaned.oneOf;
  }

  if (cleaned.properties || cleaned.additionalProperties) {
    if (!cleaned.type) cleaned.type = "object";
  }

  if (cleaned.type === "array") {
    if (!cleaned.items) {
      cleaned.items = { type: "string" };
    } else {
      cleaned.items = sanitizeSchema(cleaned.items);
      if (!cleaned.items.type && cleaned.items.properties) {
        cleaned.items.type = "object";
      } else if (!cleaned.items.type) {
        cleaned.items.type = "string";
      }
    }
  } else if (cleaned.type === "object" || cleaned.properties) {
    if (cleaned.properties) {
      for (const k of Object.keys(cleaned.properties)) {
        cleaned.properties[k] = sanitizeSchema(cleaned.properties[k]);
      }
    }
    if (cleaned.additionalProperties && typeof cleaned.additionalProperties === "object") {
      cleaned.additionalProperties = sanitizeSchema(cleaned.additionalProperties);
    }
  }

  return cleaned;
}

export function createBedrockAdapter(provider: OcxProviderConfig & { region?: string }): ProviderAdapter {
  return {
    name: "bedrock",
    async buildRequest(parsed: OcxParsedRequest, incoming: any): Promise<AdapterRequest> {
      const region = provider.region || "us-east-1";
      const modelId = parsed.modelId;
      
      const system = parsed.context.systemPrompt?.map((text) => ({ text })) || [];
      const messages: any[] = [];
      
      let bedrockToolChoice = undefined;
      const toolChoice = (parsed.context as any).toolChoice;
      if (toolChoice === "auto") {
        bedrockToolChoice = { auto: {} };
      } else if (toolChoice === "any") {
        bedrockToolChoice = { any: {} };
      } else if (toolChoice?.type === "tool" && toolChoice.name) {
        bedrockToolChoice = { tool: { name: toolChoice.name } };
      }

      const toolConfig: any = parsed.context.tools?.length ? {
        tools: parsed.context.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description || "",
            inputSchema: { json: sanitizeSchema(t.parameters) },
          }
        })),
        ...(bedrockToolChoice ? { toolChoice: bedrockToolChoice } : {})
      } : undefined;

      for (let i = 0; i < parsed.context.messages.length; i++) {
        const m = parsed.context.messages[i];
        if (m.role === "user") {
          const content = typeof m.content === "string" 
            ? [{ text: m.content }]
            : m.content.map(mapContentPart);
          messages.push({ role: "user", content });
        } else if (m.role === "assistant") {
          const content: any[] = [];
          for (const c of m.content) {
            if (c.type === "text") content.push({ text: c.text });
            else if (c.type === "toolCall") content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } });
          }
          if (content.length > 0) messages.push({ role: "assistant", content });
        } else if (m.role === "toolResult") {
          const toolResults: any[] = [];
          
          let j = i;
          while (j < parsed.context.messages.length && parsed.context.messages[j].role === "toolResult") {
            const nextMsg = parsed.context.messages[j] as any;
            const content = typeof nextMsg.content === "string" 
              ? [{ text: nextMsg.content }]
              : nextMsg.content.map(mapContentPart);
              
            toolResults.push({
              toolResult: {
                toolUseId: nextMsg.toolCallId,
                content: content,
                status: nextMsg.isError ? "error" : "success"
              }
            });
            j++;
          }
          i = j - 1;
          messages.push({ role: "user", content: toolResults });
        }
      }

      const body = JSON.stringify({
        system: system.length > 0 ? system : undefined,
        messages,
        toolConfig
      });

      const apiKey = provider.apiKey?.startsWith("$") ? process.env[provider.apiKey.slice(1)] || "" : provider.apiKey || "";
      
      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/converse-stream`;
      const method = "POST";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (!apiKey.includes(":")) {
        // Bearer token fallback for Pi harness compatibility
        headers["Authorization"] = `Bearer ${apiKey}`;
        return {
          url,
          method,
          headers,
          body
        };
      }

      const [accessKeyId, secretAccessKey, sessionToken] = apiKey.split(":");
      const signedHeaders = await signV4(
        url,
        method,
        headers,
        body,
        region,
        accessKeyId || "",
        secretAccessKey || "",
        sessionToken
      );

      return {
        url,
        method,
        headers: signedHeaders,
        body
      };
    },

    async *parseStream(response: Response, budget: any): AsyncGenerator<AdapterEvent> {
      let inToolCall = false;
      let usage: any = undefined;

      for await (const msg of decodeEventStream(response.body as any)) {
        const eventType = msg.headers[":event-type"];
        if (!eventType) continue;
        
        const payload = JSON.parse(new TextDecoder().decode(msg.payload));

        if (eventType === "contentBlockStart") {
          const start = payload.start;
          if (start?.toolUse) {
            inToolCall = true;
            yield { 
              type: "tool_call_start", 
              id: start.toolUse.toolUseId, 
              name: start.toolUse.name 
            };
          }
        } else if (eventType === "contentBlockDelta") {
          const delta = payload.delta;
          if (delta?.text) {
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.toolUse?.input) {
            yield { type: "tool_call_delta", arguments: delta.toolUse.input };
          }
        } else if (eventType === "contentBlockStop") {
            if (inToolCall) {
                yield { type: "tool_call_end" };
                inToolCall = false;
            }
        } else if (eventType === "metadata") {
            if (payload.usage) {
                usage = {
                    inputTokens: payload.usage.inputTokens,
                    outputTokens: payload.usage.outputTokens,
                    totalTokens: payload.usage.totalTokens
                };
            }
        } else if (eventType === "messageStop") {
          const stopReason = payload.stopReason;
          yield { 
            type: "done", 
            stopReason: mapStopReason(stopReason),
            ...(usage ? { usage } : {})
          };
        }
      }
    }
  };
}

function mapContentPart(c: OcxContentPart): any {
  if (c.type === "text") return { text: c.text };
  if (c.type === "image") {
      const match = c.imageUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        let format = match[1].split("/")[1];
        if (format === "jpg") format = "jpeg";
        return { 
            image: { 
                format, 
                source: { bytes: Buffer.from(match[2], "base64") } 
            } 
        };
      }
      return { text: "[Image skipped]" };
  }
  return { text: "" };
}

function mapStopReason(reason: string): "stop" | "length" | "toolUse" | undefined {
    switch(reason) {
        case "end_turn":
        case "stop_sequence":
            return "stop";
        case "max_tokens":
            return "length";
        case "tool_use":
            return "toolUse";
        default:
            return undefined;
    }
}
