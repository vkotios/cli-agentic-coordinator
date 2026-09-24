// Test-only preload (`node --import <this file> ...`): pretend to be another platform so the
// Windows-only guard can be exercised on Windows. $ORCH_FAKE_PLATFORM, default linux.
Object.defineProperty(process, 'platform', { value: process.env.ORCH_FAKE_PLATFORM || 'linux', configurable: true });
