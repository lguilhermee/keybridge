import { __descriptor, __getRegisteredProvider } from "cursor-byok:provider";

if (Deno.args.length !== 1) throw new Error("provider entry URL is required");
await import(Deno.args[0]);
console.log("CURSOR_BYOK_PROVIDER_DEFINITION:" + JSON.stringify(__descriptor(__getRegisteredProvider())));
