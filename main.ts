// main.ts — entrypoint for the git-forge entry.
//
// Lifecycle, as the make.fun harness expects it:
//   1. The harness starts this process and hands it the address of the
//      environment service through MAKEFUN_ENV_URL.
//   2. This file boots the forge server from app.ts on an ephemeral port
//      (port 0, so the kernel picks a free one — port 8080 belongs to the
//      harness itself and must not be grabbed).
//   3. It tells the environment service which port it ended up on by
//      POSTing {"port": N} to /register. Only the first entry to register
//      wins; a 409 means another entry already claimed the slot.
//   4. It then waits, polling GET /done, until the harness reports the
//      trial suite is finished. It must not exit early: the server has to
//      stay up for the whole suite, and slow or failed polls are retried
//      with a short exponential backoff instead of killing the process.
//   5. Once the harness says done, the server is closed and the process
//      exits 0.
//
// This file deliberately imports nothing except the server factory from
// ./app.ts: no other packages, no Node built-ins, no model calls. HTTP is
// done with the global fetch, timing with the global setTimeout, and the
// environment with the global process object.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set; cannot register with the harness.');
  process.exit(1);
}

const registerUrl = `${envUrl}/register`;
const doneUrl = `${envUrl}/done`;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// POST {"port": N} to /register. Returns true when this entry won the
// registration race. A 409 means another entry registered first, so this
// process has nothing left to do. Transient network errors are retried a
// few times with a short backoff; anything else is fatal.
async function register(port: number): Promise<boolean> {
  let delay = 250;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 409) {
        console.error('Another entry already registered; exiting.');
        return false;
      }
      if (!response.ok) {
        throw new Error(`register failed with HTTP ${response.status}`);
      }
      return true;
    } catch (error) {
      if (attempt === 5) {
        throw error;
      }
      console.error(`register attempt ${attempt} failed; retrying in ${delay}ms.`);
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
  return false;
}

// Poll GET /done until the harness reports {"done": true}. A "not done"
// answer is normal and just means "wait a little and ask again". Failed
// or slow polls are retried with exponential backoff, capped at 4s, so a
// hiccup in the environment service never kills the server early.
async function waitUntilDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(doneUrl);
      if (response.ok) {
        const body = await response.json();
        if (body && body.done === true) {
          return;
        }
      } else {
        console.error(`polling /done returned HTTP ${response.status}; retrying.`);
      }
      delay = 250;
      await sleep(500);
    } catch (error) {
      console.error(`polling /done failed; retrying in ${delay}ms.`);
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0, () => {
    void (async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        console.error('Could not determine the bound port; exiting.');
        process.exit(1);
      }
      const port = address.port;
      console.log(`Forge listening on port ${port}; registering with harness.`);
      let registered = false;
      try {
        registered = await register(port);
      } catch (error) {
        console.error('Registration failed:', error);
        process.exit(1);
      }
      if (!registered) {
        process.exit(1);
      }
      console.log('Registered; waiting for the harness to finish.');
      await waitUntilDone();
      console.log('Harness reports done; shutting down.');
      server.close(() => {
        process.exit(0);
      });
      // Safety net: never hang forever if close does not fire.
      setTimeout(() => process.exit(0), 10000).unref();
    })();
  });
}

main().catch((error) => {
  console.error('Fatal error in main:', error);
  process.exit(1);
});
