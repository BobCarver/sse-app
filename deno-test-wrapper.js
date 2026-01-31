// Simple wrapper to run Deno tests
const scriptPath = process.argv[2] || 'test/e2e';
console.log('Running Deno tests from:', scriptPath);
// This file just needs to exist for the debugger to attach
// The actual Deno process will be started separately
setInterval(() => {}, 1000);
