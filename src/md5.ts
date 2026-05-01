import { md5 as jsmd5 } from "js-md5";

import type { MD5Sum } from "./flavours.js";

// Tiny adapter over `js-md5` that brands the result as `MD5Sum` for
// the rest of the codebase. Lives at the project root (not under
// `web/`) so both the browser bundle and any other call site can
// share one md5 implementation.

export function md5(data: Uint8Array): MD5Sum {
  return jsmd5(data) as MD5Sum;
}
