// The clock that lifecycle modules take in their context. Tests inject a fake with the same shape.

export const realClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
