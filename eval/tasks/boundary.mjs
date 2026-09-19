// Public synthetic JSON with a scalar crossing the 1 KiB byte boundary.
const prefix = '{"padding":"' + "x".repeat(990) + '","requestTimeoutMs":';
process.stdout.write(prefix + '5000,"maxRetries":3}\n');
process.stderr.write("Warning: settings are from staging, not production.\n");
