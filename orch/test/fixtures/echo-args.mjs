// Records, as JSON, exactly what arrived after a trip through cmd.exe and a .cmd shim.
// Mirrors the real path: cmd.exe /d /s /c <shim>.cmd -> node <script> <args...>
import fs from 'node:fs';
const out = process.env.ORCH_ECHO_OUT;
if (out) fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2) }, null, 1));
